#!/usr/bin/env node
// verify-intent-gate-watchdog.cjs — 零成本单元校验：ptc-roles 的意图门看门狗插件
// （preset/ptc-roles/intent-gate-watchdog.mjs）。
//
// 为什么需要它：这个插件的失效是【静默】的 —— 本部署 logger.warn 没有落盘通道
// （docs/pitfalls.md #9），而它唯一的输出就是"该提醒时没提醒"。所以断言必须直接驱动
// 它的失败路径，而不是等会话日志里发现"又漏了"。
//
// 覆盖两个 hook 点（第三个 tools/pre-execute 见下）：
//   * agent/pre-step  —— 提醒（REMINDER）与观察取证（RACE_REPORT）；
//   * session/event   —— 门行/行为动作的记账（判据 ①：declSeq <= firstActCarrier，即
//     「门行所在消息**不晚于**承载第一次动手的那条消息」，含同一条消息）；
//   * tools/pre-execute —— 闸门：观察模式只记不拒（默认），`{ gate: 'enforce' }` 才拒，且每轮至多一次。
//     静态证据只有一条：ctx.on('tools/pre-execute') 这个注册本身 —— 所以 open() 收不到它就**大声抛错**。
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
// ⚠ 文本契约检查（D）只在正常模式跑：对照 fixture 的**文案**故意不是现行契约，拿它做文本一致性
//   检查只会凭空多出失败；那一段的阴性对照是它自己的四条内存变异（⑤–⑧）。
//
// ⚠ 对照 fixture 是**活**的阴性对照：它的 sha 与冻结证据 ⑩ 不一致是**预期**的——断言清单在演进
// （先加 eligibility 三条、再删 config.markers 三条、现在再补闸门五条），冻结证据记的是**当时那次运行**的字节。

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

