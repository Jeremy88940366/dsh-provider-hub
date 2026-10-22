/**
 * Tests for src/upstream-track.js — the upstream OFM version tracker.
 *
 * The grouping in summarizeUpstream() is what the panel and the CLI both print,
 * so an error there reads as a confident wrong number ("98 files to merge")
 * rather than a crash. That is why the pure function is tested against the
 * shapes GitHub actually returns, and why the tracker is tested against a
 * stubbed fetch rather than the network: the interesting behaviour is what it
 * does when a check *fails*, which a live call can't reproduce on demand.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SKIP_PATHS,
  KEEP_OURS,
  compareUpstreamTags,
  validUpstreamTag,
  isSkipped,
  isKept,
  readBaseline,
  summarizeUpstream,
  UpstreamTracker,
} from '../src/upstream-track.js'

let checks = 0
const check = async (name, fn) => {
  try {
    await fn()
    checks += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`)
    process.exitCode = 1
  }
}

// ── tag handling ────────────────────────────────────────────────────────────

await check('only bare vX.Y.Z tags count as versions', () => {
  assert.equal(validUpstreamTag('v2.5.9'), true)
  assert.equal(validUpstreamTag('v2.5.9-macos-unofficial'), false, 'the mac build is not a version')
  assert.equal(validUpstreamTag('2.5.9'), false)
  assert.equal(validUpstreamTag('v2.5'), false)
  assert.equal(validUpstreamTag(undefined), false)
})

await check('tags sort numerically, not lexically', () => {
  const sorted = ['v2.5.10', 'v2.5.9', 'v2.10.0', 'v2.5.2'].sort(compareUpstreamTags)
  assert.deepEqual(sorted, ['v2.5.2', 'v2.5.9', 'v2.5.10', 'v2.10.0'], 'v2.5.10 must not sort before v2.5.9')
})

// ── path policy ─────────────────────────────────────────────────────────────

await check('skip rules cover both prefixes and exact files', () => {
  assert.equal(isSkipped('scripts/ship.mjs'), true, 'directory prefix')
  assert.equal(isSkipped('docs/plans/x.md'), true)
  assert.equal(isSkipped('README_EN.md'), true, 'exact file')
  assert.equal(isSkipped('README.md'), false, 'README.md is kept, not skipped')
  assert.equal(isSkipped('client.js'), false)
  assert.equal(isKept('package.json'), true)
  assert.equal(isKept('client.js'), false)
})

await check('the path policy lists are the ones the sync script uses', () => {
  // These two files must agree; if SKIP_PATHS drifts, the panel advertises
  // files the merge would silently ignore.
  const source = fs.readFileSync(new URL('./sync-upstream.mjs', import.meta.url), 'utf8')
  for (const entry of SKIP_PATHS) {
    assert.ok(source.includes(`'${entry}'`), `sync-upstream.mjs is missing ${entry}`)
  }
  for (const entry of KEEP_OURS) {
    assert.ok(source.includes(`'${entry}'`), `sync-upstream.mjs is missing ${entry}`)
  }
})

// ── summarizeUpstream ───────────────────────────────────────────────────────

const tagsFixture = ['v2.5.6', 'v2.5.7', 'v2.5.8', 'v2.5.9', 'v2.5.9-macos-unofficial']

await check('summarizeUpstream splits files into merge/keep/skip', () => {
  const summary = summarizeUpstream({
    baseline: 'v2.5.8',
    tags: tagsFixture,
    compareMain: { ahead_by: 2, commits: [{ sha: 'f0973303abcdef', commit: { message: 'fix(界面)：特效开关\n\nbody text' } }] },
    compareRange: {
      files: [
        { filename: 'client.js', status: 'modified', additions: 74, deletions: 13 },
        { filename: 'package.json', status: 'modified', additions: 1, deletions: 1 },
        { filename: 'scripts/ship.mjs', status: 'added', additions: 5, deletions: 0 },
        { filename: 'docs/plans/x.md', status: 'added', additions: 9, deletions: 0 },
      ],
    },
  })
  assert.equal(summary.latestTag, 'v2.5.9', 'the unofficial mac build is ignored')
  assert.deepEqual(summary.behind, ['v2.5.9'])
  assert.equal(summary.updated, true)
  assert.deepEqual(summary.counts, { mergeable: 1, keepOurs: 1, skipped: 2 })
  assert.deepEqual(summary.files.mergeable.map(file => file.file), ['client.js'])
  assert.deepEqual(summary.files.keepOurs.map(file => file.file), ['package.json'])
  assert.deepEqual(summary.unreleased.commits, [{ sha: 'f097330', message: 'fix(界面)：特效开关' }], 'sha shortened, message first line only')
})

await check('summarizeUpstream counts unreleased main commits as an update', () => {
  const summary = summarizeUpstream({
    baseline: 'v2.5.9',
    tags: tagsFixture,
    compareMain: { ahead_by: 12, commits: [] },
  })
  assert.deepEqual(summary.behind, [], 'no new tag')
  assert.equal(summary.updated, true, 'but main has moved')
  assert.equal(summary.counts.mergeable, 0, 'no range compare was requested, so nothing to merge')
})

await check('summarizeUpstream reports nothing when fully in sync', () => {
  const summary = summarizeUpstream({ baseline: 'v2.5.9', tags: tagsFixture, compareMain: { ahead_by: 0, commits: [] } })
  assert.equal(summary.updated, false)
  assert.equal(summary.latestTag, 'v2.5.9')
})

await check('summarizeUpstream tolerates an empty or missing tag list', () => {
  for (const tags of [[], undefined, ['v2.5.9-macos-unofficial']]) {
    const summary = summarizeUpstream({ baseline: 'v2.5.8', tags })
    assert.equal(summary.latestTag, '', 'no usable tag')
    assert.equal(summary.updated, false)
  }
})

// ── UpstreamTracker against a stubbed GitHub ────────────────────────────────

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-track-'))

/** A fetch stub that answers the three endpoints the tracker uses. */
const githubStub = ({ tags = tagsFixture, main = { ahead_by: 0, commits: [] }, range, fail } = {}) => {
  const calls = []
  const impl = async url => {
    calls.push(url)
    if (fail !== undefined) throw fail
    const respond = body => ({ ok: true, status: 200, headers: { get: () => '59' }, json: async () => body })
    if (url.includes('/tags')) return respond(tags.map(name => ({ name })))
    if (url.includes('/compare/v2.5.9...main')) return respond(main)
    if (url.includes('/compare/')) return respond(range ?? { files: [{ filename: 'client.js', status: 'modified', additions: 1, deletions: 1 }] })
    throw new Error(`unexpected url ${url}`)
  }
  return { impl, calls }
}

