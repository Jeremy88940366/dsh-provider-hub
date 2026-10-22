/**
 * 上游 OFM 的版本追踪。
 *
 * 我们 fork 自 Ebony-Vinyl/dsh-our-free-model，但 fork 之后上游发了什么版本、
 * main 上又合了什么，在这个仓库里完全看不到 —— sync-base.json 只是一个静态
 * 基线，而 `sync-upstream.mjs` 要靠 `git fetch upstream --tags` 才知道有新 tag，
 * 那条路走 github.com:443，代理一关就断。
 *
 * 这里换成 api.github.com（直连可用，不依赖代理），并且：
 *   - 只用 REST，不 clone、不 fetch，几 KB 就够；
 *   - 结果落在 dataDir/upstream-state.json，重启后仍然能看到上次检查的结论；
 *   - 检查失败保留上一次的成功结果，不把「网络不通」显示成「上游没更新」。
 *
 * 不自动轮询上游：这件事的答案以天为单位变化，按 updateCheckHours 的节奏顺带
 * 查一次就够（见 index.js 里的 every()）。
 *
 * 关于凭据：匿名调用只有 60 次/小时，而一次 check 要 2~3 个请求，加上开机和定时
 * 各查一次、面板上还手点 —— 很快就会撞 403 `API rate limit exceeded`。带 token 是
 * 5000 次/小时。所以下面会尽力找一个 token（见 readUpstreamToken），找不到才退回
 * 匿名。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const UPSTREAM_REPO = 'Ebony-Vinyl/dsh-our-free-model'

/**
 * 上游有、我们不跟的路径。必须与 scripts/sync-upstream.mjs 的 SKIP_PATHS 一致 ——
 * 那份是「合并时跳过」，这份是「统计时不计入待跟进」。两边不同步会让人以为有
 * N 个文件要处理，实际合并时全被跳过。
 */
export const SKIP_PATHS = [
  '.github/',
  'packages/standalone/',
  'catalog/',
  'docs/',
  'PACKAGING.md',
  'README_EN.md',
  'CHANGELOG.md',
  'package-lock.json',
  'feed/announcements.json',
  'src/sponsor.js',
  'src/sponsor.css',
  'src/feed.js',
  'src/picks.js',
  'scripts/',
]

/** 会跟进，但内容永远保留本地版本：上游改了只提示，不自动合并。 */
export const KEEP_OURS = ['README.md', 'package.json', 'feed/manifest.json', 'cordis.patch.yml', 'LICENSE']

export const isSkipped = file => SKIP_PATHS.some(p => (p.endsWith('/') ? file.startsWith(p) : file === p))
export const isKept = file => KEEP_OURS.includes(file)

const semver = tag => {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tag))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export const compareUpstreamTags = (a, b) => {
  const x = semver(a)
  const y = semver(b)
  if (x === null || y === null) return 0
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

export const validUpstreamTag = tag => semver(tag) !== null

/**
 * 读 sync-base.json 里的基线。这个文件是同步流程写的，缺失时按 fork 起点推定。
 * @param {string} pkgDir
 */
export function readBaseline(pkgDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(pkgDir, 'sync-base.json'), 'utf8'))
    return typeof parsed?.upstreamTag === 'string' && validUpstreamTag(parsed.upstreamTag) ? parsed.upstreamTag : 'v2.5.7'
  } catch {
    return 'v2.5.7'
  }
}

/**
 * 把 GitHub 的三份数据整理成一份结论。
 *
 * 纯函数，单独测：这里的分组错了，界面上「要合并 N 个文件」就是错的，
 * 而那种错不会自己暴露 —— 合并脚本照样会跳过它该跳的。
 *
 * @param {object} input
 * @param {string} input.baseline
 * @param {string[]} input.tags - 上游所有 vX.Y.Z tag（顺序不限）
 * @param {{ahead_by?: number, commits?: Array<{sha: string, commit?: {message?: string}}>}} [input.compareMain]
 * @param {{files?: Array<{filename: string, status: string, additions: number, deletions: number}>}} [input.compareRange]
 */
