/**
 * Headless render harness for the provider-hub client bundle.
 *
 * Loads client.js with a stub React/ModuleLoader, renders Tank and Shell, and
 * asserts the effects switch / page-sleep / aquarium-pause wiring. No browser,
 * no build step — the bundle is plain hand-written ModuleLoader code.
 *
 * The hook model is deliberately minimal but honest about the two things these
 * components rely on: dependency arrays (an effect re-runs only when a dep
 * changes) and re-rendering after a state update lands inside an effect.
 */
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.props = {}; this.className = '' }
  appendChild(child) { this.children.push(child); return child }
  addEventListener() {}
  removeEventListener() {}
  get firstElementChild() { return this.children[0] }
}

function boot({ storage = new Map(), observe = false, hidden = false, fetch: fetchImpl } = {}) {
  let bundle, cursor = 0, tree, dirty = true
  const cells = [], observers = [], listeners = new Map()
  const cleanups = []
  const requests = []
  const html = new Node('html'), head = html.appendChild(new Node('head')), body = html.appendChild(new Node('body'))

  const document = {
    baseURI: 'http://localhost/',
    hidden,
    createElement: tag => new Node(tag),
    createTextNode: text => ({ text }),
    head, body, documentElement: html,
    addEventListener: (type, fn) => { listeners.set(type, fn) },
    removeEventListener: (type) => { listeners.delete(type) },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  }

  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: key => { storage.delete(key) },
  }

  const window = {
    document, localStorage,
    addEventListener: (type, fn) => { listeners.set(type, fn) },
    removeEventListener: (type) => { listeners.delete(type) },
    matchMedia: () => ({ matches: false }),
    location: { href: 'http://localhost/' },
    __ModuleLoader__: { load: definition => { bundle = definition } },
  }

  const depsEqual = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children },
    }),
    Fragment: 'Fragment',
    useState: initial => {
      const index = cursor++
      if (cells[index] === undefined) cells[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      const cell = cells[index]
      return [cell.value, next => {
        const value = typeof next === 'function' ? next(cell.value) : next
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true }
      }]
    },
    useEffect: (fn, deps) => {
      const index = cursor++
      if (cells[index] === undefined) cells[index] = { kind: 'effect' }
      const cell = cells[index]
      if (cell.deps === undefined || !depsEqual(cell.deps, deps)) {
        cell.deps = deps === undefined ? undefined : [...deps]
        cell.pending = fn
        // React runs the previous cleanup before re-running an effect whose deps
        // changed; skipping that would hide a leaked observer/subscription.
        cell.needsCleanup = typeof cell.cleanup === 'function'
      }
    },
    // useCallback/useMemo must honour their dependency array: a fresh function
    // identity every render makes any `useEffect(..., [callback])` re-run
    // forever, which the fixpoint loop below would spin on.
    useMemo: (fn, deps) => {
      const index = cursor++
      const cell = cells[index] ?? (cells[index] = { kind: 'memo' })
      if (cell.deps === undefined || !depsEqual(cell.deps, deps)) {
        cell.deps = deps === undefined ? undefined : [...deps]
        cell.value = fn()
      }
      return cell.value
    },
    useCallback: (fn, deps) => {
      const index = cursor++
      const cell = cells[index] ?? (cells[index] = { kind: 'callback' })
      if (cell.deps === undefined || !depsEqual(cell.deps, deps)) {
        cell.deps = deps === undefined ? undefined : [...deps]
        cell.value = fn
      }
      return cell.value
    },
    useRef: initial => {
      const index = cursor++
      if (cells[index] === undefined) cells[index] = { current: initial }
      return cells[index]
    },
  }

  vm.runInNewContext(SOURCE, {
    window, document, URL, AbortController, console, React: react,
    IntersectionObserver: observe ? class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe(node) { this.node = node }
      disconnect() { this.disconnected = true }
    } : undefined,
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options) } },
    setTimeout: (fn, delay) => ({ fn, delay }),
    clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    fetch: (url, options) => {
      requests.push({ url: String(url), options })
      // The panel talks to the host over the plugin's own api() helper, which
      // wants a Response-shaped object (ok/status/text/headers). Answer from the
      // caller-supplied table so each test can stage a payload or a failure.
      const answer = fetchImpl === undefined ? {} : fetchImpl(String(url), options)
      return Promise.resolve({
        ok: answer.ok !== false,
        status: answer.status ?? 200,
        headers: { get: name => answer.headers?.[String(name).toLowerCase()] ?? null },
        text: () => Promise.resolve(answer.body === undefined ? '{}' : JSON.stringify(answer.body)),
      })
    },
  }, { filename: 'client.js' })

  const module = { exports: {} }
  const require = name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node, render: () => {}, unmountComponentAtNode: () => {} }
    throw new Error(`unexpected require: ${name}`)
  }
  const api = bundle.factory(require) ?? module.exports

  // Render to a fixpoint: effects may set state, and a real renderer re-renders
  // until nothing is dirty. Cap the loop so a runaway hook chain fails loudly.
  const draw = (component, props) => {
    cursor = 0; dirty = false
    for (let pass = 0; pass < 20; pass += 1) {
      cursor = 0
      tree = component(props)
      // Refs attach after the node is created; an effect that observes one runs
      // in the same commit, so populate it before running effects.
      if (tree?.props?.ref && !tree.props.ref.current) tree.props.ref.current = new Node()
      let ranEffect = false
      for (let index = 0; index < cells.length; index += 1) {
        const cell = cells[index]
        if (cell?.kind !== 'effect' || cell.pending === undefined) continue
        // Run the old cleanup first, exactly like a deps change in React.
        if (cell.needsCleanup) { cell.cleanup(); cell.needsCleanup = false }
        const fn = cell.pending
        cell.pending = undefined
        const cleanup = fn()
        if (typeof cleanup === 'function') cell.cleanup = cleanup
        ranEffect = true
      }
      if (!dirty && !ranEffect) break
      dirty = false
    }
    return tree
  }

  return { api, test: api.__test, draw, document, window, observers, listeners, storage, cleanups, requests }
}