await check('tracker persists a successful check and reports it back', async () => {
  const dataDir = tempDir()
  const pkgDir = tempDir()
  fs.writeFileSync(path.join(pkgDir, 'sync-base.json'), JSON.stringify({ upstreamTag: 'v2.5.8' }))
  const stub = githubStub({ main: { ahead_by: 3, commits: [] } })
  const tracker = new UpstreamTracker({ pkgDir, dataDir, fetchImpl: stub.impl })

  const status = await tracker.check()
  assert.equal(status.baseline, 'v2.5.8')
  assert.equal(status.latestTag, 'v2.5.9')
  assert.equal(status.lastError, '')
  assert.ok(status.checkedAt > 0)
  assert.equal(stub.calls.length, 3, 'tags + main compare + range compare')

  // A fresh tracker (i.e. after a restart) must see the same conclusion.
  const reopened = new UpstreamTracker({ pkgDir, dataDir, fetchImpl: stub.impl })
  assert.equal(reopened.status().latestTag, 'v2.5.9')
  assert.equal(reopened.status().unreleased.aheadBy, 3)
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(pkgDir, { recursive: true, force: true })
})

await check('tracker skips the range compare when already in sync', async () => {
  const dataDir = tempDir()
  const pkgDir = tempDir()
  fs.writeFileSync(path.join(pkgDir, 'sync-base.json'), JSON.stringify({ upstreamTag: 'v2.5.9' }))
  const stub = githubStub()
  await new UpstreamTracker({ pkgDir, dataDir, fetchImpl: stub.impl }).check()
  assert.equal(stub.calls.length, 2, 'no point spending a rate-limit slot on an empty range')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(pkgDir, { recursive: true, force: true })
})

