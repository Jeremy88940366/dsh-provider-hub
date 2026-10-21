import fs from 'node:fs'
import path from 'node:path'
import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../adapter.js'
import { buildCatalog, buildEacCatalog, buildKiloCatalog, isEacEntry, isKiloEntry, parseListing, reviveKiloCatalog } from '../catalog.js'
import { buildAggregateCatalog, isAggregateEntry } from '../aggregate.js'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from '../combos.js'
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, migrateSettings, migrateStats, recordTurn, recordUsage, trimStats, isModelHidden } from '../store.js'
import { STATE, detectEgress, probeCatalog } from '../probe.js'
import { CODE, UpstreamError, getJson } from '../http.js'
import { runModelTest, modelAvailability } from '../model-test.js'
import { DEFAULT_LEVEL } from '../effort.js'
import { fetchSealedListing } from '../eac.js'
import { fetchKiloListing } from '../kilo.js'
import { sessionForConversation } from '../upstream.js'
import { createForwardCompletion, publicModelRows } from './completion.js'

const FALLBACK_CATALOG = buildCatalog([
  'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'space-bunny-free',
  'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
])

/** 路径由产品入口决定；核心不解析 DSH_HOME，也不发现宿主服务。 */
export function createRuntimeStores({ dataDir, logger = console }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('dataDir must be an absolute path')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const open = (file, initial) => new JsonStore(path.join(dataDir, file), structuredClone(initial), {
    log: message => logger.warn?.(message),
  })
  // Seed the recommended combo only for a genuinely fresh install. Existing
  // settings files that predate combos must not gain a new advertised model
  // merely because a new default was added to SETTINGS_INITIAL; user edits to
  // an existing `combos` field still win through JsonStore's normal merge.
  const settingsInitial = structuredClone(SETTINGS_INITIAL)
  const settingsPath = path.join(dataDir, 'settings.json')
  if (fs.existsSync(settingsPath)) settingsInitial.combos = []
  const settings = new JsonStore(settingsPath, settingsInitial, {
    log: message => logger.warn?.(message),
  })
  const stats = open('stats.json', STATS_INITIAL)
  const availability = open('availability.json', { version: 1, at: 0, egress: null, results: {} })
  const catalogStore = open('catalog.json', { version: 1, at: 0, entries: FALLBACK_CATALOG.map(entry => entry.id) })
  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)
  // Drop settings that lost their reader. edit() returns undefined when there is
  // nothing to change, so an already-clean document is not rewritten every boot.
  settings.edit(migrateSettings)
  return {
    settings, stats, availability, catalogStore,
    dispose() {
      settings.dispose(); stats.dispose(); availability.dispose(); catalogStore.dispose()
    },
  }
}

/**
 * 两个产品共同使用的模型运行时。宿主仅注入能力，不传入 Cordis ctx。
 * 创建不启动网络任务；入口先绑定本地监听器，再决定何时刷新和探测。
 */