/** Let every pending promise (the panel's api() round trip) land, then redraw. */
const settle = async () => {
  for (let pass = 0; pass < 8; pass += 1) await Promise.resolve()
}

let checks = 0
const check = async (name, fn) => {
  try { await fn(); checks += 1; console.log(`  ok  ${name}`) }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1 }
}

const T = key => key
const shellProps = () => ({
  t: T,
  data: { catalog: [], settings: {} },
  counts: { available: 0 },
  summary: { reload() {} },
  stats: { reload() {} },
  eacAuth: null, setEacAuth() {}, eacLogin() {},
  busy: '', setBusy() {}, apply() {}, bench() {}, benches: {}, ctx: {},
})
const byClass = (tree, name) => tree.props.children.find(child => child?.props?.className === name)

await check('Tank pauses when empty, resumes when filled and visible', () => {
  const app = boot({ observe: true })
  let tree = app.draw(app.test.Tank, { pct: 60 })
  assert.equal(tree.props['data-ofm-motion'], 'on')
  assert.equal(app.observers.length, 1, 'one observer per filled tank')

  app.observers[0].callback([{ isIntersecting: false }])
  tree = app.draw(app.test.Tank, { pct: 60 })
  assert.equal(tree.props['data-ofm-motion'], 'off', 'offscreen tank pauses')

  app.observers[0].callback([{ isIntersecting: true }])
  tree = app.draw(app.test.Tank, { pct: 60 })
  assert.equal(tree.props['data-ofm-motion'], 'on', 'back in view resumes')

  tree = app.draw(app.test.Tank, { pct: 0 })
  assert.equal(tree.props['data-ofm-motion'], 'off', 'empty tank pauses')
  assert.equal(app.observers[0].disconnected, true, 'observer torn down when unfilled')
})

await check('Tank without IntersectionObserver stays animated', () => {
  const app = boot()
  const tree = app.draw(app.test.Tank, { pct: 42 })
  assert.equal(tree.props['data-ofm-motion'], 'on')
})