await check('a failed check keeps the last good result and records the error', async () => {
  const dataDir = tempDir()
  const pkgDir = tempDir()
  fs.writeFileSync(path.join(pkgDir, 'sync-base.json'), JSON.stringify({ upstreamTag: 'v2.5.8' }))
  const ok = githubStub()
  const tracker = new UpstreamTracker({ pkgDir, dataDir, fetchImpl: ok.impl })
  const good = await tracker.check()
  assert.equal(good.latestTag, 'v2.5.9')

  // Swap in a failing fetch — the same tracker instance, as after a network blip.
  tracker.deps.fetchImpl = githubStub({ fail: new Error('getaddrinfo ENOTFOUND api.github.com') }).impl
  await assert.rejects(() => tracker.check(), /ENOTFOUND/)

  const after = tracker.status()
  assert.equal(after.latestTag, 'v2.5.9', 'the previous verdict survives')
  assert.equal(after.checkedAt, good.checkedAt, 'the timestamp is the last SUCCESS, not the attempt')
  assert.match(after.lastError, /ENOTFOUND/, 'the reason is recorded')
  assert.ok(after.lastAttempt >= after.checkedAt, 'the attempt is tracked separately')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(pkgDir, { recursive: true, force: true })
})

await check('concurrent checks do not stack requests', async () => {
  const dataDir = tempDir()
  const pkgDir = tempDir()
  // Baseline == latest, so a check is exactly two requests (tags + main compare)
  // and the count below says something about stacking rather than about ranges.
  fs.writeFileSync(path.join(pkgDir, 'sync-base.json'), JSON.stringify({ upstreamTag: 'v2.5.9' }))
  let resolve
  const gate = new Promise(done => { resolve = done })
  let calls = 0
  const tracker = new UpstreamTracker({
    pkgDir,
    dataDir,
    fetchImpl: async url => {
      calls += 1
      await gate
      return { ok: true, status: 200, headers: { get: () => '1' }, json: async () => (url.includes('/tags') ? [{ name: 'v2.5.9' }] : { ahead_by: 0, commits: [] }) }
    },
  })
  const first = tracker.check()
  const second = tracker.check()
  assert.equal(tracker.status().checking, true)
  resolve()
  await Promise.all([first, second])
  assert.equal(calls, 2, 'the second call returned the in-flight status instead of refetching')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(pkgDir, { recursive: true, force: true })
})

await check('a corrupt state file degrades to "never checked" instead of throwing', async () => {
  const dataDir = tempDir()
  const pkgDir = tempDir()
  fs.writeFileSync(path.join(dataDir, 'upstream-state.json'), '{ not json')
  const tracker = new UpstreamTracker({ pkgDir, dataDir, fetchImpl: githubStub().impl })
  const status = tracker.status()
  assert.equal(status.checkedAt, 0)
  assert.equal(status.latestTag, '')
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(pkgDir, { recursive: true, force: true })
})

await check('readBaseline falls back when sync-base.json is absent or invalid', () => {
  const pkgDir = tempDir()
  assert.equal(readBaseline(pkgDir), 'v2.5.7', 'no file')
  fs.writeFileSync(path.join(pkgDir, 'sync-base.json'), JSON.stringify({ upstreamTag: 'v2.5.9-macos-unofficial' }))
  assert.equal(readBaseline(pkgDir), 'v2.5.7', 'a non-version tag is not a baseline')
  fs.writeFileSync(path.join(pkgDir, 'sync-base.json'), JSON.stringify({ upstreamTag: 'v2.5.8' }))
  assert.equal(readBaseline(pkgDir), 'v2.5.8')
  fs.rmSync(pkgDir, { recursive: true, force: true })
})

await check('the real sync-base.json points at a valid version', () => {
  const baseline = readBaseline(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  assert.equal(validUpstreamTag(baseline), true, `baseline ${baseline} is not a vX.Y.Z tag`)
})

console.log(`\n${checks} checks passed`)
