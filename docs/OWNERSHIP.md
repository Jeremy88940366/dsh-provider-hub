# 维护说明

这是 Provider Hub 的个人维护分支。本文件记录「哪些是我们自己的改动」以及「怎么把上游的更新吸进来」。

## 与上游的关系

上游：`Ebony-Vinyl/dsh-our-free-model`（MIT）。

本仓库 = 上游 + 一套**机械的改名映射** + 少量真实改动。实测我们的源码里约 99.7% 的行等于「上游原文套上改名映射」的结果，真正属于我们自己的改动只有几十行。这个比例是「能持续吸收上游优点」的前提：差异越机械，越能自动合并。

## 同步上游更新

先看上游走到哪了 —— 这条不需要代理，也不需要 clone：

```bash
npm run upstream:check          # 人读
npm run upstream:json           # 给脚本用
node scripts/check-upstream.mjs --quiet   # 只在有更新时输出，退出码 1 = 有更新
```

它走 `api.github.com`，列出上游最新 tag、`main` 上未发版的提交、以及从我们的基线到最新版之间的**文件级**改动，并按下面的 SKIP_PATHS / KEEP_OURS 分成「要合并 / 保留本地 / 已跳过」三组。插件界面里同一个结论显示在「升级」页底部的「上游 OFM 同步状态」面板，跟着 `updateCheckHours` 的节奏自动刷新，也可以按「检查上游」立刻查一次。

> 为什么不用 `git fetch upstream`：那条路走 `github.com:443`，代理一关就断。`api.github.com` 是直连的。

确认有更新后再同步：

```bash
git fetch upstream --tags        # 首次：git remote add upstream https://github.com/Ebony-Vinyl/dsh-our-free-model.git
node scripts/sync-upstream.mjs --list        # 看有哪些新版本
node scripts/sync-upstream.mjs               # 试运行，只看会改什么
node scripts/sync-upstream.mjs --apply       # 真正写入
```

它做的事：把上游「基线版本」和「目标版本」**都套上同一个改名映射**，再和我们的文件做三路合并（`git merge-file`）。所以上游的功能改动会进来，而我们的改动（删掉的推广页、赞助条、公告中心，以及保留下来的渠道）不会被冲掉。

- **基线**记在 `sync-base.json`，只在无冲突且 `--apply` 成功后才推进。界面上的「我们的基线」读的就是它。
- **冲突**会以 `<<<<<<<` 标记写进文件，脚本退出码 2。解决完再跑一次。
- **永远保留本地版本**的文件（`KEEP_OURS`）：`README.md`、`package.json`、`feed/manifest.json`、`cordis.patch.yml`、`LICENSE`。上游对它们的改动只在报告里列出，不会覆盖。
- **不跟随上游的路径**（`SKIP_PATHS`）：`.github/`、`packages/standalone/`、`catalog/`、`docs/`、`scripts/`（上游的测试脚本）、`feed/announcements.json`、`src/sponsor.*`、`src/feed.js`、`src/picks.js`。

这两份清单在 `src/upstream-track.js` 里有一份副本（`SKIP_PATHS` / `KEEP_OURS`），供界面与 CLI 分组用。`npm run test:upstream` 会校验它们与 `scripts/sync-upstream.mjs` 一致 —— 不一致时界面会宣称有 N 个文件要处理，而合并时全被跳过。

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
8. **移植上游 main 的两个界面性能提交**（3.7.4，对应 `f0973303` 与 `f0e90532`）：
   - 装饰特效开关：导航右侧新增 `Switch`，把选择写进 `localStorage` 的 `ofm.visualEffects`，根节点挂 `data-ofm-effects`。默认 **关闭**——光晕、毛玻璃、装饰动画都是可选装饰。`data-ofm-effects="off"` 的 CSS 用 `:not(.ofm_tank):not(.ofm_tank *)` 把鱼缸排除在外，所以水波/气泡/鱼不受影响；纯布局用的 `transform` 也不动。
   - 页面休眠：根节点挂 `data-ofm-active`，由 `document.visibilitychange` 与 `IntersectionObserver` 共同驱动，任一条件为「不可见」就暂停全部动画。
   - 鱼缸休眠：`Tank` 挂 `data-ofm-motion`，空缸（`pct` 为 0）或滚出视口时停掉三条无限循环动画，重新可见或有水量时恢复，卸载时 `disconnect()`。
   - 上游这两处改的是 `useCountUp`/`RecoCard`/`PicksPage` 的调用点，本仓库没有推荐页，故未带过来；开关控件复用本仓库已有的 `Switch`（`client.js` 里原本就有 `ofm_switch` 样式）。
   - 回归测试：`npm run test:ui`（`scripts/plugin-ui-test.mjs`，headless 渲染 `Tank` 与 `Shell`，9 条断言）。