await check('Shell defaults effects off, writes localStorage on toggle', () => {
  const app = boot({ observe: true })
  let tree = app.draw(app.test.Shell, shellProps())
  assert.equal(tree.props['data-ofm-effects'], 'off', 'decorations are opt-in')
  assert.equal(app.storage.get('ofm.visualEffects'), undefined)

  const tools = byClass(byClass(tree, 'ofm_nav'), 'ofm_navtools')
  assert.ok(tools, 'navtools not found')
  const toggle = tools.props.children[0]
  assert.equal(toggle.props.checked, false)

  toggle.props.onChange()
  tree = app.draw(app.test.Shell, shellProps())
  assert.equal(app.storage.get('ofm.visualEffects'), 'on')
  assert.equal(tree.props['data-ofm-effects'], 'on')
})

await check('Shell restores the effects switch from localStorage', () => {
  const app = boot({ storage: new Map([['ofm.visualEffects', 'on']]), observe: true })
  const tree = app.draw(app.test.Shell, shellProps())
  assert.equal(tree.props['data-ofm-effects'], 'on')
  assert.ok(byClass(tree, 'ofm_aurora'), 'aurora renders when effects are on')
})

await check('Shell omits the aurora layer when effects are off', () => {
  const app = boot({ observe: true })
  const tree = app.draw(app.test.Shell, shellProps())
  assert.equal(byClass(tree, 'ofm_aurora'), undefined)
})

await check('Shell pauses every animation when scrolled out of view', () => {
  const app = boot({ observe: true })
  let tree = app.draw(app.test.Shell, shellProps())
  assert.equal(tree.props['data-ofm-active'], 'true')
  assert.ok(app.observers.length >= 1, 'shell observer registered')
  app.observers[0].callback([{ isIntersecting: false }])
  tree = app.draw(app.test.Shell, shellProps())
  assert.equal(tree.props['data-ofm-active'], 'false')
  app.observers[0].callback([{ isIntersecting: true }])
  tree = app.draw(app.test.Shell, shellProps())
  assert.equal(tree.props['data-ofm-active'], 'true')
})

await check('Shell pauses when the tab is hidden and resumes on visibilitychange', () => {
  const app = boot({ observe: true, hidden: true })
  let tree = app.draw(app.test.Shell, shellProps())
  assert.equal(tree.props['data-ofm-active'], 'false', 'hidden tab pauses')

  app.document.hidden = false
  const handler = app.listeners.get('visibilitychange')
  assert.equal(typeof handler, 'function', 'visibilitychange subscribed')
  handler()
  tree = app.draw(app.test.Shell, shellProps())
  assert.equal(tree.props['data-ofm-active'], 'true')
})

await check('copy exists in both locales', () => {
  const app = boot()
  for (const locale of ['zh', 'en']) {
    assert.equal(typeof app.test.DICT[locale]['effects.enabled'], 'string', `${locale} effects.enabled`)
    assert.equal(typeof app.test.DICT[locale]['effects.hint'], 'string', `${locale} effects.hint`)
  }
})

