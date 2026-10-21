#!/usr/bin/env node
/**
 * 从上游仓库同步更新。
 *
 * 原理：我们的仓库 = 上游 + 一套机械的「改名映射」+ 少量真实改动。
 * 所以上游每次发版时，只要把上游的新旧两版都套上同一个改名映射，再和
 * 我们的文件做三路合并，就能把上游的功能改动搬进来，而不会把我们自己的
 * 改动（删掉的赞助条、公告中心、渠道保留等）冲掉。
 *
 * 用法：
 *   node scripts/sync-upstream.mjs                  # 同步到上游最新 tag（试运行）
 *   node scripts/sync-upstream.mjs --to v2.5.9      # 同步到指定 tag
 *   node scripts/sync-upstream.mjs --apply          # 真正写入文件
 *   node scripts/sync-upstream.mjs --list           # 列出有哪些上游版本可选
 *
 * 冲突处理：冲突的文件会被写出 <<<<<<< 标记，脚本以退出码 2 结束，
 * 并把冲突清单列出来。解决完再跑一次 sign-release.mjs 重签清单。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 改名映射，顺序敏感：长的先替换，否则 `our-free-model` 会先把
 * `dsh-our-free-model` 啃掉一半。
 */
const RENAME = [
  // 包名 / 仓库 slug
  ['dsh-free-model-mine', 'dsh-provider-hub'],
  ['dsh-our-free-model', 'dsh-provider-hub'],
  ['our-free-model', 'provider-hub'],
  // 显示名
  ['Our Free Model', 'Provider Hub'],
  ['our free model', 'provider hub'],
  // 环境变量
  ['OUR_FREE_MODEL_KILO_BASE', 'PROVIDER_HUB_KILO_BASE'],
  ['OUR_FREE_MODEL_BASE', 'PROVIDER_HUB_BASE'],
  ['OFM_', 'HUB_'],
  // 作者与归属
  ['Ebony-Vinyl/dsh-provider-hub', 'Jeremy88940366/dsh-provider-hub'],
  ['Ebony-Vinyl', 'Jeremy88940366'],
]

/** 上游有、我们不要的文件（相对路径前缀或精确路径）。 */
const SKIP_PATHS = [
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
  'src/feed.js', // 公告中心已从 UI 摘除，模块保留但不再跟随上游
  'src/picks.js', // 推荐项目页已删除
  'scripts/', // 上游的测试脚本我们不要；本仓库 scripts/ 只有 sign-release.mjs
]

function rename(text) {
  let out = text
  for (const [from, to] of RENAME) out = out.split(from).join(to)
  // 裸词 OFM → Provider Hub（只匹配独立成词，不碰 ofm_ 类名）
  out = out.replace(/\bOFM(?![_\-A-Za-z0-9])/g, 'Provider Hub')
  return out
}

const git = (args, opts = {}) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  })

/** 读某版本某文件；不存在时静默返回 null（不打印 git 的 fatal:）。 */
function show(ref, file) {
  try {
    return git(['show', `${ref}:${file}`])
  } catch {
    return null
  }
}

/**
 * 这些文件里绝大多数内容是我们的身份/自己生成的，永远保留本地版本，
 * 只把上游的改动列出来供人工参考。
 */
const KEEP_OURS = [
  'README.md', // 已重写为中性版
  'package.json', // 包名/版本/仓库地址都不同
  'feed/manifest.json', // 由 sign-release.mjs 生成，上游的签名对不上我们的公钥
  'cordis.patch.yml', // 装载点、id、name 都改过
  'LICENSE',
]

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

function semver(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** 所有上游 tag，按版本号升序，排除 macos 变体。 */
function upstreamTags() {
  return git(['tag', '--list', 'v*'])
    .split('\n')
    .map((s) => s.trim())
    .filter((t) => semver(t) !== null)
    .sort((a, b) => {
      const x = semver(a), y = semver(b)
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
    })
}

if (flag('--list')) {
  const tags = upstreamTags()
  console.log('上游可用版本（已 fetch 到本地）：')
  for (const t of tags.slice(-12)) console.log(`  ${t}`)
  console.log(`\n共 ${tags.length} 个。当前基线见 sync-base.json。`)
  process.exit(0)
}

// ── 读基线 ──────────────────────────────────────────────────────────────────
const BASE_FILE = path.join(ROOT, 'sync-base.json')
let base = null
if (fs.existsSync(BASE_FILE)) {
  base = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')).upstreamTag
} else {
  // 没记录就推定：我们 fork 自 2.5.7
  base = 'v2.5.7'
  console.log(`! 没有 sync-base.json，按 v2.5.7 推定基线`)
}

const tags = upstreamTags()
if (!tags.includes(base)) fail(`基线 ${base} 不在本地 tag 里，先 git fetch upstream --tags`)

const target = valueOf('--to') ?? tags[tags.length - 1]
if (!tags.includes(target)) fail(`目标 ${target} 不存在。可用：${tags.slice(-5).join(', ')}`)
if (target === base) {
  console.log(`已经在上游 ${base}，没有可同步的更新。`)
  process.exit(0)
}

console.log(`上游同步：${base} → ${target}${flag('--apply') ? '' : '（试运行，加 --apply 才写入）'}\n`)

// ── 算出上游这次改了哪些文件 ────────────────────────────────────────────────
const changed = git(['diff', '--name-status', base, target])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split('\t')
    return { status, file: rest[rest.length - 1] }
  })
  .filter(({ file }) => file && !SKIP_PATHS.some((p) => file === p || file.startsWith(p)))

