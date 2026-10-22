# 发布维护

源码仓库：https://github.com/NekoYume517/auto-dati

## 本地打包

要求 Node.js 22+，无需安装第三方打包依赖。首次运行：

```powershell
node tools/build-release.mjs --init-key
```

签名私钥默认保存在用户目录 `.config/auto-dati/release-signing.pem`，不在仓库内。请独立备份，不要提交或附在 Release 中。以后使用同一私钥运行 `node tools/build-release.mjs`，保持发布版扩展 ID 不变。

输出位于 `dist/`：CRX3、同负载 ZIP、SHA256 校验和与公开版本信息。按 Chromium CRX3 格式签名并验签，脚本不修改源码开发版 manifest 中的 key。`--key PATH` 可指定已有私钥。

## GitHub Actions

在仓库 Settings → Secrets and variables → Actions 中配置 `CRX_PRIVATE_KEY`，内容为完整的签名 PEM 私钥（保留换行）。它只作为加密 Secret 保存，构建不会打印私钥。

1. 修改 `extension/manifest.json` 的 version，并更新 `docs/RELEASE-NOTES.md`。
2. 提交代码，再推送对应版本标签，例如 `v0.2.0`。
3. Release extension 工作流会检查标签与 manifest 一致，签名打包并发布 Release。
4. 也可通过 workflow_dispatch 手动发布当前 manifest 版本。不要用同一版本号发布不同内容；扩展按版本号比较更新。

检查更新仅请求 GitHub 的公开 Releases API。遇到网络错误、限流或仓库尚无 Release，会显示错误并允许稍后重试；不自动安装、不替换已解压的本地文件。

## 浏览器限制

打包签名不能绕过浏览器的安装策略。普通用户需要便捷安装与静默自动更新时，应发布到浏览器扩展商店。GitHub Releases 是当前项目的下载与更新提示渠道。

- https://developer.chrome.com/docs/extensions/how-to/distribute/
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/hosting-and-updating

## 仅使用 API 发布本机签名包

也可不配置服务器签名 Secret：本机打包后，将四个公开发布文件通过 Git Data API 保存在 `release-assets` 分支，并在 main 提交 `release-assets/v版本.json`，记录每个文件的 Git blob SHA 与 SHA256。此路径变更会触发 Actions；工作流下载记录中的文件、校验 SHA256 与 CRX3 签名，再用 GitHub 自带的 GITHUB_TOKEN 调用 Release API 发布。v0.2.0 使用此方式，签名私钥始终保留在本机。后续版本必须使用同一私钥重新签名，不能复用旧版本记录。