await check('the effects-off CSS keeps the aquarium animating', () => {
  const css = boot().test.CSS
  assert.match(css, /\.ofm_root\[data-ofm-effects="off"\] :not\(\.ofm_tank\):not\(\.ofm_tank \*\)/, 'tank excluded from the effects-off kill switch')
  assert.match(css, /\.ofm_tank\[data-ofm-motion="off"\] \*\{animation-play-state:paused/, 'tank pause rule')
  assert.match(css, /\.ofm_root\[data-ofm-active="false"\] \*/, 'page sleep rule')
  assert.doesNotMatch(css, /ofm_navspacer/, 'dead spacer rule removed')
})

// ── upstream OFM tracker panel ──────────────────────────────────────────────
// The panel's whole value is telling "the upstream moved" apart from "the check
// failed". Those two states look identical if the error path ever clears the
// last good result, and nobody would notice until they acted on stale versions.

const upstreamStatus = (over = {}) => ({
  repo: 'Ebony-Vinyl/dsh-our-free-model',
  baseline: 'v2.5.8',
  checking: false,
  lastAttempt: 1,
  lastError: '',
  latestTag: 'v2.5.9',
  behind: ['v2.5.9'],
  updated: true,
  unreleased: { aheadBy: 2, commits: [{ sha: 'f097330', message: 'fix(界面)：视觉特效开关' }, { sha: 'f0e9053', message: 'fix(鱼缸)：暂停空缸' }] },
  counts: { mergeable: 87, keepOurs: 3, removed: 11, skipped: 57 },
  files: {
    mergeable: [{ file: 'client.js', status: 'modified', additions: 74, deletions: 13 }],
    keepOurs: [{ file: 'package.json', status: 'modified', additions: 1, deletions: 1 }],
    removed: [{ file: 'vendor/channel-pack/src/buddy.ts', status: 'removed', additions: 0, deletions: 931 }],
    skipped: [],
  },
  checkedAt: Date.now() - 120_000,
  ...over,
})

const textOf = node => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props?.children)
}

await check('UpstreamPanel reads the cached status instead of hitting GitHub', async () => {
  const app = boot({ fetch: () => ({ body: upstreamStatus() }) })
  app.draw(app.test.UpstreamPanel, { t: T })
  await settle()
  const tree = app.draw(app.test.UpstreamPanel, { t: T })
  const text = textOf(tree)
  assert.equal(app.requests.length, 1, 'exactly one GET on mount')
  assert.match(app.requests[0].url, /\/upstream\/status$/, 'reads the host cache')
  assert.doesNotMatch(app.requests[0].url, /api\.github\.com/, 'the browser never calls GitHub directly')
  assert.match(text, /v2\.5\.8/, 'baseline shown')
  assert.match(text, /v2\.5\.9/, 'latest upstream tag shown')
  assert.match(text, /upstream\.behind/, 'behind badge shown')
})

await check('UpstreamPanel reports in-sync without an "updated" claim', async () => {
  const app = boot({ fetch: () => ({ body: upstreamStatus({ latestTag: 'v2.5.8', behind: [], updated: false, unreleased: { aheadBy: 0, commits: [] }, counts: { mergeable: 0, keepOurs: 0, removed: 0, skipped: 0 }, files: { mergeable: [], keepOurs: [], removed: [], skipped: [] } }) }) })
  app.draw(app.test.UpstreamPanel, { t: T })
  await settle()
  const text = textOf(app.draw(app.test.UpstreamPanel, { t: T }))
  assert.match(text, /upstream\.synced/, 'in-sync badge')
  assert.match(text, /upstream\.noUpdate/, 'explicit "nothing new" line')
  assert.doesNotMatch(text, /upstream\.behind/, 'no behind badge')
})

await check('UpstreamPanel keeps the last good result when a check fails', async () => {
  // This locale keeps the {message} slot visible so the assertion can see what
  // the panel actually interpolated; an identity t() would swallow it and the
  // test would pass even if the real reason were dropped.
  const t = key => `${key} {message}`
  let fail = false
  const app = boot({
    fetch: url => (fail
      ? { ok: false, status: 502, body: { error: 'getaddrinfo ENOTFOUND api.github.com' } }
      : { body: upstreamStatus() }),
  })
  app.draw(app.test.UpstreamPanel, { t })
  await settle()
  let tree = app.draw(app.test.UpstreamPanel, { t })
  const button = byClass(tree, 'ofm_row').props.children[0]
  fail = true
  await button.props.onClick()
  await settle()
  tree = app.draw(app.test.UpstreamPanel, { t })
  const text = textOf(tree)
  // The version verdict survives — showing "v2.5.8 / nothing new" here would be
  // a lie that reads exactly like a healthy check.
  assert.match(text, /v2\.5\.9/, 'previous verdict kept')
  assert.match(text, /upstream\.failed/, 'failure surfaced')
  assert.match(text, /ENOTFOUND/, 'the real reason is shown')
  assert.match(text, /upstream\.stale/, 'and it is labelled as stale')
})

