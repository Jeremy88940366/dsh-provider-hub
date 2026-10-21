# 维护说明

本仓库是 `dsh-provider-hub` 的源码与发布清单，由维护者自行管理。

## 基本信息

| 项 | 值 |
|---|---|
| npm 包名 | `dsh-provider-hub` |
| 版本线 | `3.x`（独立演进） |
| 更新源 `REPO` | `Jeremy88940366/dsh-provider-hub`（可用环境变量 `HUB_REPO` 覆盖） |
| 清单签名公钥 | `MCowBQYDK2VwAyEAIWxF+wpq0X+nU+85t4HyyPBtHu+L5ru+i5JLjCobe0k=` |

自更新管线只接受用 pin 在 `src/updater.js` 里的公钥签过名的 `feed/manifest.json`。公钥为本仓库持有，私钥只在本机，**只有本仓库能给这个插件发版**。

## 运行期标识

- `export const name = 'provider-hub'` —— Cordis 插件名，补丁层按它挂配置
- `DATA_DIR_NAME = 'provider-hub'` —— 数据在 `~/.dsh/provider-hub/`（settings、feed 缓存、catalog、登录态、统计）
- 账号池在 `~/.dsh/channel-pack/state.json`，凭据在 `~/.dsh/.credentials.yaml`，与本插件目录解耦

## 私钥

```
C:\Users\Administrator\.dsh\provider-hub\keys\manifest-ed25519-private.pem   ← 私钥，0600，绝不入库
C:\Users\Administrator\.dsh\provider-hub\keys\manifest-ed25519-public.txt    ← 公钥（已固化进 src/updater.js）
```

私钥丢失 = 以后发的版装不上（需改源码里的公钥再重新分发）。建议抄一份到离线介质。

## 发版流程

1. 改代码，改 `package.json` 的 `version`。
2. 生成并签名清单：

```bash
node scripts/sign-release.mjs --notes NOTES.md
```

脚本展开 `package.json` 的 `files[]` 白名单、逐个算 SHA-256、用本机私钥签名，**再用源码里 pin 的公钥验一遍**才落盘。文件数超过 80 或单文件超过 4 MiB 会直接报错（安装端硬上限）。

3. 提交并推送：

```bash
git add -A && git commit -m "release x.y.z" && git push
```

4. 客户端「检查更新」→ 从 `feed/manifest.json` 取版本，验签通过才装。

校验已提交的清单与文件树是否一致：

```bash
node scripts/sign-release.mjs --check
```

## 许可证与来源

`LICENSE`（MIT）与 `vendor/channel-pack/NOTICE.md` 原样保留，第三方来源标注不得删除。

## 已知取舍

- 出站内容清洗已内置在 `vendor/channel-pack/pack.js`：规则表 + `sanitizeTencentMessages()`，直连与网关两条路径都接上了，并有启动自检。
- `client.js` 里保留了若干指向第三方项目的「推荐项目」卡片；与功能无关，可按需删除对应渲染。
