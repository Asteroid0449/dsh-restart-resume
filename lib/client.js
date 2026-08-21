window.__ModuleLoader__.load({
  id: 'dsh-restart-resume',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const API = '/restart-resume/api'
    const TRACKING_KEY = 'dsh-restart-resume:tracked-restart'
    const ACTIVE_PHASES = new Set(['scheduled', 'draining', 'countdown', 'exiting', 'booted', 'resuming'])
    const LOCALE_NS = 'dsh-restart-resume'
    const zh = {
      cancel: '取消重启', checking: '正在检查活跃工作', inspectionBlocked: '检查受阻：{error}',
      activeSessions: '{count} 个活跃会话', subagents: '{count} 个子代理', jobs: '{count} 个后台任务',
      waiting: '等待 {items}结束', drained: '所有活跃工作已排空', scheduled: 'DSH 重启已安排',
      scheduledDetail: '{seconds} 秒后开始排空；{blockers}', draining: '等待安全重启', countdown: '即将关闭 DSH',
      countdownDetail: '安全倒计时 {seconds} 秒；若出现新任务将返回排空阶段', exiting: '正在关闭后端',
      exitingDetail: '持久化屏障已通过；连接即将暂时断开', booted: '新后端已启动',
      bootedDetail: '正在等待模型服务和原会话就绪', resuming: '正在恢复原会话',
      resumingDetail: '续接消息正在写入并等待持久化', resumed: '重启与会话恢复已完成',
      resumedDetail: '即将刷新页面以载入新的插件前端', timedOut: '重启已超时取消', cancelled: '重启已取消',
      cancelledDetail: '没有终止任何活跃工作', failed: '重启协调失败', failedDetail: '请检查 DSH 日志和 pending.json',
      backendRestored: '后端已恢复', backendRestoredDetail: '正在恢复会话；完成后页面将自动刷新',
      disconnected: 'DSH 后端连接已断开', disconnectedDetail: '启动期间不可观测，正在等待状态接口恢复（第 {count} 次检查）',
    }
    const en = {
      cancel: 'Cancel restart', checking: 'Checking active work', inspectionBlocked: 'Check blocked: {error}',
      activeSessions: '{count} active session(s)', subagents: '{count} subagent(s)', jobs: '{count} background job(s)',
      waiting: 'Waiting for {items} to finish', drained: 'All active work has drained', scheduled: 'DSH restart scheduled',
      scheduledDetail: 'Draining begins in {seconds}s; {blockers}', draining: 'Waiting for a safe restart', countdown: 'DSH is about to close',
      countdownDetail: 'Safe countdown: {seconds}s; new work returns this to draining', exiting: 'Closing the backend',
      exitingDetail: 'Persistence barriers passed; the connection will briefly drop', booted: 'New backend started',
      bootedDetail: 'Waiting for the model service and original session', resuming: 'Restoring the original session',
      resumingDetail: 'Writing and persisting the continuation message', resumed: 'Restart and session restoration complete',
      resumedDetail: 'Refreshing shortly to load the new plugin frontend', timedOut: 'Restart timed out and was cancelled', cancelled: 'Restart cancelled',
      cancelledDetail: 'No active work was terminated', failed: 'Restart coordination failed', failedDetail: 'Check the DSH logs and pending.json',
      backendRestored: 'Backend restored', backendRestoredDetail: 'Restoring the session; this page will reload automatically',
      disconnected: 'DSH backend disconnected', disconnectedDetail: 'Startup is temporarily unobservable; waiting for the status API (check {count})',
    }

    function apply(ctx) {
      let decided = false
      let disposed = false
      let timer
      let failedPolls = 0
      let lastStatus
      let openedResumeToken
      let banner
      let title
      let detail
      let cancelButton
      let terminalKey
      let terminalHideTimer
      const disposeLocale = ctx.locale.register(LOCALE_NS, { zh, en })
      const t = ctx.locale.bind(LOCALE_NS)

      const ensureBanner = () => {
        if (banner) return
        banner = document.createElement('aside')
        banner.setAttribute('role', 'status')
        banner.setAttribute('aria-live', 'polite')
        Object.assign(banner.style, {
          position: 'fixed',
          zIndex: '2147483647',
          top: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(680px, calc(100vw - 32px))',
          padding: '12px 14px',
          color: '#f7f7f8',
          background: 'rgba(28, 29, 33, 0.94)',
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: '12px',
          boxShadow: '0 12px 36px rgba(0,0,0,0.35)',
          backdropFilter: 'blur(16px)',
          font: '13px/1.45 system-ui, sans-serif',
        })
        const row = document.createElement('div')
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '12px' })
        const copy = document.createElement('div')
        copy.style.flex = '1'
        title = document.createElement('strong')
        title.style.display = 'block'
        detail = document.createElement('span')
        detail.style.color = 'rgba(255,255,255,0.72)'
        cancelButton = document.createElement('button')
        cancelButton.type = 'button'
        cancelButton.textContent = t('cancel')
        Object.assign(cancelButton.style, {
          padding: '6px 10px', color: '#fff', background: 'transparent',
          border: '1px solid rgba(255,255,255,0.28)', borderRadius: '8px', cursor: 'pointer',
        })
        cancelButton.addEventListener('click', async () => {
          cancelButton.disabled = true
          try {
            const token = lastStatus?.token ?? tracked()?.token
            if (!token) return
            await fetch(`${API}/cancel`, {
              method: 'POST',
              cache: 'no-store',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token }),
            })
          }
          finally { cancelButton.disabled = false }
        })
        copy.append(title, detail)
        row.append(copy, cancelButton)
        banner.append(row)
        document.body.append(banner)
      }

      const hideBanner = () => {
        if (banner) banner.style.display = 'none'
      }

      const hideLater = (ms) => {
        clearTimeout(terminalHideTimer)
        terminalHideTimer = setTimeout(hideBanner, ms)
      }

      const show = (heading, message, cancellable = false) => {
        ensureBanner()
        banner.style.display = 'block'
        title.textContent = heading
        detail.textContent = message
        cancelButton.style.display = cancellable ? 'inline-block' : 'none'
      }

      const blockersText = blockers => {
        if (!blockers) return t('checking')
        if (blockers.inspectionError) return t('inspectionBlocked', { error: blockers.inspectionError })
        const parts = []
        if (blockers.busyAgents?.length) parts.push(t('activeSessions', { count: blockers.busyAgents.length }))
        if (blockers.activeSubagents?.length) parts.push(t('subagents', { count: blockers.activeSubagents.length }))
        if (blockers.activeJobs?.length) parts.push(t('jobs', { count: blockers.activeJobs.length }))
        return parts.length ? t('waiting', { items: parts.join(', ') }) : t('drained')
      }

      const remember = status => {
        if (!status.token || !ACTIVE_PHASES.has(status.phase)) return
        const existing = tracked()
        if (existing?.token === status.token) return
        sessionStorage.setItem(TRACKING_KEY, JSON.stringify({ token: status.token, bootId: status.bootId }))
      }

      const tracked = () => {
        try { return JSON.parse(sessionStorage.getItem(TRACKING_KEY) || 'null') }
        catch { return null }
      }

      const openRestartSession = status => {
        if (!status.token || !status.sessionId || openedResumeToken === status.token) return
        openedResumeToken = status.token
        try {
          const result = ctx.sessions.open(status.sessionId)
          Promise.resolve(result).catch(() => { openedResumeToken = undefined })
        } catch {
          openedResumeToken = undefined
        }
      }

      const render = status => {
        lastStatus = status
        cancelButton && (cancelButton.textContent = t('cancel'))
        const prior = tracked()
        remember(status)
        const bootChanged = prior?.token === status.token && prior.bootId !== status.bootId
        if (ACTIVE_PHASES.has(status.phase)) {
          terminalKey = undefined
          clearTimeout(terminalHideTimer)
        }
        switch (status.phase) {
          case 'scheduled': {
            const seconds = Math.max(0, Math.ceil((status.notBefore - status.serverTime) / 1000))
            show(t('scheduled'), t('scheduledDetail', { seconds, blockers: blockersText(status.blockers) }), true)
            break
          }
          case 'draining':
            show(t('draining'), blockersText(status.blockers), true)
            break
          case 'countdown':
            show(t('countdown'), t('countdownDetail', { seconds: status.remainingSeconds ?? '?' }), true)
            break
          case 'exiting':
            show(t('exiting'), t('exitingDetail'))
            break
          case 'booted':
            show(t('booted'), t('bootedDetail'))
            openRestartSession(status)
            break
          case 'resuming':
            show(t('resuming'), t('resumingDetail'))
            openRestartSession(status)
            break
          case 'resumed':
            if (!prior || prior.token !== status.token) {
              hideBanner()
              break
            }
            show(t('resumed'), t('resumedDetail'))
            if (bootChanged) {
              sessionStorage.removeItem(TRACKING_KEY)
              setTimeout(() => location.reload(), 900)
            } else {
              sessionStorage.removeItem(TRACKING_KEY)
              hideLater(3000)
            }
            break
          case 'timed-out':
          case 'cancelled':
            sessionStorage.removeItem(TRACKING_KEY)
            if (terminalKey === `${status.phase}:${status.token ?? ''}`) break
            terminalKey = `${status.phase}:${status.token ?? ''}`
            show(status.phase === 'timed-out' ? t('timedOut') : t('cancelled'), status.reason || t('cancelledDetail'))
            hideLater(5000)
            break
          case 'failed':
            show(t('failed'), status.error || t('failedDetail'))
            break
          default:
            if (!prior) hideBanner()
            else if (bootChanged) show(t('backendRestored'), t('backendRestoredDetail'))
        }
      }

      const poll = async () => {
        if (disposed) return
        try {
          const response = await fetch(`${API}/status`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          failedPolls = 0
          render(await response.json())
        } catch (error) {
          failedPolls += 1
          const prior = tracked()
          if (prior || ACTIVE_PHASES.has(lastStatus?.phase)) {
            show(t('disconnected'), t('disconnectedDetail', { count: failedPolls }))
          }
        } finally {
          if (!disposed) {
            const active = tracked() || ACTIVE_PHASES.has(lastStatus?.phase)
            timer = setTimeout(poll, active ? 500 : 1500)
          }
        }
      }

      const openMostRecent = () => {
        if (decided) return
        const snapshot = ctx.sessions.list.getSnapshot()
        if (snapshot.phase !== 'ready') return
        decided = true
        if (snapshot.current === undefined && snapshot.ids.length > 0) ctx.sessions.open(snapshot.ids[0])
      }

      ctx.effect(() => {
        const unsubscribe = ctx.sessions.list.subscribe(openMostRecent)
        const unsubscribeLocale = ctx.locale.subscribe(() => {
          if (!lastStatus) return
          if (banner?.style.display !== 'none' && ['cancelled', 'timed-out'].includes(lastStatus.phase)) terminalKey = undefined
          render(lastStatus)
        })
        queueMicrotask(openMostRecent)
        void poll()
        return () => {
          disposed = true
          unsubscribe()
          unsubscribeLocale()
          disposeLocale()
          clearTimeout(timer)
          clearTimeout(terminalHideTimer)
          banner?.remove()
        }
      }, 'dsh-restart-resume: status banner and session restoration')
    }

    exports.apply = apply
    exports.inject = ['sessions', 'locale']
    return module.exports
  },
})
