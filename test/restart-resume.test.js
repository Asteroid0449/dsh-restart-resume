import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name, RESTART_EXIT_CODE } from '../lib/index.js'

const previousSupervisor = process.env.DSH_RESTART_SUPERVISOR
const previousBootId = process.env.DSH_BOOT_ID
const realDateNow = Date.now
const temporaryRoots = []

afterEach(() => {
  Date.now = realDateNow
  if (previousSupervisor === undefined) delete process.env.DSH_RESTART_SUPERVISOR
  else process.env.DSH_RESTART_SUPERVISOR = previousSupervisor
  if (previousBootId === undefined) delete process.env.DSH_BOOT_ID
  else process.env.DSH_BOOT_ID = previousBootId
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-restart-resume-'))
  temporaryRoots.push(root)
  return root
}

function makeAgent(id = 'session-1', status = 'running') {
  const followups = []
  return {
    id,
    status,
    session: { id, events: [] },
    followup(message) {
      followups.push(message)
      this.session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [structuredClone(message)] } })
    },
    followups,
  }
}

function harness(stateDir, options = {}) {
  const tools = []
  const listeners = new Map()
  const exits = []
  const flushes = []
  const live = new Map()
  const jobs = []
  const routes = []
  const disposers = []
  const ctx = {
    tools: { register(tool) { tools.push(tool); return () => {} } },
    sessions: { async flush(session) { flushes.push(session.id); return options.flushResult ?? true } },
    agents: {
      get(id) { return live.get(id) },
      list() { return [...live.values()] },
    },
    jobs: {
      list(owner) { return jobs.filter(job => owner === undefined ? !job.owner : !job.owner || job.owner === owner.id) },
    },
    subagents: {},
    llm: { listProviders() { return options.providers ?? [{ id: 'deepseek-official' }] } },
    webServer: { register(route) { routes.push(route); return () => {} } },
    get(key) { return key === 'appExit' ? code => exits.push(code) : undefined },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(callback)
      return () => {}
    },
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') disposers.push(disposer); return disposer },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, {
    stateDir,
    maxRestarts: 3,
    restartWindowSeconds: 600,
    resumeTtlSeconds: 3600,
    defaultDelaySeconds: 5,
    drainTimeoutSeconds: 300,
    finalCountdownSeconds: 5,
    pollIntervalMs: 100,
    resumePrompt: 'continue after restart',
    ...options,
  })
  return { ctx, tools, listeners, exits, flushes, live, jobs, routes, dispose() { for (const fn of disposers.reverse()) fn() } }
}

function tool(h, name) {
  const found = h.tools.find(candidate => candidate.name === name)
  assert.ok(found, `${name} must be registered`)
  return found
}

function emit(h, event, info) {
  for (const callback of h.listeners.get(event) ?? []) callback(info)
}

const waitPolls = (count = 2) => new Promise(resolve => setTimeout(resolve, 120 * count))

test('exports the rc8 contract and a stable unconditional three-tool surface', () => {
  assert.equal(name, 'dsh-restart-resume')
  assert.deepEqual(inject, ['tools', 'sessions', 'agents', 'jobs', 'subagents', 'webServer', 'llm'])
  const first = harness(temporaryRoot())
  const second = harness(temporaryRoot())
  assert.deepEqual(first.tools.map(value => value.name), ['dsh_restart', 'dsh_restart_status', 'dsh_restart_cancel'])
  const visible = value => value.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
  assert.deepEqual(visible(first), visible(second))
  assert.equal('systemPrompt' in first.ctx, false)
})

test('refuses an unsupervised process and enforces the five-minute drain minimum', async () => {
  delete process.env.DSH_RESTART_SUPERVISOR
  process.env.DSH_BOOT_ID = 'request-boot'
  const h = harness(temporaryRoot())
  const owner = makeAgent()
  h.live.set(owner.id, owner)
  let result = JSON.parse(await tool(h, 'dsh_restart').execute({ reason: 'activate plugin', confirm: true }, { agent: owner }))
  assert.equal(result.ok, false)
  assert.match(result.error, /supervisor is not active/)

  process.env.DSH_RESTART_SUPERVISOR = '1'
  result = JSON.parse(await tool(h, 'dsh_restart').execute(
    { reason: 'activate plugin', confirm: true, maxWaitSeconds: 299 }, { agent: owner },
  ))
  assert.equal(result.ok, false)
  assert.match(result.error, /300 to 86400/)
})