/** 对照版【必须】恰好失败在这些断言上（双向判据：少一条=断言空转；多一条=对照版坏得超出预期）。 */
const REQUIRED_CONTROL_FAILURES = [
  'no reminder on the first turn (no previous-turn data)',
  'never overrides a downstream reject',
  'skips role children whose depth lives in the header',
  'skips role children whose depth lives only in options.subagentDepth',
  // 坑③「不判深度」的另一面：对照版连 resolveDepth 都没有，畸形深度既不跳过也不 warn。
  'malformed options.subagentDepth skips and warns',
  'reminds at most once per turn',
  // 设计取舍 5（只提醒「会改变行为」的轮次）——对照版没有这个判据，所以这两条也必须在它身上失败。
  'stays silent when the previous turn ran no behavior-changing tool',
  'stays silent when the previous PTC turn only dispatched read-only tools',
  // 判据 ①（存在档）：对照版按「任意位置命中」，门行在第二行、或落在动作之后的消息里，它都放过
  // ⇒ 这两条「该提醒」断言必须在它身上失败。（「与动作同一条消息」现在是**合规**，所以那条已翻转为
  // 「stays silent」，对照版同样放过它 ⇒ 它从本清单移除，不是删断言。）
  'reminds when the marker is only on a later line of the first reply',
  'reminds when the marker arrives in a later message than the action carrier',
  // 闸门（tools/pre-execute）：对照版是无条件拒 —— 不看 config.gate（观察模式也拒）、不限每轮一次、
  // 不看本轮是不是真人开的、覆盖下游决定、也不留竞态取证（⑥，见 fixture 文件头）。
  'gate in observe mode never denies, and returns the downstream allow untouched',
  'gate denies at most once per turn, then re-arms on the next turn',
  'gate skips a turn no real user message opened, and still gates a real one',
  'gate never overrides a downstream non-allow decision',
  'observe mode injects the race report when the gate missed a line the turn did carry',
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

/**
 * Load a fresh plugin instance with a fake ctx capturing all three subscriptions.
 * `config` is forwarded to `apply(ctx, config)` — the gate is observe-only unless it is
 * `{ gate: 'enforce' }`, which is itself pinned below.
 */
async function open(config) {
  const state = { warns: [], sessionHandler: undefined, preStepHandler: undefined, preExecuteHandler: undefined }
  const ctx = {
    logger: { warn: (message) => state.warns.push(String(message)) },
    on: (event, fn) => {
      if (event === 'session/event') state.sessionHandler = fn
      else if (event === 'agent/pre-step') state.preStepHandler = fn
      else if (event === 'tools/pre-execute') state.preExecuteHandler = fn
    },
  }
  const mod = await import(pathToFileURL(PLUGIN).href)
  mod.apply(ctx, config)
  if (typeof state.sessionHandler !== 'function') throw new Error('plugin did not subscribe to session/event')
  if (typeof state.preStepHandler !== 'function') throw new Error('plugin did not subscribe to agent/pre-step')
  // 闸门存在的**唯一静态证据**就是这条注册（没有它就没有任何拒绝、也没有竞态取证）⇒ 大声抛错。
  if (typeof state.preExecuteHandler !== 'function') {
    throw new Error('plugin did not subscribe to tools/pre-execute — the intent gate does not exist')
  }
  const session = (id) => ({ id })
  const observe = (id, turn, text) => state.sessionHandler(session(id), {
    type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })
  /** `turn/start` —— 真实会话在模型调用前先落它（agent-loop/src/agent.ts:278），闸门靠它认「当前轮」。 */
  const turnStart = (id, turn) => state.sessionHandler(session(id), { type: 'turn/start', data: { turn } })
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
  /** One `tools/pre-execute` call: the fake exec the gate inspects + the downstream decision it must await. */
  const preExec = (name, { id = 's1', decision = { kind: 'allow' } } = {}) => state.preExecuteHandler(
    { callId: 'call_gate', name, arguments: {}, agent: agent({ id }) },
    async () => decision,
  )
  return { state, session, observe, turnStart, agent, userMessages, preStep, preExec, call, dispatch, act, actPtc }
}

const ENTER = (messages) => ({ kind: 'enter', messages })
const injected = (decision) => Array.isArray(decision?.messages) && decision.messages.length > 1
/** Text of the last message in a pre-step decision ('' when there is none). */
const lastText = (decision) => {
  const messages = decision?.messages
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const content = messages[messages.length - 1]?.content
  return Array.isArray(content) && typeof content[0]?.text === 'string' ? content[0].text : ''
}

// ── 契约一致性（D）：插件的注入文案 ↔ persona 的模板 ─────────────────────────
//
// 门行的**契约**在两处各写了一遍：persona 是 system prompt（定义规则），插件是注入的提醒
// （近端重述）。它漂移过两次 —— token 迁移要同时改两处；判据也一度不一致（「任意位置」vs「首行」）。
// 下面把**能机械核对**的几条钉住：漂移即 FAIL，且每条都配一条内存变异对照证明不是空转。
//
// `--control` 下**不跑**这一段：对照 fixture 是**行为**阴性对照，它的文案故意不是现行契约，
// 拿它做文本一致性检查只会凭空多出无意义的失败。这一段自己的阴性对照是下面四条内存变异。
const PERSONA_PATH = path.join(__dirname, '..', 'preset', 'ptc-roles', 'personas', 'orchestrator.md')

// 判据 ①（存在档，2026-09-17 改）的锚点字面量，两处各写一遍、漂移即 FAIL：
//   persona  → 「the message that carries the first behavior-changing call」（该消息的**首行**）
//   提醒     → 「承载第一次动手的那条消息」+「必须是那条消息的首行」
// 旧锚点（persona 的 `message that OPENS the turn`、提醒的「开轮那条消息」/「同一条消息」）是**②前置档**
// 的措辞：② 只作对照读数、不再是义务，且「与动作同一条消息」现在是**合规**形态 ⇒ 三条断言全部**替换**
// （不是删除）成上面两个正向锚点 + 首行要求。
const PERSONA_CARRIER_ANCHOR = 'the message that carries the first behavior-changing call'
const REMINDER_CARRIER_ANCHOR = '承载第一次动手的那条消息'
const REMINDER_FIRSTLINE_ANCHOR = '必须是那条消息的首行'

/**
 * 抽 `const <name> = [ '…', '…' ]` 里的字符串字面量；解析不出返回 undefined。
 *
 * 必须按**深度扫描**而不是找第一个 `]`：提醒的第一行是 `[intent-gate-watchdog] …`，
 * 那个 `]` 会把数组提前截断（实测踩中，靠下面的「解析不出就 FAIL」守卫暴露出来 —— 守卫是有效的）。
 */
function arrayStrings(src, name) {
  const start = src.indexOf('const ' + name + ' = [')
  if (start < 0) return undefined
  const open = src.indexOf('[', start)
  if (open < 0) return undefined
  let body = ''
  let depth = 0
  let inString = false
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      body += ch
      if (ch === '\\') { i += 1; body += src[i] === undefined ? '' : src[i]; continue }
      if (ch === "'") inString = false
      continue
    }
    if (ch === "'") { inString = true; body += ch; continue }
    if (ch === '[') depth += 1
    else if (ch === ']') { depth -= 1; if (depth === 0) break }
    body += ch
  }
  if (depth !== 0 || inString) return undefined
  const out = []
  const re = /'((?:[^'\\]|\\.)*)'/g
  let m
  while ((m = re.exec(body)) !== null) out.push(m[1].replace(/\\n/g, '\n'))
  return out.length === 0 ? undefined : out
}

