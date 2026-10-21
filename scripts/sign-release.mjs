#!/usr/bin/env node
/**
 * 生成本仓库自己的发布清单 feed/manifest.json，并用本机私钥签名。
 *
 * 这是 fork 之后最关键的一步：provider-hub 的自更新管线只认
 * 「用 PINNED_MANIFEST_PUBLIC_KEY 对应的私钥签过名的清单」。换了私钥，
 * 就只有你能发版 —— 上游的清单、CDN 镜像、任何人伪造的 maxnifest 都验不过。
 *
 * 用法：
 *   node scripts/sign-release.mjs                    生成 feed/manifest.json
 *   node scripts/sign-release.mjs --notes notes.md   附上发布说明
 *   node scripts/sign-release.mjs --check            校验现有清单与文件树一致
 *
 * 私钥查找顺序：--key 参数 → $HUB_MANIFEST_KEY → ~/.dsh/provider-hub/keys/manifest-ed25519-private.pem
 * 私钥永远不要提交进仓库（.gitignore 已排除 *.pem）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 签名端与验证端必须走同一份规范化代码。`downloadManifest` 拿到文本后先
// `parseManifest()` 再 `verifyManifestSignature()`，而 parseManifest 会把
// publishedAt 从 ISO 字符串转成毫秒数字、把 notes 截到 32 KiB、把 files 逐条
// 规范化。若签名时按「未解析的原始对象」算载荷，验证端算出来的就是另一份
// 字节，签名永远验不过 —— 症状是四个源全报 "manifest signature missing or
// not made with the release key"。
import { parseManifest, signManifest, stableStringify, PINNED_MANIFEST_PUBLIC_KEY } from '../src/updater.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MANIFEST = path.join(ROOT, 'feed', 'manifest.json')
const MAX_FILES = 80

function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** 展开 package.json files[] → 相对路径列表（目录递归，跳过点文件） */
function collect() {
  const out = []
  const walk = rel => {
    const abs = path.join(ROOT, rel)
    const st = fs.statSync(abs)
    if (st.isFile()) { out.push(rel); return }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      walk(`${rel}/${entry.name}`)
    }
  }
  const declared = Array.isArray(pkg.files) ? pkg.files : []
  if (declared.length === 0) throw new Error('package.json 里没有 files[] 白名单，拒绝生成清单')
  for (const entry of declared) {
    const rel = String(entry).replace(/\\/g, '/').replace(/\/+$/, '')
    if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`files[] 里的 ${rel} 不存在`)
    walk(rel)
  }
  // package.json 必须在清单里（updater 强制要求）
  if (!out.includes('package.json')) out.push('package.json')
  return [...new Set(out)].sort()
}

function buildFiles() {
  return collect().map(rel => {
    const bytes = fs.readFileSync(path.join(ROOT, rel))
    return { path: rel, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  })
}

const checking = process.argv.includes('--check')
const files = buildFiles()

if (files.length > MAX_FILES) {
  console.error(`✗ 清单 ${files.length} 个文件，超过 updater 的 ${MAX_FILES} 上限 —— 安装端会直接拒收。`)
  process.exit(1)
}
const oversized = files.filter(f => f.size > 4 * 1024 * 1024)
if (oversized.length > 0) {
  console.error(`✗ 超过单文件 4 MiB 上限：${oversized.map(f => f.path).join(', ')}`)
  process.exit(1)
}

if (checking) {
  const current = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  const same = stableStringify(current.files) === stableStringify(files)
  const versionSame = current.version === pkg.version
  console.log(`${same ? '✓' : '✗'} 文件清单与 feed/manifest.json ${same ? '一致' : '不一致'}`)
  console.log(`${versionSame ? '✓' : '✗'} 清单版本 ${current.version} / package.json ${pkg.version}`)
  process.exit(same && versionSame ? 0 : 1)
}

const keyPath = argOf('--key')
  ?? process.env.HUB_MANIFEST_KEY
  ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'provider-hub', 'keys', 'manifest-ed25519-private.pem')
if (!fs.existsSync(keyPath)) {
  console.error(`✗ 找不到私钥：${keyPath}`)
  process.exit(1)
}

const notesPath = argOf('--notes')
const notes = notesPath && fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : ''

const draft = {
  version: pkg.version,
  base: '../',
  publishedAt: new Date().toISOString(),
  notes,
  minSupported: pkg.minSupported ?? undefined,
  files,
}

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath))

// 关键：先跑一遍 parseManifest，拿到验证端将会看到的那份对象，再对**它**签名。
// parseManifest 会改写 publishedAt（ISO 字符串 → 毫秒数字）、截断 notes、规范化
// files；对草稿签名会让安装端算出的载荷与签名时的不同，四个源全验不过。
// 注意落盘的仍是草稿形态（publishedAt 是 ISO 字符串）—— 安装端读回后 parseManifest
// 又会把它变成同一个毫秒数，签名才对得上。
const normalized = parseManifest(draft)
const manifest = { ...draft, signature: signManifest(normalized, privateKey) }

// 自检：用源码里 pin 的公钥、按安装端的路径（parseManifest → verifyManifestSignature）
// 验一遍。不能自己拼 crypto.verify —— verifyManifestSignature 会先用
// signaturePayload() 把对象裁剪到 SIGNED_FIELDS 再算载荷，手搓容易把 signature
// 字段也算进去，得到假的失败。
const { verifyManifestSignature } = await import('../src/updater.js')
if (!verifyManifestSignature(parseManifest(manifest), PINNED_MANIFEST_PUBLIC_KEY)) {
  console.error('✗ 签出来的清单用源码里 pin 的公钥验不过 —— 私钥和公钥不是一对')
  process.exit(1)
}

fs.mkdirSync(path.dirname(MANIFEST), { recursive: true })
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')

// 落盘后再按安装端的真实路径验一次：读回文件 → parseManifest → verifyManifestSignature
const roundTrip = parseManifest(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')))
if (!verifyManifestSignature(roundTrip, PINNED_MANIFEST_PUBLIC_KEY)) {
  console.error('✗ 落盘后回读验签失败 —— 清单一旦推送，安装端也会拒绝')
  process.exit(1)
}

console.log(`✓ feed/manifest.json 已生成，且按安装端路径（parseManifest → verify）验签通过`)
console.log(`  版本   ${manifest.version}`)
console.log(`  文件   ${manifest.files.length} 个 / ${(manifest.files.reduce((n, f) => n + f.size, 0) / 1024).toFixed(1)} KiB`)
console.log(`  签名   ${manifest.signature.slice(0, 24)}…`)
console.log(`  公钥   ${PINNED_MANIFEST_PUBLIC_KEY}`)
