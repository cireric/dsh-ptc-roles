#!/usr/bin/env node
// verify-intent-gate-watchdog.cjs — 零成本单元校验：ptc-roles 的意图门看门狗插件
// （preset/ptc-roles/intent-gate-watchdog.mjs）。
//
// 为什么需要它：这个插件的失效是【静默】的 —— 本部署 logger.warn 没有落盘通道
// （docs/pitfalls.md #9），而它唯一的输出就是"该提醒时没提醒"。所以断言必须直接驱动
// 它的失败路径，而不是等会话日志里发现"又漏了"。
//
// 用法：
//   node scripts/verify-intent-gate-watchdog.cjs            # 校验当前插件（期望全绿，退出码 0）
//   node scripts/verify-intent-gate-watchdog.cjs --control  # 阴性对照：跑 scripts/fixtures/
//                                                           #   intent-gate-watchdog.naive.mjs
//   LANE_PLUGIN_PATH=<任意 .mjs> node scripts/verify-intent-gate-watchdog.cjs
//
// 阴性对照为什么不用"魔法数字"：仓库里另一个单测靠"恰好 5 项失败"，那个数字是当时的巧合。
// 这里改成**要求指定断言名必须失败**（见 REQUIRED_CONTROL_FAILURES）—— 它同时证明
// ①断言不是空转 ②对照版确实只坏在我故意弄坏的那几条上。
//
// 全程只读：不联网、不调模型、不写文件。
//
// ⚠ 对照 fixture 与证据 ⑩ 的 sha 不一致是**预期**的：2026-09-15 加「只提醒会改变行为的轮次」
// 这条判据时，连带把 fixture 注释里的期望条数（7 → 10）与坑清单补了一行 —— **纯注释，行为不变**
// （同 README §5 记的那次先例）。证据 ⑩ 里的 `sha256: e82d766f…` 是**当时那次运行**的字节。

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const CONTROL_MODE = process.argv.includes('--control')
const CONTROL_FIXTURE = path.join(__dirname, 'fixtures', 'intent-gate-watchdog.naive.mjs')
const PLUGIN = path.resolve(
  process.env.LANE_PLUGIN_PATH
    ?? (CONTROL_MODE ? CONTROL_FIXTURE : path.join(__dirname, '..', 'preset', 'ptc-roles', 'intent-gate-watchdog.mjs')),
)

/** 对照版【必须】失败在这些断言上（否则断言或对照版有一个是坏的）。 */
const REQUIRED_CONTROL_FAILURES = [
  'no reminder on the first turn (no previous-turn data)',
  'never overrides a downstream reject',
  'skips role children whose depth lives in the header',
  'skips role children whose depth lives only in options.subagentDepth',
  'reminds at most once per turn',
  'rejects an empty config.markers at load time',
  'rejects a blank config.markers entry at load time',
  // 设计取舍 5（只提醒「会改变行为」的轮次）——对照版没有这个判据，所以这三条也必须在它身上失败。
  'stays silent when the previous turn ran no behavior-changing tool',
  'stays silent when the previous PTC turn only dispatched read-only tools',
  'reports an unattributable dispatch instead of staying silent',
]

let checks = 0
let failures = 0
const failedNames = []
function check(name, ok, detail) {
  checks += 1
  if (ok) console.log('  ✓ ' + name)
  else { failures += 1; failedNames.push(name); console.log('  ✗ ' + name + (detail === undefined ? '' : ' — ' + detail)) }
}

