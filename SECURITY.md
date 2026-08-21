# 安全策略 / Security Policy

## 支持范围

当前只为最新 GitHub Release 和仓库默认分支提供安全修复。DeepSeek Harness 仍处于 developer preview；报告时请注明准确的 DSH、Node.js 和插件版本。

## 报告漏洞

不要在公开 Issue 中发布可用的利用代码、凭据、完整会话内容、持久化 marker 内容或未经脱敏的路径。

优先使用本仓库的 GitHub **Private vulnerability reporting / Security advisory**。如果该入口尚未启用，请建立一个不含利用细节的普通 Issue，请求维护者提供私下联络方式。

特别需要私下报告的问题包括：绕过用户授权触发重启、普通崩溃形成自动重启循环、跨会话错误续接、marker 被篡改、状态接口泄漏信息，或在没有新 bootId 时错误报告成功。

---

Only the latest GitHub Release and the default branch receive security fixes. Never post exploits, credentials, full session content, restart markers, or unredacted paths publicly. Prefer GitHub private vulnerability reporting; if unavailable, open a detail-free issue asking for a private contact channel.

Privately report authorization bypass, restart loops from ordinary crashes, cross-session continuation, marker tampering, status-data disclosure, or false success without a new bootId.