export function summarizeUpstream({ baseline, tags, compareMain, compareRange }) {
  const known = (tags ?? []).filter(validUpstreamTag).slice().sort(compareUpstreamTags)
  const latestTag = known.length > 0 ? known[known.length - 1] : ''
  const behind = known.filter(tag => compareUpstreamTags(tag, baseline) > 0)

  const unreleased = {
    aheadBy: Number.isFinite(compareMain?.ahead_by) ? compareMain.ahead_by : 0,
    commits: (compareMain?.commits ?? []).map(commit => ({
      sha: String(commit.sha ?? '').slice(0, 7),
      message: String(commit.commit?.message ?? '').split('\n')[0],
    })),
  }

  const files = (compareRange?.files ?? []).map(file => ({
    file: file.filename,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  }))
  const live = files.filter(file => !isSkipped(file.file))
  // 上游删掉的文件单独归一组。
  //
  // 这一组最容易数错：它们确实出现在 diff 里，但 `sync-upstream.mjs` 对「上游删了
  // 而我们还有」的处理是 keep-local / 跳过，永远不会合并。算进「要合并 N 个文件」
  // 就会让 N 虚高 —— 而且虚高的正是行数最大的那些（上游 2.5.9 删掉的 11 个渠道文件
  // 共 -5905 行），一眼看去像是有大工程要做。
  const removed = live.filter(file => file.status === 'removed')
  const remaining = live.filter(file => file.status !== 'removed')
  const mergeable = remaining.filter(file => !isKept(file.file))
  const keepOurs = remaining.filter(file => isKept(file.file))
  const skipped = files.filter(file => isSkipped(file.file))

  return {
    baseline,
    latestTag,
    behind,
    updated: behind.length > 0 || unreleased.aheadBy > 0,
    unreleased,
    counts: {
      mergeable: mergeable.length,
      keepOurs: keepOurs.length,
      removed: removed.length,
      skipped: skipped.length,
    },
    files: { mergeable, keepOurs, removed, skipped },
  }
}

/**
 * 找一个 GitHub token。
 *
 * 只为把额度从 60 次/小时提到 5000 次/小时 —— 读公开仓库不需要任何权限，
 * 所以这里只认「已经在本机上的」凭据，不弹窗、不引导用户去申请。
 *
 * 顺序：
 *   1. 环境变量 GITHUB_TOKEN / GH_TOKEN（CI 与临时覆盖用）
 *   2. ~/.dsh/tools/gh/.tok（本机 gh 的令牌，内容就是裸 token）
 *   3. <pkgDir>/.upstream-token（仓库自带的，已在 .gitignore 里）
 *
 * 读不到就返回 ''，调用方退回匿名。
 *
 * @param {string} pkgDir
 * @param {{homedir?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {string}
 */
export function readUpstreamToken(pkgDir, { homedir = os.homedir(), env = process.env } = {}) {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()

  const candidates = [
    path.join(homedir, '.dsh', 'tools', 'gh', '.tok'),
    path.join(pkgDir, '.upstream-token'),
  ]
  for (const file of candidates) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      // 只要形似令牌的内容：gho_/ghp_/github_pat_ 前缀，或至少 20 位的裸串。
      // 文件存在但内容不是令牌（比如被写成了说明文字）时不该发出去当 Authorization。
      if (/^(gh[opusr]_|github_pat_)/.test(value) || /^[A-Za-z0-9_]{20,}$/.test(value)) return value
    } catch {
      /* 没有这个文件是正常情况 */
    }
  }
  return ''
}

const STATE_VERSION = 1

/**
 * 上游版本追踪器。
 *
 * 与 PluginUpdater 的区别：那个管「本插件自己的新版本」，这个管「上游项目的新
 * 版本」。两者都写 dataDir，但文件不同，互不覆盖。
 */
export class UpstreamTracker {
  /**
   * @param {object} deps
   * @param {string} deps.pkgDir - 本插件安装目录（读 sync-base.json）
   * @param {string} deps.dataDir - 插件数据目录（放 upstream-state.json）
   * @param {typeof fetch} [deps.fetchImpl]
   * @param {(message: string) => void} [deps.log]
   * @param {string} [deps.repo]
   * @param {string} [deps.token] - GitHub token；缺省时按 readUpstreamToken 现找
   */
  constructor({ pkgDir, dataDir, fetchImpl = fetch, log = () => {}, repo = UPSTREAM_REPO, token }) {
    this.deps = { pkgDir, dataDir, fetchImpl, log, repo, token }
    this.state = this.load()
    this.checking = false
  }