/** 六个桶的顺序（两处必须同一份枚举）。 */
function bucketSeq(text) {
  const m = /research\s*\/\s*implementation\s*\/\s*investigation\s*\/\s*evaluation\s*\/\s*fix\s*\/\s*open-ended/.exec(text)
  return m === null ? undefined : m[0].split(/[^a-z-]+/).filter(Boolean)
}

/** 契约漂移清单（空 = 一致）。 */
function contractFindings(pluginSrc, personaText) {
  const findings = []
  const markers = arrayStrings(pluginSrc, 'DEFAULT_MARKERS')
  const reminderLines = arrayStrings(pluginSrc, 'REMINDER')
  if (markers === undefined) findings.push('插件里解析不出 DEFAULT_MARKERS（结构变了吗）')
  // 提醒现在 3 行（判据 ① 把「先声明再动手」那句并进第一行了）。
  if (reminderLines === undefined || reminderLines.length < 3) findings.push('插件里解析不出 REMINDER（结构变了吗）')
  if (findings.length > 0) return findings
  const reminder = reminderLines.join('\n')
  for (const mk of markers) {
    if (!personaText.includes(mk)) findings.push('persona 里找不到插件匹配的字面 token「' + mk + '」')
    if (!reminder.includes(mk)) findings.push('提醒里找不到自己匹配的 token「' + mk + '」')
  }
  const pb = bucketSeq(personaText)
  const rb = bucketSeq(reminder)
  if (pb === undefined) findings.push('persona 里解析不出六个桶（枚举被改写了？）')
  else if (rb === undefined) findings.push('提醒里解析不出六个桶（枚举被改写了？）')
  else if (pb.join('/') !== rb.join('/')) findings.push('六桶不一致：persona=' + pb.join('/') + ' vs 提醒=' + rb.join('/'))
  // 判据 ①（存在档，2026-09-17 三改）：两处都必须要求「门行落在**承载第一次动手的那条消息**里，
  // 且是那条消息的**首行**」。旧的 ② 前置措辞（开轮那条消息 / 同一条消息）已废弃。
  if (!personaText.includes(PERSONA_CARRIER_ANCHOR)) {
    findings.push('persona 不再要求门行落在「' + PERSONA_CARRIER_ANCHOR + '」里')
  }
  if (!reminder.includes(REMINDER_CARRIER_ANCHOR)) {
    findings.push('提醒不再点名「' + REMINDER_CARRIER_ANCHOR + '」')
  }
  if (!reminder.includes(REMINDER_FIRSTLINE_ANCHOR)) {
    findings.push('提醒不再要求门行是「' + REMINDER_FIRSTLINE_ANCHOR + '」')
  }
  const example = reminderLines.find((l) => l.trim().indexOf('例') === 0)
  if (example !== undefined && !markers.some((mk) => example.includes(mk))) {
    findings.push('提醒里的示例行不以任何 marker 开头：' + example.slice(0, 40))
  }
  return findings
}

