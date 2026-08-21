import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-restart-resume'
export const inject = ['tools', 'sessions', 'agents', 'jobs', 'subagents', 'webServer', 'llm']
export const RESTART_EXIT_CODE = 75

const STATE_VERSION = 3
const MARKER_FILE = 'pending.json'
const HISTORY_FILE = 'history.json'
const SUPERVISOR_ENV = 'DSH_RESTART_SUPERVISOR'
const BOOT_ID_ENV = 'DSH_BOOT_ID'
const RUNTIME_VERSION_ENV = 'DSH_RUNTIME_VERSION'
const API_PATH = '/restart-resume/api'
const BOOT_SYMBOL = Symbol.for('dsh-restart-resume.boot-id')
const COORDINATORS_SYMBOL = Symbol.for('dsh-restart-resume.coordinators')
const DEFAULT_RESUME_PROMPT =
  'DSH has completed the supervised restart requested by this session. The restart was a checkpoint inside the original larger user task, not the task itself. Continue the unfinished original task, including the configuration, integration, necessary verification, and deliverables that come after restart. Reuse durable results and perform only the state checks needed to proceed; do not repeat already completed broad work or expand scope. Do not stop merely after reporting that DSH restarted unless the original task is actually complete.'
const REPORT_ONLY_PROMPT =
  'DSH has completed the supervised restart requested by this session. This restart is report-only: briefly state that the restart succeeded, then stop. Do not inspect files, rerun tests, invoke tools, or continue prior work unless the user explicitly asks in a later message.'
const WEB_RECOVERY_PROMPT =
  'The DSH Web client automatically reconnects to the restored backend and reloads itself after this session is resumed. Do not ask the user to refresh merely because a restart or plugin activation occurred. Recommend a manual refresh only after a concrete post-recovery check proves that the current page is stale.'

