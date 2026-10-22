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

function boot({ storage = new Map(), observe = false, hidden = false } = {}) {
  let bundle, cursor = 0, tree, dirty = true
  const cells = [], observers = [], listeners = new Map()
  const cleanups = []
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
    useMemo: (fn) => fn(),
    useCallback: fn => fn,
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
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
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

  return { api, test: api.__test, draw, document, window, observers, listeners, storage, cleanups }
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

console.log(`\n${checks} checks passed`)
