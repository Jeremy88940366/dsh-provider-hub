#!/usr/bin/env node
/**
 * 一条命令发版：重签清单 → 提交 → 推送。
 *
 * 为什么要有这个脚本：发版有三步，其中「重签清单」最容易被忘。忘了它，
 * `git push` 照样成功，但 feed/manifest.json 里的 sha256 还是上一版的 ——
 * 别的机器拉更新时逐文件校验对不上，整次更新被拒。症状是「推送了但没人
 * 收到更新」，而且不会报错，只会在安装端日志里留下一行校验失败。
 * 所以这里把三步绑成一次原子操作：清单签不过就根本不提交。
 *
 * 用法：
 *   node scripts/ship.mjs "3.7.5: 修 xxx"          改版本号 + 发版 + 推送
 *   node scripts/ship.mjs --notes notes.md "..."   带发布说明（写进清单的 notes 字段）
 *   node scripts/ship.mjs --no-bump "..."          版本号已经改好了，只发版
 *   node scripts/ship.mjs --dry-run "..."          只跑到提交为止，不推送
 *
 * 版本号规则：--no-bump 之外的场合，patch 位自动 +1。要跳 minor/major
 * 就自己改 package.json 再走 --no-bump。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PKG = path.join(ROOT, 'package.json')

const argv = process.argv.slice(2)
const has = flag => argv.includes(flag)
const argOf = flag => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
// 位置参数 = 提交说明；跳过所有 flag 及其值
const flagsWithValue = new Set(['--notes'])
const message = argv.filter((a, i) => {
  if (a.startsWith('--')) return false
  if (i > 0 && flagsWithValue.has(argv[i - 1])) return false
  return true
}).join(' ').trim()

const dryRun = has('--dry-run')
const noBump = has('--no-bump')

if (message === '') {
  console.error('✗ 缺少提交说明。用法：node scripts/ship.mjs "3.7.5: 改了什么"')
  process.exit(1)
}

/** 跑 git，输出直接透传到终端；失败即退出（不能带着半成品继续推） */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    console.error(`✗ git ${args.join(' ')} 失败`)
    if (detail) console.error(detail)
    process.exit(1)
  }
}

function step(text) {
  console.log(`\n▸ ${text}`)
}