if (changed.length === 0) {
  console.log('上游这次没有我们关心的改动。')
  process.exit(0)
}

const project = (ref, file) => {
  const raw = show(ref, file)
  return raw === null ? null : rename(raw)
}

let written = 0
let conflicts = []
let skipped = 0
const report = []

for (const { status, file } of changed) {
  const localPath = path.join(ROOT, file)
  const ours = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : null

  if (KEEP_OURS.includes(file)) {
    if (ours !== null) {
      report.push({ file, action: 'keep-local', note: '我们自己的身份文件，保留本地' })
      skipped += 1
    }
    continue
  }

  const baseText = project(base, file)
  const targetText = project(target, file)

  // 上游删了这个文件
  if (targetText === null) {
    if (ours !== null) {
      report.push({ file, action: 'keep-local', note: '上游删除了，我们保留' })
      skipped += 1
    }
    continue
  }

  // 上游新增的文件
  if (baseText === null) {
    if (ours !== null) {
      report.push({ file, action: 'skip', note: '上游新增，我们已有同名文件' })
      skipped += 1
      continue
    }
    if (flag('--apply')) {
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      fs.writeFileSync(localPath, targetText, 'utf8')
    }
    report.push({ file, action: 'add', note: '上游新增' })
    written += 1
    continue
  }

  // 双方都没这个文件（不该发生）
  if (ours === null) continue

  const dir = path.join(ROOT, '.sync-tmp')
  fs.mkdirSync(dir, { recursive: true })
  const safe = file.replace(/[\\/]/g, '__')
  const pOurs = path.join(dir, `${safe}.ours`)
  const pBase = path.join(dir, `${safe}.base`)
  const pTheirs = path.join(dir, `${safe}.theirs`)
  fs.writeFileSync(pOurs, ours, 'utf8')
  fs.writeFileSync(pBase, baseText, 'utf8')
  fs.writeFileSync(pTheirs, targetText, 'utf8')

  let merged = ''
  let conflicted = false
  try {
    merged = git(['merge-file', '-p', pOurs, pBase, pTheirs])
  } catch (error) {
    // git merge-file 冲突时退出码 = 冲突块数，合并结果仍在 stdout
    merged = typeof error.stdout === 'string' ? error.stdout : String(error.stdout ?? '')
    conflicted = merged.includes('<<<<<<<')
    if (!conflicted) {
      // 非冲突的异常（例如临时文件问题）要暴露出来，不能静默当成合并成功
      report.push({ file, action: 'error', note: String(error.message).split('\n')[0] })
      continue
    }
  }

  if (merged === ours) {
    report.push({ file, action: 'unchanged', note: '上游改动对我们无影响' })
    continue
  }

  if (conflicted) {
    conflicts.push(file)
    if (flag('--apply')) fs.writeFileSync(localPath, merged, 'utf8')
    report.push({ file, action: 'conflict', note: '需人工处理' })
    continue
  }

  if (flag('--apply')) fs.writeFileSync(localPath, merged, 'utf8')
  report.push({ file, action: 'merged', note: '' })
  written += 1
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const width = Math.max(...report.map((r) => r.file.length), 10)
for (const r of report) {
  const mark = { merged: '✓', add: '+', conflict: '!', unchanged: '·', skip: '~', 'keep-local': '=' }[r.action] ?? '?'
  console.log(`  ${mark} ${r.file.padEnd(width)}  ${r.note}`)
}

console.log('')
if (conflicts.length > 0) {
  console.log(`! ${conflicts.length} 个文件有冲突${flag('--apply') ? '（已写入，含 <<<<<<< 标记）' : '（加 --apply 才会写入）'}：`)
  for (const f of conflicts) console.log(`    ${f}`)
} else {
  console.log(`✓ 无冲突。${written} 个文件${flag('--apply') ? '已更新' : '待更新'}，${skipped} 个跳过。`)
}

if (flag('--apply') && conflicts.length === 0) {
  fs.writeFileSync(BASE_FILE, JSON.stringify({ upstreamTag: target, syncedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  console.log(`✓ 基线已推进到 ${target}（记录在 sync-base.json）`)
  console.log('')
  console.log('下一步：')
  console.log('  1. node scripts/sign-release.mjs --notes "同步上游 ' + target + '"')
  console.log('  2. git add -A && git commit -m "sync: 同步上游 ' + target + '"')
  console.log('  3. git push')
} else if (flag('--apply') && conflicts.length > 0) {
  console.log('\n冲突未解决，基线没有推进。处理后重跑本脚本。')
  process.exitCode = 2
}

// 清理临时目录
fs.rmSync(path.join(ROOT, '.sync-tmp'), { recursive: true, force: true })