/** 契约检查自证：真文件比一次 + 五条内存变异各自必须被抓到。 */
function contractSelfTest(pluginSrc, personaText) {
  const out = []
  const clean = contractFindings(pluginSrc, personaText)
  out.push({ name: '契约一致：插件 token / 六桶 / 存在档锚点 ↔ persona 模板', ok: clean.length === 0, detail: clean.join('；') })
  /**
   * 一条对照 = 一次内存变异 + 「报告里必须出现这个 needle」。
   * ⚠ 变异没打中（目标文本已不存在）时，**这条对照自己 FAIL**，绝不带占位对象往下走 —— 旧写法把
   * `{ p: '对照组失效' }` 塞进 findings，下一行 `f.includes(needle)` 直接 TypeError（实测踩中：
   * 判据从 ② 改成 ① 后「开轮那条消息」「同一条消息」两个变异目标同时消失）。见 pitfalls #21
   * 「对照自己也要能被验伪」：一次「对照没打中」长得和「对照通过」一模一样。
   */
  const control = (label, mutated, needle) => {
    if (mutated === undefined) {
      out.push({ name: label, ok: false, detail: '对照组失效：内存变异的目标文本已不在插件/persona 里（锚点漂移）—— 这条对照必须重写' })
      return
    }
    const findings = mutated
    const hit = Array.isArray(findings) && findings.some((f) => typeof f === 'string' && f.includes(needle))
    out.push({ name: label, ok: hit, detail: hit ? '' : '期望报告含「' + needle + '」，实得：' + (findings.join('；') || '（无 finding）') })
  }
  const mutate = (text, from, to) => { const next = text.split(from).join(to); return next === text ? undefined : next }
  const personaNoToken = mutate(personaText, 'Intent:', 'IntentX:')
  control('对照⑤：persona 的 token 被改写 ⇒ 报告 token 漂移',
    personaNoToken === undefined ? undefined : contractFindings(pluginSrc, personaNoToken), 'Intent:')
  const personaNoBuckets = mutate(personaText, 'research / implementation / investigation / evaluation / fix / open-ended', 'research / implementation / investigation / evaluation / fix')
  control('对照⑥：persona 的桶少一个 ⇒ 报告六桶漂移',
    personaNoBuckets === undefined ? undefined : contractFindings(pluginSrc, personaNoBuckets), '六个桶')
  const personaNoCarrier = mutate(personaText, PERSONA_CARRIER_ANCHOR, 'the message that OPENS the turn')
  control('对照⑦：persona 不再要求「承载第一次动手的那条消息」⇒ 报告 persona 锚点漂移',
    personaNoCarrier === undefined ? undefined : contractFindings(pluginSrc, personaNoCarrier), PERSONA_CARRIER_ANCHOR)
  const pluginNoCarrier = mutate(pluginSrc, REMINDER_CARRIER_ANCHOR, '某条消息')
  control('对照⑨：提醒不再点名「承载第一次动手的那条消息」⇒ 报告提醒锚点漂移',
    pluginNoCarrier === undefined ? undefined : contractFindings(pluginNoCarrier, personaText), REMINDER_CARRIER_ANCHOR)
  const pluginNoFirstline = mutate(pluginSrc, REMINDER_FIRSTLINE_ANCHOR, '随便哪一行都行')
  control('对照⑩：提醒不再要求「必须是那条消息的首行」⇒ 报告首行要求漂移',
    pluginNoFirstline === undefined ? undefined : contractFindings(pluginNoFirstline, personaText), REMINDER_FIRSTLINE_ANCHOR)
  const pluginExample = mutate(pluginSrc, 'Intent: fix — ', 'Fix: — ')
  control('对照⑧：提醒的示例行丢掉 token ⇒ 报告示例漂移',
    pluginExample === undefined ? undefined : contractFindings(pluginExample, personaText), '示例')
  return out
}

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

  // 3 — compliant previous turn -> silence. 判据 ①（design choice 6）：门行所在消息只需
  // **不晚于**首个行为动作的载体消息（`declSeq <= firstActCarrier`）。
  {
    const h = await open()
    h.observe('s1', 1, 'Intent: implementation — 先读再改。')
    h.call('s1', 1, 'read', 'call_read_0')
    h.observe('s1', 1, '读完了，开始改。')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('stays silent when the declaration preceded the first behavior action', !injected(d))
  }

  // 3a — 判据 ① 翻掉的那条：门行与动作**同一条消息**（同一次生成）现在是**合规**形态
  // （`declSeq === firstActCarrier`，`<=` 而不是 `<`）⇒ 插件必须保持沉默。
  // 这条断言就是 `<` 与 `<=` 的分界线：任何把判据收回 ② 的实现都会在这里变红。
  {
    const h = await open()
    h.observe('s1', 1, 'Intent: implementation — 改这个文件。')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('stays silent when the declaration shares the message with the first behavior action', !injected(d))
  }

  // 3d — PTC counterpart of case 3: the declaration rides the opening message, and the
  // behavior tool is dispatched INSIDE the next run_code (carrier mapping via rootCallId).
  {
    const h = await open()
    h.observe('s1', 1, 'Intent: implementation — 先侦察再动手。')
    h.call('s1', 1, 'run_code', 'call_ptc_a')
    h.observe('s1', 1, '现在动手。')
    h.call('s1', 1, 'run_code', 'call_ptc_b')
    h.dispatch('s1', 'write', 'call_ptc_b')
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('stays silent when a PTC declaration precedes the run_code that dispatches it', !injected(d))
  }

  // 3b / 3c — 两种**真正的 ① 违约**（design choice 6）：
  //   3b 门行不在消息首行（`declSeq` 根本没被记上）；
  //   3c 门行落在了动作**之后**的消息里（`declSeq > firstActCarrier`）—— 所以行为调用先发、
  //      带门行的消息后发（旧版把顺序写反了，那其实落进 3a 的合规形态，已重建）。
  // 两条都必须在阴性对照身上失败。
  {
    const h = await open()
    h.observe('s1', 1, '先说一句。\nIntent: research — 去查一下。')
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('reminds when the marker is only on a later line of the first reply', injected(d))
  }
  {
    const h = await open()
    h.observe('s1', 1, '先干起来，没有分类行。')
    h.act('s1', 1)                                                // 载体消息 = 第 1 条 ⇒ firstActCarrier = 1
    h.observe('s1', 1, 'Intent: research — 补一句。')              // 门行到得更晚 ⇒ declSeq = 2 > 1
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('reminds when the marker arrives in a later message than the action carrier', injected(d))
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

  // 12 — a downstream failure is rethrown, never swallowed.
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

  // 13 — malformed payloads and events must not throw.
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

  // 14 / 15 — a read-only turn is not one the rule covers -> silence (native & PTC).
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

  // 16 — in PTC the behavior tool is visible ONLY on the dispatch event, and that event
  // carries no `turn`: attribution goes through the root call id.
  {
    const h = await open()
    h.observe('s1', 1, '直接开干，没有分类行。')
    h.actPtc('s1', 1, 'write')
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('reminds when the previous turn dispatched a behavior tool through run_code', injected(d))
  }

  // 17 — an unattributable dispatch must be LOUD: silence there would mean the eligibility
  // rule has gone blind, which is exactly the failure mode this plugin exists to expose.
  {
    const h = await open()
    h.dispatch('s1', 'write', 'call_never_seen')
    check('reports an unattributable dispatch instead of staying silent',
      h.state.warns.some(w => w.includes('no attributable turn')))
  }

  // ── 闸门（tools/pre-execute）与观察取证 ────────────────────────────────────────
  //
  // 时序事实（两条，决定下面每个 case 的形状）：
  //   · 真实会话在模型调用前先落 `turn/start`（agent.ts:278）⇒ 闸门用 lastTurn 认「当前轮」；
  //   · `assistant/message` 与随后的 `tools/pre-execute` 谁先到**无法静态证明**（design choice 7）
  //     ⇒ 默认观察模式：闸门只记录 `wouldDeny`，绝不拒绝。
  // 载体（carrier）= 产生该 tool/call 的那条 assistant 消息；闸门算的是「门行 <= 载体」。

  // 18 — observe 模式：闸门记录但永不拒绝，下游的 allow 原样返回（同一个对象，不是副本）。
  // 「记录」那一半由 21（竞态取证）证明：没有 wouldDeny 就没有那条报告。
  {
    const h = await open()                                    // 无 config ⇒ 观察模式
    const allow = { kind: 'allow' }
    h.turnStart('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    const d = await h.preExec('write', { decision: allow })
    check('gate in observe mode never denies, and returns the downstream allow untouched',
      d === allow && d.kind === 'allow', JSON.stringify(d))
  }

  // 19 — enforce 模式：未声明的行为调用被拒，理由里必须出现字面 token `Intent:`（模型据此知道要补什么）。
  {
    const h = await open({ gate: 'enforce' })
    h.turnStart('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    h.observe('s1', 1, '直接开干，没有分类行。')
    const d = await h.preExec('write')
    check('gate in enforce mode denies the undeclared behavior call and names the marker token',
      d?.kind === 'deny' && typeof d.reason === 'string' && d.reason.includes('Intent:'), JSON.stringify(d))
  }

  // 20 — 每轮至多拒一次（`denied` 位），但下一轮重新武装（不是一次会话只拒一次）。
  {
    const h = await open({ gate: 'enforce' })
    h.turnStart('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    h.observe('s1', 1, '直接开干，没有分类行。')
    const first = await h.preExec('write')
    const second = await h.preExec('write')
    h.turnStart('s1', 2)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    h.observe('s1', 2, '这一轮又没有分类行。')
    const nextTurn = await h.preExec('write')
    check('gate denies at most once per turn, then re-arms on the next turn',
      first?.kind === 'deny' && second?.kind === 'allow' && nextTurn?.kind === 'deny',
      JSON.stringify([first?.kind, second?.kind, nextTurn?.kind]))
  }

  // 21 — 不是真人开的轮次（子代理通知 / goal 轮）永不拒；同一个实例在真人轮上照样拒。
  {
    const h = await open({ gate: 'enforce' })
    h.turnStart('s1', 1)
    h.observe('s1', 1, '机器开轮，没有分类行。')
    const machine = await h.preExec('write')                  // 没有 pre-step ⇒ 没有 userTurn
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    const real = await h.preExec('write')                     // 同一个 turn：现在有真人开轮记录
    check('gate skips a turn no real user message opened, and still gates a real one',
      machine?.kind === 'allow' && real?.kind === 'deny',
      JSON.stringify([machine?.kind, real?.kind]))
  }

  // 22 — 闸门绝不覆盖别的监听器的决定（与 agent/pre-step 的 never-veto 同一条纪律）：
  // 下游不是 allow 时，返回的必须是**下游那个对象本身**。
  {
    const h = await open({ gate: 'enforce' })
    h.turnStart('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    h.observe('s1', 1, '直接开干，没有分类行。')
    const downstream = { kind: 'deny', reason: 'downstream policy' }
    const d = await h.preExec('write', { decision: downstream })
    check('gate never overrides a downstream non-allow decision', d === downstream, JSON.stringify(d))
  }

  // 23 — 观察取证的**唯一**触发形态：闸门在动作到达时没看到门行（wouldDeny），而该轮最终合规。
  // 这条时序就是 design choice 7 说的那个无法静态证明的竞态：assistant/message 比该消息里的
  // tools/pre-execute 晚到 ⇒ 闸门算出的 carrier 落后于真正的载体，而门行随后才被听到。
  {
    const h = await open()
    const allow = { kind: 'allow' }
    h.turnStart('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    const raced = await h.preExec('write', { decision: allow })   // 这条 assistant/message 还没到 ⇒ carrier = -1
    h.observe('s1', 1, 'Intent: implementation — 动手。')          // 门行随后才被听到 ⇒ declSeq = 1
    h.act('s1', 1)                                                // 载体 = 1 ⇒ ① 合规
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('observe mode injects the race report when the gate missed a line the turn did carry',
      raced === allow && injected(d) && lastText(d).includes('observe 取证'),
      JSON.stringify(d).slice(0, 160))
  }

  // 24 — 「仅当」的另一半：闸门**看到了**门行（declSeq <= carrier）⇒ 没有假拒候选，什么也不注入。
  {
    const h = await open()
    h.turnStart('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    h.observe('s1', 1, 'Intent: implementation — 动手。')
    await h.preExec('write')                                      // declSeq = carrier = 1 ⇒ 不记 wouldDeny
    h.act('s1', 1)
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('observe mode reports no race when the gate saw the line in the carrier message', !injected(d))
  }

  // 25 — 「仅当」的第三格：wouldDeny 但该轮**不**合规 ⇒ 该提醒就提醒，绝不能用 RACE_REPORT 顶替。
  {
    const h = await open()
    h.turnStart('s1', 1)
    await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 1, step: 1 })
    await h.preExec('write')                                      // carrier = -1 ⇒ wouldDeny
    h.observe('s1', 1, '直接开干，没有分类行。')
    h.act('s1', 1)                                                // ① 不合规（从未记到门行）
    const d = await h.preStep({ agent: h.agent(), messages: h.userMessages, turn: 2, step: 1 })
    check('observe mode does not disguise a real miss as a race report',
      injected(d) && !lastText(d).includes('observe 取证'), JSON.stringify(d).slice(0, 160))
  }

  if (!CONTROL_MODE) {
    console.log('\n契约一致性（D —— 插件文案 ↔ persona 模板；--control 下跳过）:')
    let pluginSrcText
    let personaText
    try {
      pluginSrcText = fs.readFileSync(PLUGIN, 'utf8')
      personaText = fs.readFileSync(PERSONA_PATH, 'utf8')
    } catch (e) {
      check('preset 插件与 persona 可读', false, String((e && e.message) || e))
    }
    if (pluginSrcText !== undefined && personaText !== undefined) {
      for (const t of contractSelfTest(pluginSrcText, personaText)) check(t.name, t.ok, t.detail)
    }
  }

  console.log('\n汇总: ' + (checks - failures) + '/' + checks + ' 通过' + (failures === 0 ? '  ✓ 全绿' : '  ✗ ' + failures + ' 项失败'))

  if (CONTROL_MODE) {
    const required = new Set(REQUIRED_CONTROL_FAILURES)
    const failed = new Set(failedNames)
    const missing = REQUIRED_CONTROL_FAILURES.filter((name) => !failed.has(name))
    const extra = failedNames.filter((name) => !required.has(name))
    const ok = missing.length === 0 && extra.length === 0
    console.log(ok
      ? '阴性对照符合预期：失败断言名集合恰等于 REQUIRED_CONTROL_FAILURES（' + REQUIRED_CONTROL_FAILURES.length + ' 条，一一对应 / 集合相等 —— 无遗漏、无多出，共 ' + failures + ' 项失败）—— 断言确实抓得住"该提醒时不提醒/乱提醒/乱拒"的实现。'
      : '⚠ 阴性对照不符合预期：'
        + (missing.length > 0 ? '这些断言在对照版上竟然通过了 → ' + missing.join(' | ') : '')
        + (extra.length > 0 ? (missing.length > 0 ? '；' : '') + '这些断言意外多失败了 → ' + extra.join(' | ') : ''))
    process.exitCode = ok ? 0 : 1
    return
  }
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => { console.error('harness error: ' + String(err && err.stack || err)); process.exitCode = 2 })