9. **上游版本追踪**（3.7.13）：`src/upstream-track.js` 走 `api.github.com` 查上游最新 tag、`main` 未发版提交与基线间的文件级差异，结果落 `upstream-state.json`；界面在「升级」页底部显示（`UpstreamPanel`），另有 `npm run upstream:check` 的 CLI 版本。判定逻辑只有 `summarizeUpstream()` 一处，CLI 与界面共用。回归测试：`npm run test:upstream`。

## 发版

一条命令：

```bash
npm run ship -- "3.7.5: 改了什么"
```

它按顺序做三件事，任一步失败就停在那里，不会留下半成品：

1. **改版本号** —— patch 位自动 +1。要跳 minor/major，自己改好 `package.json` 再走 `--no-bump`。
2. **重签清单** —— 调 `scripts/sign-release.mjs`。文件树和版本号都没变时会跳过（否则 `publishedAt` 每次都变，空改动也会产生一个只有时间戳差异的提交）。
3. **提交 + 推送** —— `git add -A`、`commit`、`push origin main`。

常用变体：

```bash
npm run ship -- --dry-run "..."    # 只跑到提交为止，不推送
npm run ship -- --no-bump "..."    # 版本号已经改好了
npm run ship -- --notes notes.md "..."  # 发布说明写进清单的 notes 字段
npm run sign:check                 # 只检查现有清单与文件树是否一致
```

发版前的检查（任一不满足即中止，避免把仓库搞成半发状态）：当前必须是 `main` 分支、没有 rebase/merge/cherry-pick 残留、`user.name` 与 `user.email` 已配置。

**为什么必须重签**：`feed/manifest.json` 里每个文件的 sha256 是自更新通道的校验依据。只 `git push` 不重签，push 会成功，但别的机器拉更新时逐文件校验对不上，整次更新被静默拒收 —— 不报错，只在安装端日志里留一行校验失败。`ship.mjs` 就是把这个坑堵死。

### 手动发版（脚本坏掉时的退路）

```bash
node scripts/sign-release.mjs --notes "这一版改了什么"
git add -A && git commit -m "x.y.z: ..." && git push
```

`sign-release.mjs` 会：

- 展开 `package.json` 的 `files[]` 白名单（目录递归，跳过点文件），自动补 `package.json`；
- 逐文件算 sha256，超过 80 文件或单文件超 4 MiB 直接报错；
- 用默认私钥（`~/.dsh/provider-hub/keys/manifest-ed25519-private.pem`，可用 `--key` 或 `$HUB_MANIFEST_KEY` 覆盖）签名；
- **签名前先走一遍安装端的解析路径**（`parseManifest` → `verifyManifestSignature`），落盘后再回读复验，任一步失败即退出非零。

⚠️ 签名端和验证端的载荷必须一致：`parseManifest` 会把 `publishedAt` 从 ISO 字符串归一成毫秒数，所以必须**先归一化再签**（脚本里已处理，改脚本时别破坏这一点）。

### 推送凭据