function boundedInteger(value, fallback, name, minimum, maximum) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`dsh-restart-resume: ${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return resolved
}

function resolveStateDir(value) {
  if (value === undefined || value === '') {
    return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'restart-resume')
  }
  if (typeof value !== 'string') throw new Error('dsh-restart-resume: stateDir must be a string')
  return isAbsolute(value) ? value : resolve(value)
}

function resolveConfig(config = {}) {
  const resumePrompt = config.resumePrompt ?? DEFAULT_RESUME_PROMPT
  if (typeof resumePrompt !== 'string' || resumePrompt.trim() === '') {
    throw new Error('dsh-restart-resume: resumePrompt must be a non-empty string')
  }
  return {
    stateDir: resolveStateDir(config.stateDir),
    maxRestarts: boundedInteger(config.maxRestarts, 3, 'maxRestarts', 1, 100),
    restartWindowMs: boundedInteger(config.restartWindowSeconds, 600, 'restartWindowSeconds', 60, 86_400) * 1_000,
    resumeTtlMs: boundedInteger(config.resumeTtlSeconds, 86_400, 'resumeTtlSeconds', 300, 604_800) * 1_000,
    defaultDelaySeconds: boundedInteger(config.defaultDelaySeconds, 10, 'defaultDelaySeconds', 5, 3_600),
    drainTimeoutSeconds: boundedInteger(config.drainTimeoutSeconds, 1_800, 'drainTimeoutSeconds', 300, 86_400),
    finalCountdownSeconds: boundedInteger(config.finalCountdownSeconds, 10, 'finalCountdownSeconds', 5, 300),
    pollIntervalMs: boundedInteger(config.pollIntervalMs, 250, 'pollIntervalMs', 100, 2_000),
    resumePrompt: resumePrompt.trim(),
  }
}

function json(value) {
  return JSON.stringify(value, undefined, 2)
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function normalizeMarker(value, path) {
  if (value?.version === 1 || value?.version === 2) {
    return {
      ...value,
      version: STATE_VERSION,
      notBefore: value.notBefore ?? value.requestedAt,
      deadline: value.deadline ?? value.requestedAt + 1_800_000,
      finalCountdownSeconds: value.finalCountdownSeconds ?? 10,
      legacyIdentity: true,
      resumeMode: value.resumeMode ?? 'continue',
    }
  }
  if (value?.version !== STATE_VERSION
    || typeof value.token !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.messageId !== 'string'
    || typeof value.reason !== 'string'
    || !Number.isSafeInteger(value.requestedAt)
    || !Number.isSafeInteger(value.requestingPid)
    || typeof value.requestingBootId !== 'string'
    || value.requestingBootId.trim() === ''
    || value.requestingBootId.length > 200
    || !Number.isSafeInteger(value.notBefore)
    || !Number.isSafeInteger(value.deadline)
    || !Number.isSafeInteger(value.finalCountdownSeconds)
    || (value.afterRestart !== undefined
      && (typeof value.afterRestart !== 'string' || value.afterRestart.trim() === '' || value.afterRestart.length > 500))) {
    throw new Error(`invalid restart marker at ${path}`)
  }
  if (value.resumeMode !== undefined && value.resumeMode !== 'continue' && value.resumeMode !== 'report-only') {
    throw new Error(`invalid restart resumeMode at ${path}`)
  }
  return { ...value, resumeMode: value.resumeMode ?? 'continue' }
}

function readMarker(path) {
  if (!existsSync(path)) return undefined
  return normalizeMarker(parseJson(path), path)
}

function readHistory(path) {
  if (!existsSync(path)) return []
  const value = parseJson(path)
  if (!Array.isArray(value)
    || value.some(entry => !Number.isSafeInteger(entry?.time) || typeof entry?.sessionId !== 'string')) {
    throw new Error(`invalid restart history at ${path}`)
  }
  return value
}

function atomicCreate(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) throw new Error(`a restart request is already pending at ${path}`)
  const temporary = join(dirname(path), `.${MARKER_FILE}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${json(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (existsSync(path)) throw new Error(`a restart request is already pending at ${path}`)
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

function writeHistory(path, history) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${json(history)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function removeMarkerIfCurrent(path, token) {
  try {
    if (readMarker(path)?.token === token) rmSync(path, { force: true })
  } catch {
    // Damaged/replaced state is left for manual recovery.
  }
}

function processBootId() {
  if (typeof process.env[BOOT_ID_ENV] === 'string' && process.env[BOOT_ID_ENV] !== '') {
    return process.env[BOOT_ID_ENV]
  }
  if (!globalThis[BOOT_SYMBOL]) globalThis[BOOT_SYMBOL] = `${process.pid}-${randomUUID()}`
  return globalThis[BOOT_SYMBOL]
}

function supervisedBootId() {
  const value = process.env[BOOT_ID_ENV]
  return typeof value === 'string' && value.trim() !== '' && value.length <= 200 ? value : undefined
}

function eventCarriesMessageId(event, messageId) {
  if (event?.type === 'user/message' && event.data?.id === messageId) return true
  return event?.type === 'agent/inbox/spliced'
    && Array.isArray(event.data?.inserted)
    && event.data.inserted.some(message => message?.id === messageId)
}

function validateReason(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('reason must be a non-empty string')
  const reason = value.trim()
  if (reason.length > 500) throw new Error('reason must be at most 500 characters')
  return reason
}

function validateAfterRestart(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error('afterRestart must be a non-empty string when provided')
  const next = value.trim()
  if (next.length > 500) throw new Error('afterRestart must be at most 500 characters')
  return next
}

function supervisorReady() {
  return process.env[SUPERVISOR_ENV] === '1'
}

function log(ctx, level, message) {
  if (typeof ctx.logger?.[level] === 'function') ctx.logger[level](message)
}

function makeResumeMessage(marker, prompt) {
  const instruction = marker.resumeMode === 'report-only' ? REPORT_ONLY_PROMPT : prompt
  const next = marker.resumeMode === 'continue' && marker.afterRestart
    ? `\n\nPlanned next step inside the original task: ${marker.afterRestart}`
    : ''
  return {
    id: marker.messageId,
    role: 'user',
    content: [{ type: 'text', text: `${instruction}\n\n${WEB_RECOVERY_PROMPT}${next}\n\nRestart reason: ${marker.reason}` }],
    source: { kind: 'plugin', plugin: name },
  }
}

function delay(ms, signal) {
  return new Promise((resolveDelay, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', abort)
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      callback(value)
    }
    const timer = setTimeout(() => finish(resolveDelay), ms)
    const abort = () => {
      finish(reject, signal.reason ?? new Error('cancelled'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function sameOriginRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || /[\s\\/]/.test(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== host) return false
    } catch { return false }
  }
  const site = req.headers['sec-fetch-site']
  if (origin === undefined) return site === 'same-origin' || site === 'none'
  return site === undefined || site === 'same-origin' || site === 'none'
}

function webStatus(runtime, registeredTools) {
  const status = publicStatus(runtime, registeredTools)
  const allowed = [
    'phase', 'bootId', 'runtimeVersion', 'serverTime', 'supervisorReady', 'toolSurfaceSha256',
    'token', 'notBefore', 'deadline', 'countdownEndsAt', 'remainingSeconds', 'blockers', 'error',
  ]
  if (status.phase === 'booted' || status.phase === 'resuming' || status.phase === 'resumed') allowed.push('sessionId')
  return Object.fromEntries(allowed.filter(key => status[key] !== undefined).map(key => [key, status[key]]))
}

async function readSmallJson(req, maximum = 1024) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(declared) || declared < 0 || declared > maximum) throw new Error('request body is too large')
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > maximum) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function publicStatus(runtime, registeredTools) {
  const toolSurface = registeredTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    ...runtime,
    toolSurfaceSha256: createHash('sha256').update(JSON.stringify(toolSurface)).digest('hex'),
  }
}

/** Register fixed restart tools, drain coordination, status API and continuation. */
export function apply(ctx, config = {}) {
  const options = resolveConfig(config)
  const markerPath = join(options.stateDir, MARKER_FILE)
  const historyPath = join(options.stateDir, HISTORY_FILE)
  const appExit = ctx.get?.('appExit')
  const bootId = processBootId()
  const supervisorBootId = supervisedBootId()
  const processStartedAt = Date.now() - Math.floor(process.uptime() * 1_000)
  const coordinators = globalThis[COORDINATORS_SYMBOL] ??= new Map()
  const generation = randomUUID()
  const activeSubagents = new Map()
  const registeredTools = []
  let controller
  let startupMarker
  let disposed = false
  const lifecycleController = new AbortController()
  let runtime = {
    phase: 'idle',
    bootId,
    runtimeVersion: process.env[RUNTIME_VERSION_ENV] || 'unknown',
    serverTime: Date.now(),
    supervisorReady: supervisorReady(),
  }

  const setStatus = (phase, detail = {}) => {
    runtime = {
      phase,
      bootId,
      runtimeVersion: process.env[RUNTIME_VERSION_ENV] || 'unknown',
      supervisorReady: supervisorReady(),
      serverTime: Date.now(),
      ...detail,
    }
  }

  const liveAgents = () => {
    const value = ctx.agents.list()
    if (!Array.isArray(value)) throw new Error('agents.list() did not return an array')
    return value
  }

  const inspectBlockers = () => {
    try {
      const agents = liveAgents()
      const busyAgents = agents
        .filter(candidate => candidate.status !== 'idle')
        .map(candidate => ({ id: candidate.id, status: candidate.status ?? 'unknown' }))
      const jobs = new Map()
      for (const job of ctx.jobs.list()) jobs.set(job.id, job)
      for (const candidate of agents) {
        for (const job of ctx.jobs.list(candidate)) jobs.set(job.id, job)
      }
      const activeJobs = [...jobs.values()]
        .filter(job => job.status === 'running' || job.status === 'stopping')
        .map(job => ({ id: job.id, status: job.status, label: job.label }))
      return {
        busyAgents,
        activeSubagents: [...activeSubagents.values()],
        activeJobs,
        total: busyAgents.length + activeSubagents.size + activeJobs.length,
      }
    } catch (error) {
      return {
        busyAgents: [], activeSubagents: [], activeJobs: [], total: 1,
        inspectionError: String(error?.message ?? error),
      }
    }
  }

  const cancel = (reason, phase = 'cancelled', expectedToken) => {
    let marker
    try { marker = readMarker(markerPath) } catch {}
    if (!marker) return false
    if (expectedToken !== undefined && marker.token !== expectedToken) return false
    removeMarkerIfCurrent(markerPath, marker.token)
    controller?.abort(new Error(reason))
    controller = undefined
    setStatus(phase, { token: marker.token, reason, sessionId: marker.sessionId })
    log(ctx, 'warn', `dsh-restart-resume: ${reason}`)
    return true
  }

  const flushAllSessions = async () => {
    for (const candidate of liveAgents()) {
      if (!await ctx.sessions.flush(candidate.session)) {
        throw new Error(`session ${candidate.id} has no active persistence barrier`)
      }
    }
  }

  const waitForAdapter = async (agent) => {
    const configuredProvider = agent.options?.provider
    const previousProvider = agent.session.events
      .findLast(event => event?.type === 'request/header')?.data?.header?.config?.provider
    const provider = typeof configuredProvider === 'string' && configuredProvider !== ''
      ? configuredProvider
      : typeof previousProvider === 'string' && previousProvider !== '' ? previousProvider : undefined
    const deadline = Date.now() + 120_000
    while (!lifecycleController.signal.aborted) {
      const providers = ctx.llm.listProviders()
      if (provider === undefined ? providers.length > 0 : providers.some(candidate => candidate.id === provider)) return
      if (Date.now() >= deadline) {
        throw new Error(provider === undefined
          ? 'no LLM adapter became ready within 120 seconds'
          : `LLM adapter for provider ${JSON.stringify(provider)} did not become ready within 120 seconds`)
      }
      await delay(100, lifecycleController.signal)
    }
  }

  const runDrain = async (marker) => {
    if (disposed || controller) return
    const prior = coordinators.get(markerPath)
    if (prior && prior.generation !== generation) prior.abort(new Error('restart coordinator handed over during HMR'))
    controller = new AbortController()
    const signal = controller.signal
    coordinators.set(markerPath, { generation, abort: reason => controller?.abort(reason) })
    try {
      let countdownEndsAt
      while (!signal.aborted) {
        if (disposed || coordinators.get(markerPath)?.generation !== generation) {
          throw new Error('restart coordinator no longer owns this marker')
        }
        const current = readMarker(markerPath)
        if (current?.token !== marker.token) throw new Error('restart marker was removed or replaced')
        const now = Date.now()
        if (now >= marker.deadline) {
          cancel(`restart drain timed out after ${Math.round((marker.deadline - marker.notBefore) / 1_000)} seconds`, 'timed-out')
          return
        }
        const blockers = inspectBlockers()
        if (now < marker.notBefore || blockers.total > 0) {
          countdownEndsAt = undefined
          setStatus(now < marker.notBefore ? 'scheduled' : 'draining', {
            token: marker.token,
            sessionId: marker.sessionId,
            reason: marker.reason,
            notBefore: marker.notBefore,
            deadline: marker.deadline,
            blockers,
          })
          await delay(options.pollIntervalMs, signal)
          continue
        }
        if (countdownEndsAt === undefined) {
          countdownEndsAt = now + marker.finalCountdownSeconds * 1_000
        }
        const remainingMs = Math.max(0, countdownEndsAt - now)
        setStatus('countdown', {
          token: marker.token,
          sessionId: marker.sessionId,
          reason: marker.reason,
          countdownEndsAt,
          remainingSeconds: Math.ceil(remainingMs / 1_000),
          blockers,
        })
        if (remainingMs > 0) {
          await delay(Math.min(options.pollIntervalMs, remainingMs), signal)
          continue
        }
        const finalBlockers = inspectBlockers()
        if (finalBlockers.total > 0) {
          countdownEndsAt = undefined
          continue
        }
        await flushAllSessions()
        if (inspectBlockers().total > 0) {
          countdownEndsAt = undefined
          continue
        }
        setStatus('exiting', {
          token: marker.token,
          sessionId: marker.sessionId,
          reason: marker.reason,
        })
        log(ctx, 'info', `dsh-restart-resume: all sessions, subagents and jobs are drained; exiting with ${RESTART_EXIT_CODE}`)
        if (disposed || signal.aborted || coordinators.get(markerPath)?.generation !== generation) return
        appExit(RESTART_EXIT_CODE)
        return
      }
    } catch (error) {
      if (!signal.aborted) {
        setStatus('failed', { token: marker.token, error: String(error?.message ?? error) })
        log(ctx, 'warn', `dsh-restart-resume: restart failed: ${String(error)}`)
      }
    } finally {
      if (controller?.signal === signal) controller = undefined
      if (coordinators.get(markerPath)?.generation === generation) coordinators.delete(markerPath)
    }
  }

  const resume = async (agent, marker) => {
    if (readMarker(markerPath)?.token !== marker.token) return
    setStatus('booted', {
      token: marker.token, sessionId: marker.sessionId, waitingForAdapter: true,
    })
    await waitForAdapter(agent)
    if (readMarker(markerPath)?.token !== marker.token) return
    setStatus('resuming', { token: marker.token, sessionId: marker.sessionId, reason: marker.reason })
    if (!agent.session.events.some(event => eventCarriesMessageId(event, marker.messageId))) {
      agent.followup(makeResumeMessage(marker, options.resumePrompt))
    }
    if (!await ctx.sessions.flush(agent.session)) {
      throw new Error(`session ${agent.id} has no active persistence barrier`)
    }
    removeMarkerIfCurrent(markerPath, marker.token)
    setStatus('resumed', { token: marker.token, sessionId: marker.sessionId, reason: marker.reason })
    log(ctx, 'info', `dsh-restart-resume: continued session ${agent.id} after restart`)
  }

  try {
    startupMarker = readMarker(markerPath)
    if (startupMarker && Date.now() - startupMarker.requestedAt > options.resumeTtlMs) {
      removeMarkerIfCurrent(markerPath, startupMarker.token)
      log(ctx, 'warn', `dsh-restart-resume: discarded expired marker for ${startupMarker.sessionId}`)
      startupMarker = undefined
    }
  } catch (error) {
    setStatus('failed', { error: `cannot read restart marker: ${String(error)}` })
  }

  ctx.on('subagent/start', info => activeSubagents.set(info.runId, {
    runId: info.runId, id: info.id, provider: info.provider, local: info.local,
  }))
  ctx.on('subagent/end', info => activeSubagents.delete(info.runId))

  const handleLiveAgent = (agent) => {
    if (!startupMarker || agent.id !== startupMarker.sessionId) return
    const marker = startupMarker
    if (marker.legacyIdentity && marker.requestedAt >= processStartedAt - 1_000) {
      setStatus('failed', { token: marker.token, error: 'legacy restart marker was created during this process boot; cancel it before retrying' })
      return
    }
    if (marker.requestingBootId === supervisorBootId) {
      if (!controller && supervisorReady() && typeof appExit === 'function') void runDrain(marker)
      return
    }
    startupMarker = undefined
    void resume(agent, marker).catch((error) => {
      startupMarker = marker
      setStatus('failed', { token: marker.token, error: String(error?.message ?? error) })
    })
  }

  ctx.on('agent/session-start', ({ agent }) => handleLiveAgent(agent))

  const restartTool = {
    name: 'dsh_restart',
    description:
      'Schedule a supervised DSH restart and continue this same session afterward. By default the restart is one checkpoint inside the larger user task: the resumed agent continues remaining configuration, verification and delivery. The Web client automatically reconnects and reloads after session resume, so a manual-refresh instruction requires evidence that the recovered page is stale. The request waits for every active session, subagent and background job, never force-kills them, shows a final countdown, and cancels on timeout. Use only for a user-authorized change that needs a real process restart, and make this the final tool action of the turn.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Concrete reason the process restart is required.' },
        confirm: { type: 'boolean', description: 'Must be true after user authorization and necessity checks.' },
        delaySeconds: { type: 'integer', minimum: 5, maximum: 3600, description: 'Seconds before drain eligibility; defaults to plugin configuration (10).' },
        maxWaitSeconds: { type: 'integer', minimum: 300, maximum: 86400, description: 'Maximum drain wait after the scheduled time; minimum 5 minutes, default 30 minutes.' },
        resumeMode: { type: 'string', enum: ['continue', 'report-only'], description: 'Post-restart behavior. continue resumes unfinished work with minimal checks (default); report-only reports success and stops.' },
        afterRestart: { type: 'string', description: 'Concrete next step within the original larger task after restart, e.g. verify the installed plugin tools and finish routing configuration. Recommended with continue.' },
      },
      required: ['reason', 'confirm'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (args.confirm !== true) return json({ ok: false, error: 'confirm must be exactly true' })
      if (!supervisorReady()) return json({ ok: false, error: `restart supervisor is not active (${SUPERVISOR_ENV}=1 is required)` })
      if (supervisorBootId === undefined) return json({ ok: false, error: `restart supervisor did not provide a valid ${BOOT_ID_ENV}; refusing an unprovable cross-process restart` })
      if (typeof appExit !== 'function') return json({ ok: false, error: 'the DSH launcher did not provide appExit' })
      if (!exec?.agent) return json({ ok: false, error: 'dsh_restart requires an owning agent session' })
      try {
        const reason = validateReason(args.reason)
        const delaySeconds = boundedInteger(args.delaySeconds, options.defaultDelaySeconds, 'delaySeconds', 5, 3_600)
        const maxWaitSeconds = boundedInteger(args.maxWaitSeconds, options.drainTimeoutSeconds, 'maxWaitSeconds', 300, 86_400)
        const afterRestart = validateAfterRestart(args.afterRestart)
        const now = Date.now()
        const history = readHistory(historyPath).filter(entry => now - entry.time < options.restartWindowMs)
        if (history.length >= options.maxRestarts) {
          return json({ ok: false, error: `restart rate limit reached (${options.maxRestarts} per ${options.restartWindowMs / 1_000}s)` })
        }
        const notBefore = now + delaySeconds * 1_000
        const marker = {
          version: STATE_VERSION,
          token: randomUUID(),
          sessionId: exec.agent.id,
          messageId: `restart-resume-${randomUUID()}`,
          reason,
          requestedAt: now,
          requestingPid: process.pid,
          requestingBootId: supervisorBootId,
          notBefore,
          deadline: notBefore + maxWaitSeconds * 1_000,
          finalCountdownSeconds: options.finalCountdownSeconds,
          resumeMode: args.resumeMode ?? 'continue',
          ...afterRestart === undefined ? {} : { afterRestart },
        }
        atomicCreate(markerPath, marker)
        try { writeHistory(historyPath, [...history, { time: now, sessionId: exec.agent.id }]) }
        catch (error) { removeMarkerIfCurrent(markerPath, marker.token); throw error }
        startupMarker = marker
        setStatus('scheduled', { token: marker.token, sessionId: marker.sessionId, reason, notBefore, deadline: marker.deadline })
        void runDrain(marker)
        return json({
          ok: true,
          status: 'scheduled',
          token: marker.token,
          notBefore,
          deadline: marker.deadline,
          resumeMode: marker.resumeMode,
          ...marker.afterRestart === undefined ? {} : { afterRestart: marker.afterRestart },
          message: `Restart is scheduled in ${delaySeconds}s. It will wait up to ${maxWaitSeconds}s for all sessions, subagents and jobs, then show a ${options.finalCountdownSeconds}s final countdown. Timeout cancels without force-killing work.`,
        })
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const statusTool = {
    name: 'dsh_restart_status',
    description: 'Read the current supervised-restart phase, truthful countdown, blockers and stable tool-surface digest. This is read-only.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const status = publicStatus(runtime, registeredTools)
      if (['scheduled', 'draining', 'countdown'].includes(status.phase)) status.blockers = inspectBlockers()
      return json(status)
    },
  }

  const cancelTool = {
    name: 'dsh_restart_cancel',
    description: 'Cancel a pending supervised restart without terminating any session, subagent or background job.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { reason: { type: 'string', description: 'Optional short cancellation reason.' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      return json(cancel(validateReason(args.reason ?? 'cancelled by agent'))
        ? { ok: true, status: 'cancelled' }
        : { ok: false, error: 'no restart is pending' })
    },
  }

  for (const tool of [restartTool, statusTool, cancelTool]) {
    registeredTools.push(tool)
    ctx.tools.register(tool)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PATH,
    async handler(req, res) {
      const pathname = new URL(req.url, 'http://localhost').pathname
      if (!sameOriginRequest(req)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(json({ ok: false, error: 'same-origin browser request required' }))
        return
      }
      if (req.method === 'GET' && pathname === `${API_PATH}/status`) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(json(webStatus(runtime, registeredTools)))
        return
      }
      if (req.method === 'POST' && pathname === `${API_PATH}/cancel`) {
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          res.writeHead(415, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(json({ ok: false, error: 'application/json is required' }))
          return
        }
        let body
        try { body = await readSmallJson(req) }
        catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(json({ ok: false, error: String(error?.message ?? error) }))
          return
        }
        const ok = typeof body?.token === 'string' && cancel('cancelled from the restart banner', 'cancelled', body.token)
        res.writeHead(ok ? 200 : 409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(json(ok ? { ok: true } : { ok: false, error: 'restart token is missing, stale, or not current' }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(json({ ok: false, error: 'not found' }))
    },
  }), 'dsh-restart-resume: status API')

  ctx.effect(() => () => {
    disposed = true
    lifecycleController.abort(new Error('restart plugin scope disposed'))
    if (coordinators.get(markerPath)?.generation === generation) coordinators.delete(markerPath)
    controller?.abort(new Error('restart plugin scope disposed'))
    controller = undefined
  }, 'dsh-restart-resume: coordinator lifecycle')

  if (startupMarker) {
    if (startupMarker.legacyIdentity && startupMarker.requestedAt >= processStartedAt - 1_000) {
      setStatus('failed', { token: startupMarker.token, error: 'legacy restart marker was created during this process boot; cancel it before retrying' })
    } else if (startupMarker.legacyIdentity) {
      setStatus('booted', { token: startupMarker.token, sessionId: startupMarker.sessionId, waitingForAdapter: true })
    } else if (startupMarker.requestingBootId === supervisorBootId) {
      setStatus('draining', { token: startupMarker.token, sessionId: startupMarker.sessionId, reason: startupMarker.reason })
      if (supervisorReady() && typeof appExit === 'function') void runDrain(startupMarker)
    } else {
      setStatus('booted', { token: startupMarker.token, sessionId: startupMarker.sessionId, reason: startupMarker.reason })
    }
    const alreadyLive = ctx.agents.get(startupMarker.sessionId)
    if (alreadyLive) queueMicrotask(() => handleLiveAgent(alreadyLive))
  }
}
