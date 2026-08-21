# 贡献指南 / Contributing

感谢你愿意改进 dsh-restart-resume。

## 提交问题

插件自身的重启状态、监督器契约、Web 状态条或同会话续接问题请提交到本仓库 Issues。请提供：

- DSH、Node.js 和插件版本；
- 已脱敏的监督器输出；
- `dsh_restart_status` 结果与阶段时间线；
- 最小复现步骤、预期结果和实际结果。

不要公开凭据、完整会话内容或个人路径。只有确认问题属于 DeepSeek Harness 上游时，才转交官方 Discussions。

## 提交变更

1. 从最新代码创建独立分支。
2. 不得放宽退出码 75、bootId、排空、频率限制或持久化续接的安全契约。
3. 保持三个工具的名称、顺序和 schema 稳定；如需改变，说明缓存与兼容性影响。
4. Web 状态必须来自可观测事实，不得把断联或旧 bootId 表示为成功。
5. 同步更新中英文 README 和监督器文档。
6. 运行：

```powershell
npm test
npm pack --dry-run
```

PR 应说明普通用户看到的变化、失败模式、测试结果和回滚方式。

---

Thank you for improving dsh-restart-resume. Report plugin-specific problems with exact versions, redacted supervisor output, `dsh_restart_status`, and a phase timeline. Never post credentials or full session contents.

Do not weaken the exit-code-75, bootId, drain, rate-limit, or durable-continuation contracts. Keep the three tool schemas stable, derive Web state only from observed facts, update both README languages and supervisor documentation, then run `npm test` and `npm pack --dry-run`.