test('waits for other sessions, subagents and background jobs before the countdown and exit', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'request-boot'
  let now = 1_000_000
  Date.now = () => now
  const h = harness(temporaryRoot())
  const owner = makeAgent('owner')
  const other = makeAgent('other')
  h.live.set(owner.id, owner)
  h.live.set(other.id, other)
  h.jobs.push({ id: 'job-1', owner: other.id, status: 'running', label: 'build' })
  emit(h, 'subagent/start', { runId: 'run-1', id: 'child', provider: 'inproc', local: true })

  const result = JSON.parse(await tool(h, 'dsh_restart').execute(
    { reason: 'activate plugin', confirm: true, delaySeconds: 5, maxWaitSeconds: 300 }, { agent: owner },
  ))
  assert.equal(result.ok, true)
  now += 6_000
  owner.status = 'idle'
  await waitPolls()
  let status = JSON.parse(await tool(h, 'dsh_restart_status').execute({}))
  assert.equal(status.phase, 'draining')
  assert.equal(status.blockers.total, 3)
  assert.deepEqual(h.exits, [])

  other.status = 'idle'
  h.jobs[0].status = 'completed'
  emit(h, 'subagent/end', { runId: 'run-1' })
  await waitPolls()
  status = JSON.parse(await tool(h, 'dsh_restart_status').execute({}))
  assert.equal(status.phase, 'countdown')
  now += 6_000
  await waitPolls()
  assert.deepEqual(h.flushes.sort(), ['other', 'owner'])
  assert.deepEqual(h.exits, [RESTART_EXIT_CODE])
})

test('a drain timeout cancels without force-killing or exiting', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'request-boot'
  let now = 2_000_000
  Date.now = () => now
  const stateDir = temporaryRoot()
  const h = harness(stateDir)
  const owner = makeAgent('busy')
  h.live.set(owner.id, owner)
  const result = JSON.parse(await tool(h, 'dsh_restart').execute(
    { reason: 'activate plugin', confirm: true, delaySeconds: 5, maxWaitSeconds: 300 }, { agent: owner },
  ))
  assert.equal(result.ok, true)
  now += 306_000
  await waitPolls()
  const status = JSON.parse(await tool(h, 'dsh_restart_status').execute({}))
  assert.equal(status.phase, 'timed-out')
  assert.deepEqual(h.exits, [])
  assert.equal(h.flushes.length, 0)
  assert.equal(readFileSync(join(stateDir, 'history.json'), 'utf8').includes('busy'), true)
  assert.throws(() => readFileSync(join(stateDir, 'pending.json'), 'utf8'))
})

test('a new boot resumes the original session exactly once and persists it', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'new-boot'
  const stateDir = temporaryRoot()
  const marker = {
    version: 3,
    token: 'restart-token',
    sessionId: 'session-resume',
    messageId: 'restart-resume-message',
    reason: 'load the new bundle',
    requestedAt: Date.now(),
    requestingPid: process.pid,
    requestingBootId: 'old-boot',
    notBefore: Date.now(),
    deadline: Date.now() + 300_000,
    finalCountdownSeconds: 5,
    afterRestart: 'verify the installed plugin tools and finish configuration',
  }
  writeFileSync(join(stateDir, 'pending.json'), `${JSON.stringify(marker)}\n`)
  const h = harness(stateDir)
  const resumed = makeAgent(marker.sessionId, 'idle')
  h.live.set(resumed.id, resumed)
  emit(h, 'agent/session-start', { agent: resumed })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumed.followups.length, 1)
  assert.equal(resumed.followups[0].id, marker.messageId)
  assert.match(resumed.followups[0].content[0].text, /load the new bundle/)
  assert.match(resumed.followups[0].content[0].text, /finish configuration/)
  assert.match(resumed.followups[0].content[0].text, /automatically reconnects/)
  assert.match(resumed.followups[0].content[0].text, /Do not ask the user to refresh merely because/)
  assert.deepEqual(h.flushes, [resumed.id])
  assert.throws(() => readFileSync(join(stateDir, 'pending.json'), 'utf8'))
  assert.equal(JSON.parse(await tool(h, 'dsh_restart_status').execute({})).phase, 'resumed')
})

