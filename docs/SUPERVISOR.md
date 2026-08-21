# DSH 重启监督器契约

[中文](#中文) | [English](#english)

## 中文

`dsh-restart-resume` 负责安全地请求退出，但只有外部监督器能在进程结束后重新拉起 DSH。监督器是使用本插件的必要条件，不是可选优化。

### 必须满足的契约

每次启动前，监督器必须：

1. 校验准备启动的 DSH 运行版本；
2. 设置 `DSH_RESTART_SUPERVISOR=1`；
3. 把实际校验的版本写入 `DSH_RUNTIME_VERSION`；
4. 为这一次进程生成全新的 `DSH_BOOT_ID`；
5. 只在进程退出码为 75 时重新拉起；
6. 对一定时间窗口内的重启次数设置上限；
7. 普通退出、崩溃或版本不匹配时停止并向用户报告。

不能复用 bootId，也不能仅依靠“端口重新可用”判断重启成功。插件和 Web 端会用新 bootId 区分真正的新进程与旧实例或竞态拉起的第二个实例。

> 长驻监督器注意：`DSH_RUNTIME_VERSION` 必须在**每次拉起前**重新校验并刷新，而不是只在监督器进程启动时写一次。监督器可能跨过 bin.js 的升级/回滚而持续存活，子进程继承的是监督器进程的环境变量；只在启动时写一次会让 `dsh_restart_status` 在升级后仍报告旧版本号。示例脚本在循环内每次拉起前都重新校验并刷新该值。

### PowerShell 示例

仓库提供了不含本机固定路径的 [`examples/supervise-dsh.ps1`](../examples/supervise-dsh.ps1)。使用源码构建的 DSH 时：

```powershell
.\examples\supervise-dsh.ps1 `
  -DshCliPath 'D:\path\to\deepseek-harness\apps\cli\lib\bin.js' `
  -WorkspacePath 'D:\path\to\your\workspace' `
  -ExpectedVersion '0.1.1-rc.1'
```

请把两个路径替换成用户自己的实际路径，并把 `ExpectedVersion` 显式设为实际构建的版本（该参数为必填，避免默认值随 DSH 升级而过时）。脚本没有假设盘符、用户名或插件安装目录；它校验 CLI 版本、按进程生成 bootId，并在 10 分钟内最多接受 3 次退出码 75 的重启请求。

若使用全局或 npx 安装的 DSH，可沿用同一协议，但应让监督器调用经过版本校验的固定 CLI 入口，不要在每次重启时解析浮动的 latest 版本。

> Windows PowerShell 5.1 注意：解析 CLI 版本时**不要**用 `(& node ... | Select-Object -First 1)`——该写法会提前终止管道并结束上游 node 进程，使 `$LASTEXITCODE` 变为 `-1`，导致版本校验恒失败。示例脚本已改用无管道写法 `((& node ...) -join '').Trim()`。验证脚本逻辑须用 `powershell.exe`（5.1）而非 pwsh 7（后者无此问题，会漏检）。

### 验收清单

- 第一次启动后，`dsh_restart_status` 返回 `supervisorReady: true`。
- `runtimeVersion` 与启动器校验的版本一致。
- 每次真实重启后的 `bootId` 与重启前不同。
- 退出码 75 会重新拉起；其他非零退出码不会自动循环。
- 连续请求超过频率限制时，监督器停止并报告。
- 状态达到 `resumed` 后 Web 自动刷新，不需要普通用户手动刷新。
- 取消请求后状态条在短暂终止确认后消失。
- 删除或破坏续接 marker 时，插件报告失败而不是成功。

### 常见错误

- 直接运行 `dsh web`：进程退出后无人拉起，插件会提前拒绝。
- 把 `DSH_BOOT_ID` 写成固定值：无法证明新实例，恢复不会被认定为成功。
- 对所有崩溃无条件重启：会把程序错误放大为无限循环。
- 同时运行两个监督器：可能产生两个后端实例和端口竞态。
- 监督器启动浮动版本：重启前后运行时不一致，续接结论不可信。

## English

`dsh-restart-resume` requests a safe exit; only an external supervisor can relaunch DSH afterward. The supervisor is required.

Before every launch, it must verify the runtime version, set `DSH_RESTART_SUPERVISOR=1`, expose that checked version as `DSH_RUNTIME_VERSION`, generate a fresh `DSH_BOOT_ID`, relaunch only for exit code 75, and cap restart frequency. Normal exits, crashes, and version mismatches must stop.

A long-lived supervisor must re-verify and re-stamp `DSH_RUNTIME_VERSION` on **every** launch, not only when the supervisor process starts. The supervisor can outlive a bin.js upgrade/rollback and its child processes inherit its environment, so a boot-time-only write would make `dsh_restart_status` report a stale version after an upgrade.

Use the path-neutral [`examples/supervise-dsh.ps1`](../examples/supervise-dsh.ps1):

```powershell
.\examples\supervise-dsh.ps1 `
  -DshCliPath 'D:\path\to\deepseek-harness\apps\cli\lib\bin.js' `
  -WorkspacePath 'D:\path\to\your\workspace' `
  -ExpectedVersion '0.1.1-rc.1'
```

Replace both paths with the user's actual locations and set `ExpectedVersion` explicitly (it is mandatory, so it cannot drift from the actual build). Do not reuse boot IDs, treat port availability as proof of a new process, restart ordinary crashes, resolve a floating latest CLI on every launch, or run two supervisors for the same Web instance.

> Windows PowerShell 5.1 note: do **not** resolve the CLI version with `(& node ... | Select-Object -First 1)` — it terminates the pipeline early and ends the upstream node process, making `$LASTEXITCODE` report `-1` and failing the version check even when the strings match. The example script uses the no-pipe form `((& node ...) -join '').Trim()`. Verify supervisor logic under `powershell.exe` (5.1), not pwsh 7 (which does not reproduce the issue).

Acceptance requires `supervisorReady: true`, the checked runtime version, a new bootId after restart, relaunch only on 75, rate-limit enforcement, durable same-session continuation, automatic Web reload after `resumed`, complete banner removal after cancellation, and truthful failure when continuation cannot be verified.
