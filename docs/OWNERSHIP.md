# 维护说明

这是 Provider Hub 的个人维护分支。本文件记录「哪些是我们自己的改动」以及「怎么把上游的更新吸进来」。

## 与上游的关系

上游：`Ebony-Vinyl/dsh-our-free-model`（MIT）。

本仓库 = 上游 + 一套**机械的改名映射** + 少量真实改动。实测我们的源码里约 99.7% 的行等于「上游原文套上改名映射」的结果，真正属于我们自己的改动只有几十行。这个比例是「能持续吸收上游优点」的前提：差异越机械，越能自动合并。

## 同步上游更新

```bash
git fetch upstream --tags        # 首次：git remote add upstream https://github.com/Ebony-Vinyl/dsh-our-free-model.git
node scripts/sync-upstream.mjs --list        # 看有哪些新版本
node scripts/sync-upstream.mjs               # 试运行，只看会改什么
node scripts/sync-upstream.mjs --apply       # 真正写入
```

它做的事：把上游「基线版本」和「目标版本」**都套上同一个改名映射**，再和我们的文件做三路合并（`git merge-file`）。所以上游的功能改动会进来，而我们的改动（删掉的推广页、赞助条、公告中心，以及保留下来的渠道）不会被冲掉。

- **基线**记在 `sync-base.json`，只在无冲突且 `--apply` 成功后才推进。
- **冲突**会以 `<<<<<<<` 标记写进文件，脚本退出码 2。解决完再跑一次。
- **永远保留本地版本**的文件（写在脚本的 `KEEP_OURS`）：`README.md`、`package.json`、`feed/manifest.json`、`cordis.patch.yml`、`LICENSE`。上游对它们的改动只在报告里列出，不会覆盖。
- **不跟随上游的路径**（`SKIP_PATHS`）：`.github/`、`packages/standalone/`、`catalog/`、`docs/`、`scripts/`（上游的测试脚本）、`feed/announcements.json`、`src/sponsor.*`、`src/feed.js`、`src/picks.js`。

## 改名映射

定义在 `scripts/sync-upstream.mjs` 的 `RENAME` 数组里，顺序敏感（长的先替换）。改动任何标识时，**这里必须同步更新**，否则下次同步会把上游的旧名字带回来。

| 上游 | 本仓库 |
|---|---|
| `dsh-our-free-model` | `dsh-provider-hub` |
| `our-free-model` | `provider-hub` |
| `Our Free Model` / `our free model` | `Provider Hub` / `provider hub` |
| `OFM_*` / `OUR_FREE_MODEL_*` | `HUB_*` / `PROVIDER_HUB_*` |
| `Ebony-Vinyl` | `Jeremy88940366` |

CSS 类名前缀 `ofm_`（1501 处）**故意保留不改**——纯视觉，不影响任何功能，改了只会让上游 diff 变大。

## 本仓库自己的改动（相对上游 v2.5.7）

1. **改名**：包名、插件 id、API 路由、数据目录、界面标题、环境变量前缀、仓库 slug。
2. **移除推荐项目页**（3.1.0）：上游作者的另外几个仓库的推广卡片与 star 统计。
3. **移除赞助条**（3.2.0）：`src/sponsor.js` 死文件 + `client.js` 里内联的邀请码链接、24 KB base64 logo、CSS 与文案。
4. **移除公告中心**（3.2.0）：本仓库不发布公告，`feed/` 里没有 `announcements.json`，原实现每 30 分钟拉一次注定 404 的地址。一次性欢迎弹窗（`ann.*`）与 `/announcements` 路由保留。
5. **保留 WorkBuddy / CodeBuddy 渠道**：上游 2.5.8 以合规原因移除了这两个渠道，本分支保留，并补齐了直连路径的腾讯渠道内容指纹清洗（`vendor/channel-pack/pack.js` 的 `sanitizeTencentMessages`）。
6. **移植上游 2.5.8 的三项更新机制改动**：更新失败重试（备份目录重命名重试 + 复用已校验暂存）、转发/网关保留 `reasoning_content`（含单个空格占位）、Qoder 思考档位按强度排序。
7. **签名信任根换成自己的**：`feed/manifest.json` 用本仓库 `keys/manifest-ed25519-private.pem` 签名，公钥 pin 在 `src/updater.js` 的 `PINNED_MANIFEST_PUBLIC_KEY`。上游的清单在本仓库验不过（这是有意的）。

## 发版

```bash
# 1. 改 package.json 的 version
# 2. 重签清单（会校验文件树与签名）
node scripts/sign-release.mjs --notes "这一版改了什么"
# 3. 提交推送
git add -A && git commit -m "x.y.z: ..." && git push
```

`sign-release.mjs` 会：

- 展开 `package.json` 的 `files[]` 白名单（目录递归，跳过点文件），自动补 `package.json`；
- 逐文件算 sha256，超过 80 文件或单文件超 4 MiB 直接报错；
- 用 `scripts/sign-release.mjs` 默认私钥（`~/.dsh/provider-hub/keys/manifest-ed25519-private.pem`，可用 `--key` 或 `$HUB_MANIFEST_KEY` 覆盖）签名；
- **签名前先走一遍安装端的解析路径**（`parseManifest` → `verifyManifestSignature`），落盘后再回读复验，任一步失败即退出非零。

⚠️ 签名端和验证端的载荷必须一致：`parseManifest` 会把 `publishedAt` 从 ISO 字符串归一成毫秒数，所以必须**先归一化再签**（脚本里已处理，改脚本时别破坏这一点）。

## 数据目录

`~/.dsh/provider-hub/`：`settings.json`、`stats.json`、`catalog.json`、`availability.json`、`feed.json`、`keys/`。

渠道账号与凭据不在这个目录里：账号在 `~/.dsh/channel-pack/state.json`，凭据在 `~/.dsh/.credentials.yaml`。