test('report-only continuation explicitly forbids post-restart investigation', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'new-report-boot'
  const stateDir = temporaryRoot()
  const marker = {
    version: 3,
    token: 'report-token',
    sessionId: 'report-session',
    messageId: 'report-message',
    reason: 'activation-only restart',
    requestedAt: Date.now(),
    requestingPid: process.pid,
    requestingBootId: 'old-report-boot',
    notBefore: Date.now(),
    deadline: Date.now() + 300_000,
    finalCountdownSeconds: 5,
    resumeMode: 'report-only',
  }
  writeFileSync(join(stateDir, 'pending.json'), `${JSON.stringify(marker)}\n`)
  const h = harness(stateDir)
  const resumed = makeAgent(marker.sessionId, 'idle')
  h.live.set(resumed.id, resumed)
  emit(h, 'agent/session-start', { agent: resumed })
  await new Promise(resolve => setImmediate(resolve))
  const text = resumed.followups[0].content[0].text
  assert.match(text, /report-only/)
  assert.match(text, /Do not inspect files, rerun tests, invoke tools/)
})

test('manual cancellation removes only the restart marker and never exits', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'request-boot'
  const stateDir = temporaryRoot()
  const h = harness(stateDir)
  const owner = makeAgent()
  h.live.set(owner.id, owner)
  assert.equal(JSON.parse(await tool(h, 'dsh_restart').execute(
    { reason: 'activate plugin', confirm: true }, { agent: owner },
  )).ok, true)
  assert.equal(JSON.parse(await tool(h, 'dsh_restart_cancel').execute({ reason: 'user changed mind' })).ok, true)
  assert.throws(() => readFileSync(join(stateDir, 'pending.json'), 'utf8'))
  assert.deepEqual(h.exits, [])
})

test('status API is no-store and reports the same stable surface digest as the tool', async () => {
  const h = harness(temporaryRoot())
  const route = h.routes.find(candidate => candidate.path === '/restart-resume/api')
  assert.ok(route)
  const headers = []
  let body = ''
  await route.handler(
    { method: 'GET', url: '/restart-resume/api/status', headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } },
    { writeHead(code, value) { headers.push(code, value) }, end(value) { body = value } },
  )
  const api = JSON.parse(body)
  const fromTool = JSON.parse(await tool(h, 'dsh_restart_status').execute({}))
  assert.equal(api.toolSurfaceSha256, fromTool.toolSurfaceSha256)
  assert.equal(headers[1]['cache-control'], 'no-store')
})

test('same PID with a different boot id resumes, while legacy identity is held for recovery', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'new-generation'
  const stateDir = temporaryRoot()
  const marker = {
    version: 3, token: 'same-pid-token', sessionId: 'same-pid', messageId: 'same-pid-message',
    reason: 'stable pid restart', requestedAt: Date.now(), requestingPid: process.pid,
    requestingBootId: 'previous-generation', notBefore: Date.now(), deadline: Date.now() + 300_000,
    finalCountdownSeconds: 5,
  }
  writeFileSync(join(stateDir, 'pending.json'), `${JSON.stringify(marker)}\n`)
  const h = harness(stateDir)
  const agent = makeAgent(marker.sessionId, 'idle')
  h.live.set(agent.id, agent)
  emit(h, 'agent/session-start', { agent })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(agent.followups.length, 1)

  const legacyDir = temporaryRoot()
  writeFileSync(join(legacyDir, 'pending.json'), `${JSON.stringify({ ...marker, version: 2, token: 'legacy' })}\n`)
  const legacy = harness(legacyDir)
  assert.equal(JSON.parse(await tool(legacy, 'dsh_restart_status').execute({})).phase, 'failed')
  assert.equal(JSON.parse(await tool(legacy, 'dsh_restart_cancel').execute({})).ok, true)
})

test('a legacy marker proven older than this process resumes instead of failing migration', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'migration-boot'
  const stateDir = temporaryRoot()
  const marker = {
    version: 2, token: 'legacy-previous-boot', sessionId: 'legacy-session', messageId: 'legacy-message',
    reason: 'upgrade during restart', requestedAt: Date.now() - Math.floor(process.uptime() * 1_000) - 5_000,
    requestingPid: process.pid, notBefore: Date.now() - 5_000, deadline: Date.now() + 300_000,
    finalCountdownSeconds: 5, afterRestart: 'verify migration',
  }
  writeFileSync(join(stateDir, 'pending.json'), `${JSON.stringify(marker)}\n`)
  const h = harness(stateDir)
  const agent = makeAgent(marker.sessionId, 'idle')
  h.live.set(agent.id, agent)
  emit(h, 'agent/session-start', { agent })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(agent.followups.length, 1)
  assert.match(agent.followups[0].content[0].text, /verify migration/)
  assert.equal(JSON.parse(await tool(h, 'dsh_restart_status').execute({})).phase, 'resumed')
})