// ── 0. 前置检查：别在脏历史/错误分支上发版 ───────────────────────────────────
step('检查仓库状态')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') {
  console.error(`✗ 当前在 ${branch} 分支，发版只从 main 走`)
  process.exit(1)
}
// 未跟踪文件不算脏（可能是本地草稿），但已跟踪文件的改动必须在下面被我们提交掉。
// 这里只拦「有冲突」和「正在 rebase/merge」这两种会毁掉提交的状态。
const gitDir = path.join(ROOT, '.git')
for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
  if (fs.existsSync(path.join(gitDir, marker))) {
    console.error(`✗ 仓库正在 rebase/merge/cherry-pick 中（.git/${marker} 存在），先收尾`)
    process.exit(1)
  }
}
// 提交身份必须已经配好。没配的话 git 会在 commit 时才炸，而那时清单已经重签过、
// 文件已经被 add 进暂存区 —— 版本号白改了，得手工回滚。
for (const key of ['user.name', 'user.email']) {
  let value = ''
  try {
    value = execFileSync('git', ['config', '--get', key], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* 未配置时 git config 返回 1 */ }
  if (value === '') {
    console.error(`✗ 没有配置 ${key}，git 无法提交。先跑：`)
    console.error(`    git config ${key} ${key === 'user.name' ? '"你的名字"' : '"you@example.com"'}`)
    process.exit(1)
  }
}
console.log(`  分支 ${branch}，HEAD ${git('rev-parse', '--short', 'HEAD')}`)

// ── 1. 版本号 ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
let version = pkg.version
if (!noBump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (m === null) {
    console.error(`✗ package.json 的 version "${version}" 不是 x.y.z，无法自动进位；改好后用 --no-bump`)
    process.exit(1)
  }
  version = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
  pkg.version = version
  fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`)
  step(`版本 ${m[0]} → ${version}`)
} else {
  step(`版本保持 ${version}（--no-bump）`)
}

// ── 2. 重签清单 ──────────────────────────────────────────────────────────────
// sign-release.mjs 自己会在落盘后按安装端路径回读验签，验不过就非零退出。
// 它退出即代表「这份清单推上去也没人能装」，所以这里跟着停。
step('重签 feed/manifest.json')
const signArgs = [path.join(HERE, 'sign-release.mjs')]
const notesFile = argOf('--notes')
if (notesFile !== undefined) signArgs.push('--notes', notesFile)

// 先问一句「现在这份清单还准吗」。准就跳过重签 —— publishedAt 每次都变，
// 无条件重签会让「什么都没改」也产生一个只有时间戳差异的提交。
// --check 在文件树和版本号都对得上时退出 0。
let manifestFresh = false
try {
  execFileSync(process.execPath, [...signArgs, '--check'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  manifestFresh = true
} catch { /* 不一致 → 走下面的重签 */ }

if (manifestFresh) {
  console.log('  文件树与版本号都没变，清单仍然有效，跳过重签')
} else {
  try {
    const out = execFileSync(process.execPath, signArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(out.trimEnd())
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    if (detail) console.error(detail)
    console.error('✗ 清单签名失败 —— 已中止，没有提交任何东西')
    process.exit(1)
  }
}

// ── 3. 提交 ──────────────────────────────────────────────────────────────────
step('提交')
git('add', '-A')
const staged = git('diff', '--cached', '--name-only')
if (staged === '') {
  console.log('  没有需要提交的改动')
} else {
  console.log(staged.split('\n').map(f => `  ${f}`).join('\n'))
  git('commit', '-q', '-m', message)
  console.log(`  → ${git('rev-parse', '--short', 'HEAD')} ${git('log', '-1', '--format=%s')}`)
}

// ── 4. 推送 ──────────────────────────────────────────────────────────────────
if (dryRun) {
  step('--dry-run：跳过推送')
  console.log(`  要推的时候跑：git push origin ${branch}`)
  process.exit(0)
}

// 两条路：origin 走 HTTPS（需要代理），ssh 远端走 ssh.github.com:443（TCP 稳定，
// 且不依赖 http.proxy —— SSH 自己出网）。
//
// 为什么要先探代理：本机到 github.com:443 时通时不通，HTTPS 推送能不能成，
// 完全取决于代理是否开着。代理关着时 git 会先花 ~20 秒超时再失败，然后我们才
// 切 ssh —— 白等。所以先花 ~400ms 探一下代理端口，死了就直接走 ssh。
const proxyUrl = (() => {
  try {
    return execFileSync('git', ['config', '--get', 'http.proxy'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return '' }
})()

const proxyTarget = (() => {
  if (proxyUrl === '') return null
  try {
    const parsed = new URL(proxyUrl)
    return [parsed.hostname, Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)]
  } catch { return null }
})()

// net.connect 是异步的，而脚本其余部分是同步的。用 Atomics.wait 阻塞等结果：
// 端口通不通在 400ms 内必有结论，比让 git 自己超时 20 秒快得多。
const probePort = ([host, port], timeout = 400) => {
  if (!host || !port) return false
  const gate = new Int32Array(new SharedArrayBuffer(4))
  const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0) }
  let ok = false
  const socket = connect({ host, port })
  socket.setTimeout(timeout)
  socket.once('connect', () => { ok = true; socket.destroy(); release() })
  socket.once('timeout', () => { socket.destroy(); release() })
  socket.once('error', () => { socket.destroy(); release() })
  Atomics.wait(gate, 0, 0, timeout + 200)
  return ok
}

const hasSshRemote = git('remote').split('\n').includes('ssh')
const pushVia = remote => {
  execFileSync('git', ['push', remote, branch], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
}
const failureText = error => [String(error.stdout ?? ''), String(error.stderr ?? '')].join('\n').trim()

// 推成功后把 origin/* 跟踪引用对齐。ssh 远端配了 remote.ssh.fetch 指向
// refs/remotes/origin/*，跑一次 fetch 就同步；失败也不影响已完成的推送。
const syncTrackingRefs = () => {
  try {
    execFileSync('git', ['fetch', '--quiet', hasSshRemote ? 'ssh' : 'origin'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch { /* 引用滞后只影响下次的 ahead 计数，不影响正确性 */ }
}

const pushViaSsh = () => {
  console.log('  走 ssh 远端（ssh.github.com:443，不依赖代理）')
  try {
    pushVia('ssh')
  } catch (sshError) {
    const sshDetail = failureText(sshError)
    if (sshDetail) console.error(sshDetail)
    if (/Permission denied \(publickey\)/.test(sshDetail)) {
      console.error('\n✗ ssh 远端没有登记公钥。把下面这把公钥加到 GitHub（Settings → SSH keys）：')
      console.error(`  ${path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ssh', 'id_ed25519_provider_hub.pub')}`)
      console.error('  https://github.com/settings/ssh/new')
    }
    console.error('\n提交已经存在本地，通路恢复后直接 git push 即可，不用重跑本脚本。')
    process.exit(1)
  }
  syncTrackingRefs()
  console.log(`  → 推送了 ${ahead} 个提交（ssh over 443）`)
}