仓库的 local config 指向 `credential.helper = store --file=C:/Users/Administrator/.dsh/provider-hub/git-credentials`，token 存在仓库**外面**（`*.pem` 之外也没进版本库）。全局配置里的 `gh auth git-credential` 用不了 —— 那个 token 缺 `read:org` scope，`gh` 拒绝加载。

凭据失效时（token 过期/撤销）：

```bash
printf 'protocol=https\nhost=github.com\nusername=Jeremy88940366\npassword=<新 token>\n\n' | git credential approve
```

### 网络：必须走代理

本机到 `github.com:443` **时通时不通**，而 `api.github.com`、`codeload.github.com`、`raw.githubusercontent.com` 一直正常 —— 所以「浏览器能打开 GitHub 页面」不代表能推。git 走的是 `github.com:443` 的 `git-receive-pack`，正好落在不通的那条路上。

仓库 local config 已固定代理：

```bash
git config http.proxy http://127.0.0.1:7890
git config https.proxy http://127.0.0.1:7890
```

系统代理（注册表 `ProxyEnable=1`、`ProxyServer=127.0.0.1:7890`）本来就是开的，但 git 不读 Windows 系统代理，必须单独配。

代理没开时 `git push` 报 `Failed to connect to github.com:443`；`ship.mjs` 会区分「连不上」和「凭据被拒」，并提示提交已经在本地、网络恢复后直接 `git push` 即可。

### 备选通路：SSH over 443

`github.com:443` 不稳，但 `ssh.github.com:443` 的 TCP 一直通，而且 SSH 不走 `http.proxy`（自己出网），所以它不依赖代理。仓库里已加好第二条远端：

```bash
git remote add ssh git@github.com:Jeremy88940366/dsh-provider-hub.git
```

`~/.ssh/config` 把 `github.com` 映射到 `ssh.github.com:443`：

```
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519_provider_hub
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
```

`ship.mjs` 的行为：先花 400ms 探代理端口 —— 连不上就直接走 `ssh`（不再干等 git 自己超时 20 秒）；代理活着就试 `origin`（HTTPS），失败再降级到 `ssh`。推成功后跑一次 `git fetch ssh` 把 `origin/*` 跟踪引用对齐（`remote.ssh.fetch` 已配成 `+refs/heads/*:refs/remotes/origin/*`），否则代理关着时 `origin/main` 是旧的、`ahead` 计数会虚高。

`origin` 保持 HTTPS 不变，`fetch` 仍走代理 —— 只有推送会切通路。**代理关着也能正常发版**。

首次使用前要把公钥登记到 GitHub（Settings → SSH keys，https://github.com/settings/ssh/new）：

```bash
cat ~/.ssh/id_ed25519_provider_hub.pub
ssh -T git@github.com    # 应回 "Hi Jeremy88940366! You've successfully authenticated"
```

> 本机的 OAuth token 只有 `read:user, repo, workflow` 三个 scope，**不能**通过 API 代为登记 SSH key（`POST /user/keys` 返回 404）—— 这一步只能手动在网页上做。




## 数据目录

`~/.dsh/provider-hub/`：`settings.json`、`stats.json`、`catalog.json`、`availability.json`、`feed.json`、`upstream-state.json`（上游检查的上次成功结论）、`keys/`、`git-credentials`（推送凭据，不属插件数据）。

渠道账号与凭据不在这个目录里：账号在 `~/.dsh/channel-pack/state.json`，凭据在 `~/.dsh/.credentials.yaml`。

## 本机生效

本机 DSH 用 `file:../../src/dsh-provider-hub` 引入这个仓库，而 pnpm 对 `file:` 依赖是**拷贝**不是软链 —— 改完源文件必须手动同步，否则运行的是旧代码：

```bash
cp client.js index.js package.json \
   ~/.dsh/profiles/desktop/node_modules/dsh-provider-hub/
```

客户端 bundle（`client.js`）不需要重启应用：`dsh-client-modules` 按文件 mtime/size 算 revision，刷新页面就会重读。改动 `index.js`（主进程侧）才需要重启。