await check('UpstreamPanel survives a host that has never checked', async () => {
  const app = boot({ fetch: () => ({ body: upstreamStatus({ latestTag: '', behind: [], updated: false, unreleased: { aheadBy: 0, commits: [] }, checkedAt: 0, counts: { mergeable: 0, keepOurs: 0, removed: 0, skipped: 0 }, files: { mergeable: [], keepOurs: [], removed: [], skipped: [] } }) }) })
  app.draw(app.test.UpstreamPanel, { t: T })
  await settle()
  const text = textOf(app.draw(app.test.UpstreamPanel, { t: T }))
  assert.match(text, /upstream\.never/, 'never-checked label instead of a fake timestamp')
  assert.doesNotMatch(text, /NaN|undefined/, 'no NaN/undefined leaks into the copy')
})

await check('UpstreamPanel hides the file list until asked', async () => {
  const app = boot({ fetch: () => ({ body: upstreamStatus() }) })
  app.draw(app.test.UpstreamPanel, { t: T })
  await settle()
  let tree = app.draw(app.test.UpstreamPanel, { t: T })
  assert.doesNotMatch(textOf(tree), /client\.js/, 'collapsed by default')
  const toggle = byClass(tree, 'ofm_row').props.children.find(child => child?.props?.onClick && child.props.className === undefined && child.props.disabled === undefined)
  toggle.props.onClick()
  tree = app.draw(app.test.UpstreamPanel, { t: T })
  const text = textOf(tree)
  assert.match(text, /client\.js/, 'file list expands')
  assert.match(text, /74 \+/, 'per-file churn shown')
})

await check('UpstreamPanel lists what upstream deleted separately from work to merge', async () => {
  // 上游 2.5.9 删掉了 11 个渠道文件（-5905 行）。它们不能被算进「要合并」——
  // 合并脚本对这类文件一律 keep-local。数字虚高会让整件事看起来比实际重得多。
  // 这里要看到真实的数字，所以 t() 保留 {n} 占位符（T 会把它整段吞掉）。
  const t = key => `${key} {n}`
  const app = boot({ fetch: () => ({ body: upstreamStatus() }) })
  app.draw(app.test.UpstreamPanel, { t })
  await settle()
  let tree = app.draw(app.test.UpstreamPanel, { t })
  const row = byClass(tree, 'ofm_row')
  assert.doesNotMatch(textOf(row), /98/, 'the removed files are not folded into the merge count')
  assert.match(textOf(row), /upstream\.mergeable 87/, '87 files really are mergeable')
  assert.match(textOf(row), /upstream\.removed 11/, 'and the 11 deletions are their own badge')
  const toggle = row.props.children.find(child => child?.props?.onClick && child.props.className === undefined && child.props.disabled === undefined)
  toggle.props.onClick()
  tree = app.draw(app.test.UpstreamPanel, { t })
  const text = textOf(tree)
  assert.match(text, /upstream\.removed/, 'a dedicated section for deleted-by-upstream files')
  assert.match(text, /buddy\.ts/, 'the deleted file is named')
  assert.match(text, /-931/, 'and its line count')
})

await check('upstream copy exists in both locales', () => {
  const app = boot()
  for (const locale of ['zh', 'en']) {
    for (const key of ['upstream.title', 'upstream.hint', 'upstream.baseline', 'upstream.latest', 'upstream.synced', 'upstream.behind', 'upstream.unreleased', 'upstream.never', 'upstream.check', 'upstream.checking', 'upstream.mergeable', 'upstream.keepOurs', 'upstream.removed', 'upstream.removedHint', 'upstream.skipped', 'upstream.files', 'upstream.showFiles', 'upstream.hideFiles', 'upstream.failed', 'upstream.stale', 'upstream.noUpdate']) {
      assert.equal(typeof app.test.DICT[locale][key], 'string', `${locale} ${key}`)
    }
  }
})

console.log(`\n${checks} checks passed`)