// ahead 用本地 HEAD 与 origin 跟踪引用比。代理关着时 origin/main 可能是旧的，
// 数字偏大不影响「要不要推」的判断（非 0 就推）。
const ahead = Number(git('rev-list', '--count', `origin/${branch}..HEAD`))
step(`推送 origin/${branch}`)
if (ahead === 0) {
  console.log('  已经在远端，无需推送')
  process.exit(0)
}

const proxyUp = proxyTarget === null ? true : probePort(proxyTarget)

if (proxyTarget !== null && !proxyUp) {
  console.log(`  代理 ${proxyUrl} 连不上，跳过 HTTPS`)
  if (hasSshRemote) {
    pushViaSsh()
  } else {
    console.error('\n✗ 代理没开，也没有配 ssh 远端 —— 提交已经在本地。')
    console.error('  要么开代理，要么加一条 ssh 备选通路：')
    console.error('    git remote add ssh git@github.com:<owner>/<repo>.git')
    process.exit(1)
  }
} else {
  try {
    pushVia('origin')
    console.log(`  → 推送了 ${ahead} 个提交（https）`)
  } catch (error) {
    const detail = failureText(error)
    const networkDown = /Could not connect to server|unable to access|Connection (timed out|refused)|Failed to connect/i.test(detail)

    if (networkDown && hasSshRemote) {
      console.log('  HTTPS 不通，改用 ssh 远端重试')
      pushViaSsh()
    } else {
      if (detail) console.error(detail)
      if (networkDown) {
        console.error('\n✗ 连不上 github.com —— 提交已经存在本地，网络恢复后直接 git push 即可，不用重跑本脚本。')
        if (proxyTarget === null) {
          console.error('  当前没有配代理。本机到 github.com:443 时通时不通：')
          console.error('    git config http.proxy http://127.0.0.1:7890')
        } else {
          console.error(`  当前代理 ${proxyUrl}，确认它开着：curl -x ${proxyUrl} -I https://github.com`)
        }
        if (!hasSshRemote) console.error('  也可以加一条 ssh 备选通路：git remote add ssh git@github.com:<owner>/<repo>.git')
      } else if (/Authentication failed|could not read Username|403/i.test(detail)) {
        console.error('\n✗ 凭据被拒。token 可能过期了，重填：')
        console.error("  printf 'protocol=https\\nhost=github.com\\nusername=Jeremy88940366\\npassword=<token>\\n\\n' | git credential approve")
      }
      process.exit(1)
    }
  }
}

step('完成')
console.log(`  ${version} 已推送 origin/${branch}`)
console.log('  提醒：本机 profile 里的副本是 file: 依赖的拷贝，不是软链；')
console.log('        改了源文件要 cp 到 profiles/desktop/node_modules/dsh-provider-hub/ 再刷新页面。')