/** Load a fresh plugin instance with a fake ctx capturing both subscriptions. */
async function open(config) {
  const state = { warns: [], sessionHandler: undefined, preStepHandler: undefined }
  const ctx = {
    logger: { warn: (message) => state.warns.push(String(message)) },
    on: (event, fn) => {
      if (event === 'session/event') state.sessionHandler = fn
      else if (event === 'agent/pre-step') state.preStepHandler = fn
    },
  }
  const mod = await import(pathToFileURL(PLUGIN).href)
  mod.apply(ctx, config)
  if (typeof state.sessionHandler !== 'function') throw new Error('plugin did not subscribe to session/event')
  if (typeof state.preStepHandler !== 'function') throw new Error('plugin did not subscribe to agent/pre-step')
  const session = (id) => ({ id })
  const observe = (id, turn, text) => state.sessionHandler(session(id), {
    type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })
  const agent = ({ id = 's1', headerDepth = 0, optionDepth, origin } = {}) => ({
    session: { id, header: { delegationDepth: headerDepth, ...(origin ? { origin } : {}) } },
    options: optionDepth === undefined ? {} : { subagentDepth: optionDepth },
  })
  /** One tool call as the session store records it: name + turn + callId. */
  const call = (id, turn, name, callId) => state.sessionHandler(session(id), {
    type: 'tool/call', data: { turn, step: 1, callId, name, arguments: '{}' },
  })
  /** A PTC inner call — note it carries NO turn; it names its root call instead. */
  const dispatch = (id, name, rootCallId) => state.sessionHandler(session(id), {
    type: 'tool/ptc-dispatch', data: { rootCallId, parentCallId: rootCallId, subCallId: 'sub1', name, arguments: {} },
  })
  /** A native turn that used a behavior tool. */
  const act = (id, turn, name = 'write') => call(id, turn, name, 'call_' + id + '_' + turn)
  /** A PTC turn whose run_code program dispatched a behavior tool. */
  const actPtc = (id, turn, name = 'write') => {
    const callId = 'call_' + id + '_' + turn
    call(id, turn, 'run_code', callId)
    dispatch(id, name, callId)
  }
  const userMessages = [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]
  const preStep = (payload, decision = { kind: 'enter', messages: userMessages }) =>
    state.preStepHandler(payload, async () => decision)
  return { state, session, observe, agent, userMessages, preStep, call, dispatch, act, actPtc }
}

const ENTER = (messages) => ({ kind: 'enter', messages })
const injected = (decision) => Array.isArray(decision?.messages) && decision.messages.length > 1