export function createModelRuntime({
  settings, stats, availability, catalogStore,
  logger = console,
  attributionUserAgent = 'provider-hub',
  resolveImage,
  sealedCredential = () => null,
  onSealedUnavailable = () => {},
  onTopology = () => {},
}) {
  let catalog = materializeCatalog(catalogStore.get().entries ?? [])
  let sealedCatalog = sealedCredential() === null ? [] : buildEacCatalog(catalogStore.get().sealIds ?? [])
  let kiloCatalog = reviveKiloCatalog(catalogStore.get().kiloRows)
  /** The aggregate lane: one row per enabled provider/model the user configured.
   *  Derived from settings, not from a listing, so it is rebuilt on every merge. */
  let aggregateCatalog = []
  /** The virtual rows a combo contributes; rebuilt last, after every real lane. */
  let comboCatalog = []
  /** The free lane's own roster: the base every other lane is merged onto. */
  let freeCatalog = catalog
  let egress = availability.get().egress ?? null
  let gatewayLatency = { ms: 0, at: 0 }
  let disposed = false
  const lifetime = new AbortController()
  let reprobeTimer

  /**
   * Rebuild the merged catalog from its parts, in precedence order.
   *
   * Rebuilt rather than appended to, because every one of these lists can shrink:
   * a provider the user switched off, a chain whose head was removed, a Kilo
   * model that went paid. Appending only ever grew the view, so a removed row
   * stayed dialable until the next full listing round happened to reset it.
   *
   * Combos come last on purpose — a chain's links have to already exist as real
   * rows, which is also what makes `buildComboCatalog` drop a link that is gone
   * instead of keeping a hopeful placeholder.
   */
  const rebuildCatalog = () => {
    const seen = new Set()
    const merged = []
    for (const entry of [...freeCatalog, ...sealedCatalog, ...kiloCatalog, ...aggregateCatalog]) {
      if (entry === null || entry === undefined || seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    const combos = normalizeCombos(settings.get().combos)
    comboCatalog = buildComboCatalog(combos, merged)
    pruneRotation(combos)
    for (const entry of comboCatalog) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    catalog = merged
  }
  const mergeCatalogs = () => {
    aggregateCatalog = buildAggregateCatalog(settings.get().aggregate ?? {})
    rebuildCatalog()
  }
  mergeCatalogs()
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
  })
  const emitTopology = () => { if (!disposed) onTopology() }
  // One trim pass shared by both writers.
  //
  // It prunes against the lanes the catalog store *knows about*, not against the
  // in-memory catalog: `sealedCatalog` empties the moment EAC is signed out and
  // `kiloCatalog` empties until the first Kilo listing lands, and either would
  // otherwise take every lifetime row those models earned with it. Only a model
  // that left the upstream roster — a retired free lane, a deleted combo — is
  // actually gone, and only that one should lose its history.
  const trim = value => trimStats(value, {
    keepDays: 120,
    liveIds: knownModelIds(),
  })
  function knownModelIds() {
    const stored = catalogStore.get()
    const ids = new Set(Array.isArray(stored.entries) ? stored.entries : [])
    for (const id of Array.isArray(stored.sealIds) ? stored.sealIds : []) ids.add(id)
    for (const row of Array.isArray(stored.kiloRows) ? stored.kiloRows : []) {
      if (row !== null && typeof row === 'object' && typeof row.id === 'string') ids.add(row.id)
    }
    for (const entry of catalog) ids.add(entry.id)
    for (const combo of normalizeCombos(settings.get().combos)) {
      for (const id of Array.isArray(combo.models) ? combo.models : []) ids.add(id)
    }
    return ids
  }
  // Trim once at boot, not only on the next write. Rows left behind by a lane
  // that left the roster would otherwise sit in `/stats` until the user happens
  // to make a call — and a user reading the stats page to find out why is
  // exactly the one who never makes that call. `trimStats` returns the same
  // object when there is nothing to drop, so a clean store is not rewritten.
  stats.edit(value => trim(value))
  const adapter = new FreeModelAdapter({
    state,
    resolveImage,
    sealedCredential,
    recordUsage: record => {
      if (disposed) return
      recordUsage(stats, record, trim)
    },
    recordTurn: record => { if (!disposed) recordTurn(stats, record, trim) },
    warn: message => logger.warn?.(message) ?? logger.log?.(message),
    onRegionBlocked: id => {
      if (disposed || reprobeTimer !== undefined) return
      reprobeTimer = setTimeout(() => {
        reprobeTimer = undefined
        // Only the model the user just tried. This used to force a whole round,
        // which re-pinged every model including the ones already serving
        // "Rate limit exceeded" — spending the free lane's quota to re-learn
        // verdicts that were seconds old.
        if (!disposed) void refreshAvailability(false, typeof id === 'string' ? [id] : undefined).catch(error => {
          logger.warn?.(`provider-hub: region reprobe failed (${error?.message ?? error})`)
        })
      }, 4000)
      reprobeTimer.unref?.()
    },
  })

  // 手动强制刷新不能借用一个因限流而跳过探测的普通刷新。
  let catalogRefresh = null
  let catalogRefreshForced = false
  let catalogRefreshProbed = false
  async function refreshCatalog(opts) {
    const { probe = true, force = false } = opts ?? {}
    if (disposed) return catalog
    while (catalogRefresh !== null) {
      const shared = catalogRefresh
      const sharedForced = catalogRefreshForced
      const sharedProbed = catalogRefreshProbed
      const value = await shared
      if (disposed || ((!force || sharedForced) && (!probe || sharedProbed))) return value
    }
    const run = refreshCatalogOnce({ probe, force })
    catalogRefresh = run
    catalogRefreshForced = force
    catalogRefreshProbed = probe
    try { return await run } finally {
      if (catalogRefresh === run) {
        catalogRefresh = null; catalogRefreshForced = false; catalogRefreshProbed = false
      }
    }
  }

  async function refreshCatalogOnce({ probe, force }) {
    let ids = []
    try {
      ids = parseListing(await fetchListing())
    } catch (error) {
      if (!disposed) logger.warn?.(`provider-hub: model listing refresh failed (${error?.message ?? error}); keeping the cached catalog`)
    }
    if (disposed) return catalog
    if (ids.length > 0) {
      freeCatalog = buildCatalog(ids)
      catalogStore.update({ at: Date.now(), entries: freeCatalog.map(entry => entry.id) })
      catalogStore.flush()
      settings.update({ catalogSyncedAt: Date.now() })
    } else {
      freeCatalog = materializeCatalog(catalogStore.get().entries ?? [])
    }
    await refreshSealedRoster()
    if (disposed) return catalog
    await refreshKiloRoster()
    if (disposed) return catalog
    mergeCatalogs()
    if (probe) await refreshAvailability(force)
    emitTopology()
    return catalog
  }

  async function refreshSealedRoster() {
    const credential = sealedCredential()
    if (credential === null) {
      sealedCatalog = []
      onSealedUnavailable()
      return
    }
    try {
      const ids = parseListing(await fetchSealedListing(credential, { signal: lifetime.signal }))
      if (disposed) return
      // 独立应用授权变更时，旧账号正在返回的清单不得覆盖新状态。
      if (Object.hasOwn(credential, 'userToken') && sealedCredential()?.userToken !== credential.userToken) return
      if (ids.length > 0) {
        sealedCatalog = buildEacCatalog(ids)
        catalogStore.update({ sealIds: sealedCatalog.map(entry => entry.id) })
      }
    } catch (error) {
      if (disposed) return
      if (Object.hasOwn(credential, 'userToken') && sealedCredential()?.userToken !== credential.userToken) return
      if (error?.code === CODE.credential) {
        sealedCatalog = []
        catalogStore.update({ sealIds: [] })
        logger.warn?.('provider-hub: the sealed lane refused its credential; its models are hidden until it is accepted again')
        return
      }
      logger.warn?.(`provider-hub: sealed lane listing failed (${error?.code ?? 'unknown'}); keeping its cached roster`)
    }
  }

  async function refreshSealedLane() {
    await refreshSealedRoster()
    if (disposed) return
    // The rebuild in `mergeCatalogs` drops a stale roster on its own: a closed
    // lane's rows vanish without a filter pass over the merged view.
    mergeCatalogs()
    emitTopology()
  }

  async function refreshKiloRoster() {
    try {
      const payload = await fetchKiloListing({ signal: lifetime.signal })
      if (disposed) return
      if (payload?.error || !Array.isArray(payload?.data)) throw new Error('invalid Kilo model listing')
      kiloCatalog = buildKiloCatalog(payload.data)
      catalogStore.update({ kiloRows: kiloCatalog })
    } catch (error) {
      if (!disposed) logger.warn?.(`provider-hub: Kilo channel listing failed (${error?.code ?? error?.message ?? 'unknown'}); keeping its cached roster`)
    }
  }

  async function fetchListing() {
    if (disposed) return { data: [] }
    const started = Date.now()
    const listing = await getJson('/inference/v1/models', {
      session: sessionForConversation('catalog:provider-hub'),
      attributionUserAgent,
      signal: lifetime.signal,
    })
    if (!disposed) gatewayLatency = { ms: Date.now() - started, at: Date.now() }
    return listing
  }

  let probeRound = null
  let probeThrottleStreak = 0
  let probeBackoffUntil = 0
  /**
   * How long a verdict is trusted before that model is worth another request.
   *
   * The round used to re-ping every probeable model on every cycle, so a model
   * that answered "Rate limit exceeded" was asked again fifteen minutes later —
   * the probe traffic itself kept the free lane's per-model quota pinned at zero.
   * `unknown` is a failure we want to retry, so it stays on the normal cadence;
   * the other four are verdicts that cannot flip in minutes, and asking again
   * only spends quota to hear the same answer.
   *
   * `available` is in that group for a reason the first version got wrong: it is
   * *not* cheap to re-confirm. A probe is a real inference call charged to the
   * same per-model quota the user needs, so re-pinging a working model fifteen
   * minutes after it answered "OK" spends the quota that made it work — and a
   * probe that then trips the limit turns a usable model into an hour-long
   * `throttled` verdict. Re-confirming a model that already works is the one
   * probe with a negative payoff.
   */
  const PROBE_TTL_MS = {
    [STATE.available]: 60 * 60_000,
    [STATE.throttled]: 60 * 60_000,
    [STATE.regionBlocked]: 6 * 60 * 60_000,
    [STATE.unavailable]: 6 * 60 * 60_000,
  }

  function probeDue(entry, snapshot, force, only) {
    // An explicit list is an explicit request: the caller already decided this
    // model is worth a call right now. That is the path a region rejection
    // schedules for the one model that just failed, and the TTLs must not eat it
    // — a row that still said `available`, or one already stamped
    // `region-blocked`, would otherwise silence the reprobe for up to six hours
    // and leave the real request that triggered it unexplained.
    if (only !== undefined) return only.includes(entry.id)
    if (force) return true
    const row = snapshot.results?.[entry.id]
    const ttl = PROBE_TTL_MS[row?.state]
    if (ttl === undefined) return true
    return !(typeof row.at === 'number' && Date.now() - row.at < ttl)
  }

  async function runProbeRound(force = false, only = undefined) {
    // The absorbed channels get no per-model probes: their verdicts would be
    // spent against a different gateway than the one that serves them, and a
    // roster the listing named is advertised as-is (its health is the listing
    // round's, refreshed on the same cadence). The aggregate lane is excluded
    // for a sharper reason — a probe there is a *real request to a provider the
    // user pays for*, spent to learn something the settings page already knows
    // (whether a key is configured). A combo is excluded because it has no
    // endpoint of its own: probing one would send the chain's own id to the free
    // lane as a model name, spending quota to collect a verdict about nothing.
    const candidates = catalog.filter(entry => !isEacEntry(entry) && !isKiloEntry(entry) && !isAggregateEntry(entry) && !isComboEntry(entry))
    const snapshotBefore = availability.get()
    const probeable = candidates.filter(entry => probeDue(entry, snapshotBefore, force, only))
    if (probeable.length === 0) {
      // Nothing is due: every verdict is still inside its trust window. Bumping
      // `at` here would lie to the settings page about when the last real round
      // ran, so this returns the snapshot's own timestamp instead.
      return {}
    }
    const results = await probeCatalog(probeable, { attributionUserAgent, signal: lifetime.signal }, (id, result) => {
      if (disposed) return
      availability.edit(value => ({
        ...value,
        results: {
          ...value.results,
          [id]: {
            state: result.state,
            ...result.detail === undefined ? {} : { detail: result.detail },
            ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs },
            latencyMs: result.latencyMs, startedAt: result.startedAt, at: Date.now(),
          },
        },
      }))
    }, 2)
    if (disposed) return {}
    availability.update({ at: Date.now(), egress })
    // Rows for models the listing no longer names used to accumulate forever: the
    // file grew one entry per model that ever appeared, and a verdict for a model
    // nobody can select is dead weight the settings page still had to ship. Keep
    // manualTest rows — those are the user's own samples, not a probe verdict.
    const live = new Set(catalog.map(entry => entry.id))
    availability.edit(value => {
      const kept = {}
      let dropped = 0
      for (const [id, row] of Object.entries(value.results ?? {})) {
        if (live.has(id)) kept[id] = row
        else dropped += 1
      }
      if (dropped === 0) return value
      logger.info?.(`provider-hub: dropped ${dropped} stale availability row(s) for models the listing no longer names`)
      return { ...value, results: kept }
    })
    availability.flush()
    const verdicts = Object.values(results)
    if (verdicts.length > 0 && verdicts.every(row => row.state === STATE.unavailable)) {
      logger.warn?.(`provider-hub: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
    }
    // The lane-wide pause is a whole-round verdict. A single-model reprobe (the
    // one a region rejection schedules) must not park every other model for
    // half an hour just because that one model happened to answer "throttled".
    const allThrottled = only === undefined && verdicts.length > 0 && verdicts.every(row => row.state === STATE.throttled)
    if (only !== undefined) {
      probeThrottleStreak = 0
      probeBackoffUntil = 0
    } else {
      probeThrottleStreak = allThrottled ? probeThrottleStreak + 1 : 0
      probeBackoffUntil = allThrottled
        ? Date.now() + Math.min(30 * 2 ** (probeThrottleStreak - 1), 120) * 60_000
        : 0
      if (allThrottled) {
        logger.warn?.(`provider-hub: the probe round hit the lane's quota; availability probes pause for ${Math.round((probeBackoffUntil - Date.now()) / 60_000)} minutes (your own requests are unaffected, and the reprobe button forces a round)`)
      }
    }
    emitTopology()
    return results
  }
  async function refreshAvailability(force = false, only = undefined) {
    if (disposed || (!force && probeBackoffUntil > Date.now())) return {}
    if (probeRound !== null) return probeRound
    const round = runProbeRound(force, only)
    probeRound = round
    try { return await round } finally { if (probeRound === round) probeRound = null }
  }

  async function watchEgress() {
    if (disposed) return false
    const seen = await detectEgress({ signal: lifetime.signal })
    if (disposed || seen === undefined) return false
    const previous = availability.get().egress
    const changed = previous === null || previous === undefined
      || previous.ip !== seen.ip || (seen.country !== undefined && previous.country !== seen.country)
    egress = seen
    if (changed) {
      availability.update({ egress: seen })
      availability.flush()
      logger.info?.(`provider-hub: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; re-probing availability`)
      await refreshAvailability(true)
    }
    return true
  }

  const latestTests = new Map()
  async function testModel(id, effort = DEFAULT_LEVEL, { signal } = {}) {
    if (disposed) throw new UpstreamError('Model runtime stopped', CODE.aborted)
    if (settings.get().enabled === false) throw new UpstreamError('Inference is paused', CODE.client)
    const entry = catalog.find(candidate => candidate.id === id)
    if (!entry) throw new UpstreamError('Unknown model "' + id + '"', CODE.client, { status: 404 })
    const token = {}
    latestTests.set(id, token)
    const selectedEffort = effort === undefined || effort === '' ? DEFAULT_LEVEL : effort
    const linkedSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const persist = row => {
      if (disposed || linkedSignal.aborted || latestTests.get(id) !== token) return false
      availability.edit(value => ({ ...value, manualResults: { ...value.manualResults, [id]: row } }))
      availability.flush()
      emitTopology()
      return !availability.writeFailed
    }
    try {
      const measured = await runModelTest(testSignal => adapter.stream({
        provider: ROUTE_MAIN, model: entry.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoningEffort: selectedEffort, sessionId: 'bench:' + entry.id + ':' + selectedEffort,
        signal: testSignal,
      }, entry, state()), { signal: linkedSignal })
      if (linkedSignal.aborted || disposed) throw new UpstreamError('Text test cancelled', CODE.aborted)
      const persisted = persist({ state: STATE.available, source: 'manual', at: Date.now(), ttftMs: measured.ttftMs, latencyMs: measured.totalMs })
      return { model: entry.id, effort: selectedEffort, ok: true, ...measured, persisted }
    } catch (error) {
      // Cancellation is a user action, not a fresh availability verdict. Other failures
      // remain unknown instead of silently banning a paid/region-gated route.
      if (error?.code !== CODE.aborted) persist({ state: STATE.unknown, source: 'manual', at: Date.now(), detail: String(error?.message ?? error).slice(0, 200) })
      throw error
    } finally {
      if (latestTests.get(id) === token) latestTests.delete(id)
    }
  }

  return {
    testModel, state, adapter, refreshCatalog, refreshSealedLane, refreshAvailability, watchEgress, fetchListing,
    complete: createForwardCompletion({
      adapter, signal: lifetime.signal,
      state: () => {
        const snapshot = state()
        // Hiding advertisements must not invalidate requests using a saved id.
        return { ...snapshot, membership: computeMembership(snapshot.catalog, availability.get(), {
          ...snapshot.settings, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false,
        }) }
      },
    }),
    publicModelRows: () => publicModelRows(state()),
    // A settings write that changes the aggregate lane or the chains (a key
    // saved, a provider switched off, a combo edited) rebuilds the merged view
    // without a listing round: the aggregate rows come from settings alone.
    syncAggregateCatalog() {
      if (disposed) return catalog
      mergeCatalogs()
      emitTopology()
      return catalog
    },
    get catalog() { return catalog },
    get egress() { return egress },
    get gatewayLatency() { return gatewayLatency },
    setAttributionUserAgent(value) { attributionUserAgent = value },
    dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
      clearTimeout(reprobeTimer)
    },
  }
}

function materializeCatalog(ids) {
  const rebuilt = buildCatalog(ids)
  return rebuilt.length > 0 ? rebuilt : FALLBACK_CATALOG
}

export function computeMembership(catalog, availabilitySnapshot, settings) {
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = entry => modelAvailability(entry.id, availabilitySnapshot, Boolean(entry.channel)).availability
  const probeable = catalog.filter(entry => !entry.channel)
  const refusedAll = probeable.length > 0 && probeable.every(entry => verdictOf(entry) === STATE.unavailable)
  let usable = catalog.filter(entry => verdictOf(entry) !== STATE.unavailable)
  if (refusedAll) usable = catalog
  const main = []
  const region = []
  for (const entry of usable) {
    if (isModelHidden(entry, settings)) continue
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}
