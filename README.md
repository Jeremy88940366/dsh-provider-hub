# Provider Hub

> WIP

在 DeepSeek Harness 里管理模型渠道：账号渠道登录与账号池、匿名免费车道、积分领取、
本地 OpenAI 兼容网关、局域网转发、用量看板与运行日志。

## 安装

```
dsh plugin install file:/path/to/dsh-provider-hub --profile desktop
```

或手动把本目录放到 `$DSH_HOME/plugins/` 下，然后在 profile 的 `package.json` 里加一条
`"dsh-provider-hub": "file:../../src/dsh-provider-hub"`，并把 `dsh-provider-hub` 加进
`dsh.profile.bundles`。

## 说明

- 数据目录：`$DSH_HOME/provider-hub/`（设置、用量统计、模型目录缓存）。
- 更新清单：`feed/manifest.json`，Ed25519 签名，安装端用 `src/updater.js` 里 pin 的公钥验签。
- 发版：改 `package.json` 版本号 → `node scripts/sign-release.mjs --notes "..."` → commit / push。

## 许可证

MIT，见 [LICENSE](LICENSE)。
