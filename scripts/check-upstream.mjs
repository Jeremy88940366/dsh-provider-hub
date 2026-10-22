#!/usr/bin/env node
/**
 * 看上游 OFM 更新到哪了 —— 以及我们落后多少。
 *
 * 为什么单独做这个：`sync-upstream.mjs` 靠本地 git tag 判断版本，而拉 tag 要
 * `git fetch upstream`，那条路走 github.com:443（需要代理）。代理一关就完全
 * 看不到上游动向。这里改走 api.github.com —— 实测直连稳定，不依赖代理。
 *
 * 判定逻辑全部来自 src/upstream-track.js（插件内的同一份代码），所以命令行
 * 说的和界面上显示的一定是同一个结论。
 *
 * 用法：
 *   node scripts/check-upstream.mjs            人读的输出
 *   node scripts/check-upstream.mjs --json     机器读的 JSON
 *   node scripts/check-upstream.mjs --quiet    只在有更新时输出（给定时任务用）
 *
 * 退出码：0 = 已是最新；1 = 有可跟进的更新；2 = 检查失败（网络/API）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { UpstreamTracker, readBaseline, summarizeUpstream, validUpstreamTag, compareUpstreamTags, UPSTREAM_REPO } from '../src/upstream-track.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const asJson = flag('--json')
const quiet = flag('--quiet')

// ── 网络 ────────────────────────────────────────────────────────────────────
// api.github.com 直连可用；代理开着时走代理通常更快。有就用，没有也能跑。
const proxyUrl = (() => {
  try {
    return execFileSync('git', ['config', '--get', 'http.proxy'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
})()

// 令牌能免掉匿名限流（60 次/小时 → 5000）。有就用，没有也能跑。
const token = (() => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  for (const file of [path.join(home, '.dsh', 'tools', 'gh', '.tok'), path.join(ROOT, '.upstream-token')]) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      if (value !== '') return value
    } catch {
      /* 试下一个 */
    }
  }
  return ''
})()

const fetchImpl = async (url, init) => {
  const options = {
    ...init,
    headers: { ...init?.headers, ...(token === '' ? {} : { authorization: `Bearer ${token}` }) },
  }
  if (proxyUrl !== '') {
    try {
      const { ProxyAgent } = await import('undici')
      options.dispatcher = new ProxyAgent(proxyUrl)
    } catch {
      /* undici 不在，退回直连 */
    }
  }
  return fetch(url, options)
}

// ── 检查 ────────────────────────────────────────────────────────────────────
const dataDir = path.join(ROOT, '.upstream-cache')
const baseline = readBaseline(ROOT)

const fail = (message, detail) => {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: message, detail: detail ?? '', baseline }, null, 2))
  } else {
    console.error(`✗ ${message}`)
    if (detail) console.error(`  ${detail}`)
    console.error('\n检查走 api.github.com（直连可用，不需要代理）。若持续失败：')
    console.error('  1) 确认能访问 https://api.github.com')
    console.error('  2) 匿名限流 60 次/小时，放一个 token 到 ~/.dsh/tools/gh/.tok')
  }
  process.exit(2)
}

const tracker = new UpstreamTracker({ pkgDir: ROOT, dataDir, fetchImpl, repo: UPSTREAM_REPO })

let status
try {
  status = await tracker.check()
} catch (error) {
  fail(`检查失败：${error?.message ?? error}`)
}

// 命令行不该在仓库里留缓存目录；把状态文件删掉，dataDir 只在插件运行时有用。
try {
  fs.rmSync(dataDir, { recursive: true, force: true })
} catch {
  /* 删不掉不影响结论 */
}

const report = {
  ok: true,
  upstream: status.repo,
  baseline: status.baseline,
  latestTag: status.latestTag,
  behind: status.behind,
  updated: status.updated,
  unreleased: status.unreleased,
  files: status.counts,
  changes: status.files,
  checkedAt: new Date(status.checkedAt).toISOString(),
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(status.updated ? 1 : 0)
}

if (quiet && !status.updated) process.exit(0)

// ── 人读输出 ────────────────────────────────────────────────────────────────
const pad = label => label.padEnd(10)
const stat = c => `${String(c.additions).padStart(5)} +  ${String(c.deletions).padStart(5)} -`

console.log(`上游 ${status.repo}`)
console.log(`  ${pad('我们的基线')} ${status.baseline}`)
console.log(`  ${pad('上游最新')} ${status.latestTag}${status.behind.length === 0 ? '  ← 已同步' : ''}`)
if (status.behind.length > 0) console.log(`  ${pad('落后')} ${status.behind.length} 个版本：${status.behind.join(' → ')}`)

if (status.unreleased.aheadBy > 0) {
  console.log(`  ${pad('未发版')} ${status.latestTag} 之后 main 还有 ${status.unreleased.aheadBy} 个提交`)
  for (const c of status.unreleased.commits.slice(-8)) console.log(`             ${c.sha}  ${c.message}`)
  if (status.unreleased.commits.length > 8) console.log(`             …另有 ${status.unreleased.commits.length - 8} 个`)
}

if (!status.updated) {
  console.log('\n没有需要跟进的更新。')
  process.exit(0)
}

if (status.files.mergeable.length > 0) {
  console.log(`\n要合并的改动（${status.files.mergeable.length} 个文件）：`)
  for (const c of status.files.mergeable) console.log(`  ${c.status.padEnd(9)} ${stat(c)}  ${c.file}`)
} else if (status.behind.length > 0) {
  console.log('\n上游这一版只动了我们不跟的文件（文档/打包/目录/上游脚本）。')
}

if (status.files.keepOurs.length > 0) {
  console.log(`\n会提示但保留本地版本（${status.files.keepOurs.length} 个，见 KEEP_OURS）：`)
  for (const c of status.files.keepOurs) console.log(`  ${c.status.padEnd(9)} ${stat(c)}  ${c.file}`)
}

if (status.files.skipped.length > 0) {
  console.log(`\n已跳过（${status.files.skipped.length} 个文件，按 SKIP_PATHS）：`)
  const byTop = new Map()
  for (const c of status.files.skipped) {
    const top = c.file.includes('/') ? `${c.file.split('/')[0]}/` : c.file
    byTop.set(top, (byTop.get(top) ?? 0) + 1)
  }
  for (const [top, count] of [...byTop.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)} 个  ${top}`)
  }
}

console.log('\n下一步：')
if (status.behind.length > 0) {
  console.log(`  git fetch upstream --tags                          # 需要代理`)
  console.log(`  node scripts/sync-upstream.mjs --to ${status.latestTag}         # 试运行`)
  console.log(`  node scripts/sync-upstream.mjs --to ${status.latestTag} --apply`)
} else {
  console.log('  上游只有未发版的 main 提交，等它打 tag 再同步；')
  console.log('  想提前要可以逐个 cherry-pick，提交号见上。')
}

process.exit(1)