test('resume waits for the configured provider adapter before waking the conversation', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'adapter-boot'
  const providers = []
  const stateDir = temporaryRoot()
  const marker = {
    version: 3, token: 'adapter-token', sessionId: 'adapter-session', messageId: 'adapter-message',
    reason: 'wait for adapter', requestedAt: Date.now(), requestingPid: process.pid,
    requestingBootId: 'previous-boot', notBefore: Date.now(), deadline: Date.now() + 300_000,
    finalCountdownSeconds: 5,
  }
  writeFileSync(join(stateDir, 'pending.json'), `${JSON.stringify(marker)}\n`)
  const h = harness(stateDir, { providers })
  const agent = makeAgent(marker.sessionId, 'idle')
  agent.session.events.push({
    type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'test' } } },
  })
  h.live.set(agent.id, agent)
  emit(h, 'agent/session-start', { agent })
  await waitPolls(1)
  assert.equal(agent.followups.length, 0)
  assert.equal(JSON.parse(await tool(h, 'dsh_restart_status').execute({})).phase, 'booted')
  providers.push({ id: 'deepseek-official' })
  await waitPolls(2)
  assert.equal(agent.followups.length, 1)
  assert.equal(JSON.parse(await tool(h, 'dsh_restart_status').execute({})).phase, 'resumed')
})

test('dispose aborts the old drain coordinator without deleting the durable request or exiting', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'hmr-boot'
  let now = 3_000_000
  Date.now = () => now
  const stateDir = temporaryRoot()
  const h = harness(stateDir)
  const owner = makeAgent('hmr-owner', 'idle')
  h.live.set(owner.id, owner)
  assert.equal(JSON.parse(await tool(h, 'dsh_restart').execute(
    { reason: 'hmr lifecycle', confirm: true }, { agent: owner },
  )).ok, true)
  h.dispose()
  now += 20_000
  await waitPolls()
  assert.deepEqual(h.exits, [])
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'pending.json'), 'utf8')).token.length > 0, true)
})

test('web cancel requires same origin, JSON, and the current restart token', async () => {
  process.env.DSH_RESTART_SUPERVISOR = '1'
  process.env.DSH_BOOT_ID = 'web-boot'
  const h = harness(temporaryRoot())
  const owner = makeAgent('web-owner')
  h.live.set(owner.id, owner)
  const scheduled = JSON.parse(await tool(h, 'dsh_restart').execute(
    { reason: 'web cancellation', confirm: true }, { agent: owner },
  ))
  const route = h.routes.find(candidate => candidate.path === '/restart-resume/api')
  const invoke = async ({ origin = 'http://localhost:3000', token = scheduled.token, contentType = 'application/json' } = {}) => {
    const payload = Buffer.from(JSON.stringify({ token }))
    let status
    const req = {
      method: 'POST', url: '/restart-resume/api/cancel',
      headers: { host: 'localhost:3000', origin, 'content-type': contentType, 'content-length': String(payload.length) },
      async *[Symbol.asyncIterator]() { yield payload },
    }
    await route.handler(req, { writeHead(code) { status = code }, end() {} })
    return status
  }
  assert.equal(await invoke({ origin: 'https://evil.example' }), 403)
  assert.equal(await invoke({ token: 'stale-token' }), 409)
  assert.equal(await invoke(), 200)
})

test('browser companion explicitly treats backend-disconnected startup as unobservable', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /启动期间不可观测/)
  assert.match(source, /bootId/)
  assert.match(source, /location\.reload/)
  assert.match(source, /页面将自动刷新/)
  assert.doesNotMatch(source, /如页面未自动刷新，请手动刷新/)
  assert.doesNotMatch(source, /progress|percentage|百分比/i)
  assert.match(source, /!prior \|\| prior\.token !== status\.token/)
  assert.match(source, /ctx\.sessions\.open\(status\.sessionId\)/)
  assert.match(source, /exports\.inject = \['sessions', 'locale'\]/)
  assert.match(source, /Cancel restart/)
  assert.match(source, /terminalKey ===/)
})