  get stateFile() {
    return path.join(this.deps.dataDir, 'upstream-state.json')
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (parsed?.version !== STATE_VERSION || typeof parsed.lastOk !== 'object' || parsed.lastOk === null) {
        throw new Error('invalid upstream state')
      }
      return parsed
    } catch {
      return { version: STATE_VERSION, lastOk: null, lastAttempt: null, lastError: '' }
    }
  }

  persist() {
    try {
      fs.mkdirSync(this.deps.dataDir, { recursive: true })
      fs.writeFileSync(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`)
    } catch (error) {
      this.deps.log(`provider-hub: could not persist upstream state (${error?.message ?? error})`)
    }
  }

  /**
   * 界面上显示的东西。
   *
   * 关键取舍：`lastOk` 与 `lastError` 分开报。检查失败时不能把基线当成「已同步」
   * 展示 —— 那会让人以为上游真的没动。所以 error 非空时界面必须同时显示上次成功
   * 的时间，让人知道这份结论是旧的。
   */
  status() {
    const lastOk = this.state.lastOk
    return {
      repo: this.deps.repo,
      baseline: readBaseline(this.deps.pkgDir),
      checking: this.checking,
      lastAttempt: this.state.lastAttempt ?? 0,
      lastError: this.state.lastError ?? '',
      // 全部来自上一次成功检查；null 表示从来没查通过
      latestTag: lastOk?.latestTag ?? '',
      behind: lastOk?.behind ?? [],
      updated: lastOk?.updated === true,
      unreleased: lastOk?.unreleased ?? { aheadBy: 0, commits: [] },
      counts: lastOk?.counts ?? { mergeable: 0, keepOurs: 0, removed: 0, skipped: 0 },
      files: lastOk?.files ?? { mergeable: [], keepOurs: [], removed: [], skipped: [] },
      checkedAt: lastOk?.checkedAt ?? 0,
    }
  }

  /**
   * 查一次上游。
   *
   * 三次请求：tag 列表（拿最新版本）、latestTag...main（拿未发版提交）、
   * baseline...latestTag（拿文件级差异）。第三份只在确实落后时才发 —— 已经
   * 同步时它没有意义，而匿名调用只有 60 次/小时。
   *
   * @param {{signal?: AbortSignal}} [options]
   */
  async check({ signal } = {}) {
    if (this.checking) return this.status()
    this.checking = true
    this.state.lastAttempt = Date.now()
    const baseline = readBaseline(this.deps.pkgDir)
    const token = this.deps.token ?? readUpstreamToken(this.deps.pkgDir)
    try {
      const request = async url => {
        const headers = {
          accept: 'application/vnd.github+json',
          'user-agent': 'provider-hub-upstream-check',
        }
        if (token !== '') headers.authorization = `Bearer ${token}`
        const response = await this.deps.fetchImpl(url, { redirect: 'error', signal, headers })
        if (!response.ok) {
          const remaining = response.headers?.get?.('x-ratelimit-remaining')
          const reset = Number(response.headers?.get?.('x-ratelimit-reset'))
          const limited = response.status === 429 || (response.status === 403 && remaining === '0')
          if (!limited) throw new Error(`HTTP ${response.status}`)
          // 匿名 60 次/小时，带 token 5000 次/小时。额度耗尽时把「什么时候恢复」
          // 和「现在是不是匿名」都说清楚 —— 只说 rate limit exceeded 会让人以为
          // 是上游或插件坏了。
          const wait = Number.isFinite(reset) && reset > 0
            ? `，${Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000))} 分钟后恢复`
            : ''
          throw new Error(token === ''
            ? `GitHub API 匿名额度已用尽（60 次/小时）${wait}；配置 token 可提到 5000 次/小时`
            : `GitHub API 额度已用尽（token）${wait}`)
        }
        return response.json()
      }

      const tags = (await request(`https://api.github.com/repos/${this.deps.repo}/tags?per_page=100`))
        .map(row => row?.name)
        .filter(validUpstreamTag)

      const provisional = summarizeUpstream({ baseline, tags })
      if (provisional.latestTag === '') throw new Error('上游没有形如 vX.Y.Z 的 tag')

      let compareMain
      try {
        compareMain = await request(`https://api.github.com/repos/${this.deps.repo}/compare/${provisional.latestTag}...main`)
      } catch (error) {
        // main 被改名/还没建不影响主结论
        if (!/HTTP 404/.test(String(error?.message ?? ''))) throw error
      }

      let compareRange
      if (provisional.behind.length > 0) {
        compareRange = await request(`https://api.github.com/repos/${this.deps.repo}/compare/${baseline}...${provisional.latestTag}`)
      }

      const summary = summarizeUpstream({ baseline, tags, compareMain, compareRange })
      this.state.lastOk = { ...summary, checkedAt: Date.now() }
      this.state.lastError = ''
      this.persist()
      return this.status()
    } catch (error) {
      this.state.lastError = String(error?.message ?? error)
      this.persist()
      throw error
    } finally {
      this.checking = false
    }
  }
}