async function main() {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(PLUGIN)).digest('hex')
  console.log('plugin: ' + PLUGIN + (CONTROL_MODE ? '   [NEGATIVE CONTROL — 期望指定断言失败]' : ''))
  console.log('sha256: ' + sha + '\n')

  // 1 — the happy path: previous turn lacked the marker -> one reminder is appended.
  {
    const h = await open()
    h.observe('s1', 1, '直接开始干活，没有分类行。')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('appends one reminder when the previous turn lacked the marker',
      injected(d) && d.messages.length === h.userMessages.length + 1, JSON.stringify(d).slice(0, 120))
  }

  // 2 — the injected message must be shaped like createUserMessage's output and frozen.
  {
    const h = await open()
    h.observe('s1', 1, '没有分类行')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    const m = d?.messages?.[d.messages.length - 1]
    check('injected message matches createUserMessage shape and is frozen',
      m?.role === 'user' && typeof m.id === 'string' && m.id.length > 0
        && Array.isArray(m.content) && m.content[0]?.type === 'text' && typeof m.content[0].text === 'string'
        && m.source?.kind === 'plugin' && m.source.plugin === 'intent-gate-watchdog'
        && Object.isFrozen(m) && Object.isFrozen(m.content[0]))
  }

  // 3 — compliant previous turn -> silence.
  {
    const h = await open()
    h.observe('s1', 1, '意图判定：implementation — 先读再改。')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('stays silent when the previous turn emitted the marker', !injected(d))
  }

  // 4 — no previous-turn data (first turn) is NOT a miss.
  {
    const h = await open()
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    check('no reminder on the first turn (no previous-turn data)', !injected(d))
  }

  // 5 — a downstream reject is authoritative.
  {
    const h = await open()
    h.observe('s1', 1, '没有分类行')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 }, { kind: 'reject' })
    check('never overrides a downstream reject', d?.kind === 'reject')
  }

  // 6 — machine-driven turns (no real user message) are skipped.
  {
    const h = await open()
    h.observe('s1', 1, '没有分类行')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), turn: 2, step: 1,
      messages: [{ id: 'n1', role: 'user', content: [{ type: 'text', text: 'notice' }], source: { kind: 'plugin', plugin: 'x' } }] })
    check('skips steps with no real user message', !injected(d))
  }

  // 7 / 8 — role children are out of scope, however the depth is recorded.
  {
    const h = await open()
    h.observe('s1', 3, '没有分类行')
    h.act('s1', 3)
    const viaHeader = await h.preStep({ agent: h.agent({ headerDepth: 2 }), messages: h.userMessages, turn: 4, step: 1 })
    check('skips role children whose depth lives in the header', !injected(viaHeader))
    const viaOptions = await h.preStep({ agent: h.agent({ optionDepth: 1 }), messages: h.userMessages, turn: 4, step: 1 })
    check('skips role children whose depth lives only in options.subagentDepth', !injected(viaOptions))
  }

  // 9 — a malformed runtime depth must skip loudly, not guess.
  {
    const h = await open()
    h.observe('s1', 1, '没有分类行')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent({ optionDepth: -1 }), messages: h.userMessages, turn: 2, step: 1 })
    check('malformed options.subagentDepth skips and warns',
      !injected(d) && h.state.warns.some(w => w.includes('malformed')))
  }

  // 10 — at most one reminder per turn.
  {
    const h = await open()
    h.observe('s1', 1, '没有分类行')
    h.act('s1', 1)
    const first = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    const second = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 2 })
    check('reminds at most once per turn', injected(first) && !injected(second))
  }

  // 11 — a NEW user turn is re-evaluated (state must not latch across turns).
  {
    const h = await open()
    h.observe('s1', 1, '没有分类行')
    h.act('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    h.observe('s1', 2, '又没有分类行')
    h.act('s1', 2)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 3, step: 1 })
    check('re-evaluates on the next turn', injected(d))
  }

  // 12 — config: a custom marker is honoured.
  {
    const h = await open({ markers: ['[gate:impl]'] })
    h.observe('s1', 1, '意图判定：implementation — …')   // default marker must NOT satisfy a custom config
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('honours a custom config.markers list', injected(d))
  }

  // 13 / 14 — invalid config fails LOUD at load time.
  for (const [name, cfg] of [['rejects an empty config.markers at load time', { markers: [] }],
    ['rejects a blank config.markers entry at load time', { markers: ['  '] }]]) {
    let threw
    try { await open(cfg) } catch (err) { threw = err }
    check(name, threw !== undefined && String(threw).includes('markers'))
  }

  // 15 — a downstream failure is rethrown, never swallowed.
  {
    const h = await open()
    let threw
    try {
      await h.state.preStepHandler({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 },
        async () => { throw new Error('downstream boom') })
    } catch (err) { threw = err }
    check('rethrows a downstream failure instead of swallowing it',
      threw !== undefined && String(threw).includes('downstream boom') && h.state.warns.length > 0)
  }

  // 16 — malformed payloads and events must not throw.
  {
    const h = await open()
    let threw
    try {
      h.state.sessionHandler(undefined, undefined)
      h.state.sessionHandler({ id: 's1' }, { type: 'assistant/message', data: {} })
      await h.preStep(undefined)
      await h.preStep({ agent: undefined, messages: undefined, turn: undefined, step: undefined })
    } catch (err) { threw = err }
    check('malformed payloads are a no-op, not a crash', threw === undefined)
  }

  // 17 / 18 — a read-only turn is not one the rule covers -> silence (native & PTC).
  {
    const h = await open()
    h.observe('s1', 1, '只读侦察，没有分类行。')
    h.call('s1', 1, 'read', 'call_read_1')
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('stays silent when the previous turn ran no behavior-changing tool', !injected(d))
  }
  {
    const h = await open()
    h.observe('s1', 1, '只读侦察，没有分类行。')
    h.call('s1', 1, 'run_code', 'call_ptc_read')
    h.dispatch('s1', 'read', 'call_ptc_read')
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('stays silent when the previous PTC turn only dispatched read-only tools', !injected(d))
  }

  // 19 — in PTC the behavior tool is visible ONLY on the dispatch event, and that event
  // carries no `turn`: attribution goes through the root call id.
  {
    const h = await open()
    h.observe('s1', 1, '直接开干，没有分类行。')
    h.actPtc('s1', 1, 'write')
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('reminds when the previous turn dispatched a behavior tool through run_code', injected(d))
  }

  // 20 — an unattributable dispatch must be LOUD: silence there would mean the eligibility
  // rule has gone blind, which is exactly the failure mode this plugin exists to expose.
  {
    const h = await open()
    h.dispatch('s1', 'write', 'call_never_seen')
    check('reports an unattributable dispatch instead of staying silent',
      h.state.warns.some(w => w.includes('no attributable turn')))
  }

  console.log('\n汇总: ' + (checks - failures) + '/' + checks + ' 通过' + (failures === 0 ? '  ✓ 全绿' : '  ✗ ' + failures + ' 项失败'))

  if (CONTROL_MODE) {
    const missing = REQUIRED_CONTROL_FAILURES.filter(name => !failedNames.includes(name))
    console.log(missing.length === 0
      ? '阴性对照符合预期：' + REQUIRED_CONTROL_FAILURES.length + ' 条指定断言全部失败（共 ' + failures + ' 项失败）—— 断言确实抓得住"该提醒时不提醒/乱提醒"的实现。'
      : '⚠ 阴性对照不符合预期：这些断言在对照版上竟然通过了 → ' + missing.join(' | '))
    process.exitCode = missing.length === 0 ? 0 : 1
    return
  }
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => { console.error('harness error: ' + String(err && err.stack || err)); process.exitCode = 2 })
