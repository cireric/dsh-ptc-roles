// intent-gate-watchdog.mjs — ptc-roles preset companion plugin.
//
// WHY THIS EXISTS
// The orchestrator persona's Phase 0 "Intent Gate" (classify in ONE cheap line
// before acting) is a per-turn RULE WITH ZERO CONSEQUENCE: nothing fails when a
// turn skips it. Measured on this project's own session log (2026-09-14): 26
// turns, the gate line appeared in 2 visible replies (turns 1-2) and never again
// — it collapsed at turn 3 and stayed collapsed. The rule also sits at the far
// end of the prompt (the preset persona IS the system prompt's `prefix`), so
// recency weighted the last ~100k tokens of tool output far above it.
//
// HOW IT WORKS — three official hook points, each with in-tree precedent:
//   * `session/event` — the session firehose, typed as `SessionEvent` (so every
//     persisted event type arrives, tool events included; core/session/src/index.ts:72).
//     Two things are observed per turn: whether the marker appeared in the assistant
//     text, and whether a BEHAVIOR-CHANGING tool ran (see design choice 5).
//     Precedents: llm/token-meter/src/index.ts:119,
//     context/agent-instructions/src/index.ts:307, core/agent-loop/src/runtime-context.ts:129.
//   * `agent/pre-step` — a waterfall whose decision may carry messages back
//     (`PreStepDecision`, packages/core/agent/src/runtime-types.ts:111-119). When the
//     PREVIOUS turn's reply lacked the marker, append ONE reminder message.
//     Skeleton from packages/guard/repeat-tool-reminder/src/index.ts:229 — the
//     official "advisory nudge" guard: delegate with `next()`, then fold in only
//     its own message, never vetoing.
//   * `tools/pre-execute` — the ONLY point that can stop a call (pitfalls #20;
//     packages/core/tools/src/index.ts:1465-1468; PTC inner dispatches pass through it too,
//     ptc.ts:541-545). Ships in `observe` mode by default — see design choice 7.
//
// DESIGN CHOICES (each one is a path where a naive version fails silently)
//   1. NEVER VETO. The downstream decision is awaited first and returned
//      unchanged unless it is `enter` — another listener's `reject` must not be
//      overridden, and blocking steps is not this plugin's job.
//   2. ONCE PER TURN, AND ONLY WHEN A REAL USER MESSAGE ENTERS. A turn has many
//      steps (151 steps over 27 turns in the measurement); without this the
//      reminder would repeat on every tool-call step. Machine-driven turns
//      (subagent notices, goal rounds) are skipped by requiring a `user` source.
//   3. ORCHESTRATOR ONLY (depth 0). Role children have their own personas and run
//      cheaper models; the gate is an orchestrator discipline. Depth is resolved
//      the way the harness resolves it — `Math.max` of the persisted header floor
//      and the runtime option (subagent/src/depth.ts:28-36) — DELIBERATELY copied
//      from role-presentation.mjs rather than shared: `dev_reload_preset` only
//      bumps `?v=N` on `.mjs` files referenced from agent.cordis.yml, so a shared
//      sibling module would keep one frozen specifier and a fix to it would never
//      reach a new session. Keep the two copies in sync.
//   4. FAIL LOUD, NEVER BREAK THE STEP. Every path is wrapped; failures go to
//      ctx.logger.warn, and a downstream failure is rethrown rather than
//      swallowed. NOTE this deployment has NO log sink (docs/pitfalls.md #9), so
//      the channel that actually makes a regression visible is
//      `scripts/verify-intent-gate-watchdog.cjs` — keep it green.
//   5. ONLY NUDGE TURNS THE RULE ACTUALLY COVERS. The persona scopes Phase 0 to
//      behavior-changing turns (delegate / refuse / ask / edit files), so a read-only
//      lookup or a plain answer must NOT be nagged. Eligibility is resolved from the
//      DATA PLANE, never from prose: a turn counts as acting when one of its tool
//      calls names a behavior tool. In PTC that name arrives on
//      `tool/ptc-dispatch`/`tool/ptc-dispatch-start`, which carry no `turn` — so the
//      root call id is mapped back through `tool/call`; a native agent's name arrives
//      on `tool/call` itself. Boundary: an "I refuse, no tool" turn is not detectable
//      and therefore never nudged.
//      ⚠ BEHAVIOR_TOOLS is a deliberate second copy of the same list in
//      `scripts/verify-ptc-roles.cjs` (its compliance denominator). Drift is visible,
//      not silent: when the two disagree the compliance rate flips.
//   6. "DECLARED" MEANS THE MARKER SAT ON THE FIRST LINE OF THE MESSAGE THAT CARRIES
//      THE FIRST BEHAVIOR ACTION — or of an earlier message in the same turn. The earlier
//      form is the better one and is still MEASURED (the verifier reports it as the 前置
//      contrast reading, `rec.declSeq < rec.firstActCarrier`); it is no longer what this
//      plugin nags about, and it is no longer the obligation. Two harness facts bound the
//      shape that IS required:
//        · text and tool calls inside one assistant message are a SINGLE generation
//          (agent-loop/src/agent.ts:466-489), so the line has to be in that message while
//          the call is being made — which is exactly what `tools/pre-execute` sees;
//        · a message with no tool call ENDS the turn (agent.ts:487-488), so
//          "declare in a message of its own, then act" is impossible in this harness.
//      One criterion, three readers: this plugin's reminder, its pre-execute gate, and the
//      verifier's compliance numerator (`verify-ptc-roles.cjs`). The two drifted apart once
//      already (2026-09-16, "anywhere" vs "first line"), which is why the口径 is registered
//      in docs/pitfalls.md #19. Keep them equal.
//   7. THE GATE IS OPT-IN AND FAIL-SAFE. `apply(ctx, config)` reads `config.gate`; anything
//      other than the literal 'enforce' means observe-only. The reason is an ORDERING
//      assumption that cannot be proven statically — whether the CURRENT message's
//      `assistant/message` event reaches this listener before `tools/pre-execute` fires — so
//      observe mode reports a suspected race as a data-plane line instead of denying what may
//      be a compliant call, and 'enforce' is switched on only after that report stays empty.
//      At most ONE deny per turn, so a model that ignores the reason is never walled in.
//
// Zero `@deepseek-ai/*` imports on purpose (a preset directory lives under the
// user home, where Node cannot resolve the harness packages); Node builtins are
// allowed. The injected message must match `createUserMessage`'s shape exactly
// (llm/src/message.ts:186-211), which is why `pluginMessage` re-implements it.

import { randomUUID } from 'node:crypto'

export const name = 'intent-gate-watchdog'

/**
 * Literal markers that count as "the gate line was emitted". Keep in sync with the
 * persona's template (personas/orchestrator.md) — the token migrated from 意图判定 to
 * `Intent:` on 2026-09-16. The verifier (scripts/verify-ptc-roles.cjs) additionally
 * accepts the legacy token because it scores HISTORICAL sessions; this plugin only ever
 * looks at the previous turn, so it stays strict.
 */
const DEFAULT_MARKERS = ['Intent:']

/**
 * Tools whose use makes a turn "behavior-changing" — the turns the persona's Phase 0
 * line is required on. Keep in sync with BEHAVIOR_TOOLS in scripts/verify-ptc-roles.cjs.
 */
const BEHAVIOR_TOOLS = new Set([
  'write', 'edit', 'bash', 'pwsh',
  'explorer', 'librarian', 'oracle', 'implementer', 'designer',
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'ralph',
  'ask_user_question',
])

/** The single reminder appended when the previous turn skipped the gate. */
const REMINDER = [
  '[intent-gate-watchdog] 上一轮是会改变行为的轮次（委派 / 拒绝 / 提问 / 改文件），但门行没有出现在**承载第一次动手的那条消息**里 —— 它必须是那条消息的首行。',
  '桶只取六个：research / implementation / investigation / evaluation / fix / open-ended；`Intent:` 是字面 token，照抄勿译。这一行的读者是**用户**：别照抄他的话，也别塞内部记账（turn/step 号、插件状态、证据文件名、脚本通过数）。',
  '例（与本轮无关）：Intent: fix — 你要的是定位 401 的根因并修掉（依据：你贴的报错）；我先复现再改。',
].join('\n')

/** The gate's deny reason: its single, in-place shot at telling the model what is missing. */
const GATE_REASON = [
  '[intent-gate] 这一次调用没有门行垫底 —— 本轮还没有出现过那个六桶行。',
  '先在下一条消息写上它（是该消息的**首行**），再重发刚才的调用：',
  'Intent: <桶> — <你要的结果>（依据：<你话里让我这么读的那一点>）；我打算 <做法>。',
].join('\n')

/**
 * Observe-mode diagnostic (design choice 7). Injected — and therefore written into the session
 * log — when the gate saw no declaration at call time but the turn still scores compliant.
 * That pair is a false-deny candidate; logger.warn has no sink in this deployment (pitfalls #9),
 * so the data plane is the only channel that keeps it falsifiable.
 */
const RACE_REPORT = [
  '[intent-gate-watchdog] observe 取证：闸门在第一次动手到达时**没有看到**门行，而该轮最终判为合规 —— 假拒候选（事件时序竞态）。',
  '⇒ 开闸（config: { gate: enforce }）之前必须先查清这一条；它是数据面证据，别删。',
].join('\n')

/** Deep-freeze a plain value in place (mirrors llm's `freezeMessage`). */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Re-implementation of `createUserMessage` (llm/src/message.ts:186-211): a fresh
 * randomUUID identity, role `user`, text content, and a plugin notice source.
 * Keep in sync with that file if the message shape ever changes.
 */
function pluginMessage(text, plugin) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form: 'notice', summary: 'intent gate missing' },
  })
}

/** Concatenate the text blocks of one assistant message. */
function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text + '\n'
  }
  return text
}

/**
 * Resolve an agent's delegation depth the way the harness does.
 * @returns the depth, or `undefined` when the runtime option is present but
 *   malformed (the harness throws a TypeError there; this plugin reports it and
 *   skips rather than guessing at a child's identity).
 */
function resolveDepth(agent) {
  const header = agent?.session?.header?.delegationDepth ?? 0
  const runtime = agent?.options?.subagentDepth
  if (runtime === undefined) return Math.max(header, 0)
  if (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0)) return undefined
  return Math.max(header, runtime)
}

/**
 * Install the watchdog's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 */
export function apply(ctx, config) {
  const markers = DEFAULT_MARKERS
  // Fail-safe, not fail-silent: anything but the literal 'enforce' keeps the gate in observe
  // mode, so a mistyped key can never start denying calls. The switch itself is pinned by the
  // unit test's two gate assertions (observe never denies / enforce denies once).
  const gateEnforcing = config !== null && typeof config === 'object' && config.gate === 'enforce'
  const warn = (message) => ctx.logger?.warn('[' + name + '] ' + message)

  /** sessionId -> turn -> { declSeq, firstActCarrier, acting }（判据见 design choice 6）。 */
  const turns = new Map()
  /** sessionId -> callId -> { turn, carrier } —— 派发事件（无 turn）靠它归属轮次与「载体消息」。 */
  const callTurns = new Map()
  /** sessionId -> 单调递增的 assistant 消息序号；只在同一轮内比较先后。 */
  const msgSeq = new Map()
  /** sessionId -> 最近一条 assistant 消息的序号 —— 紧随其后的 tool/call 就产生自它。 */
  const lastMsg = new Map()
  /** sessionId -> the turn this plugin already reminded. */
  const reminded = new Map()
  /** sessionId -> the turn of the most recent turn-carrying event (tools/pre-execute has none). */
  const lastTurn = new Map()
  /** sessionId -> the turn a REAL user message opened; machine-driven turns are out of scope. */
  const userTurn = new Map()
  /** sessionId -> turn -> { wouldDeny, denied } — what the gate saw, and what it did. */
  const gateSeen = new Map()
  const gateRec = (sessionId, turn) => {
    let byTurn = gateSeen.get(sessionId)
    if (byTurn === undefined) { byTurn = new Map(); gateSeen.set(sessionId, byTurn) }
    let rec = byTurn.get(turn)
    if (rec === undefined) { rec = { wouldDeny: false, denied: false }; byTurn.set(turn, rec) }
    return rec
  }
  const recFor = (sessionId, turn) => {
    let byTurn = turns.get(sessionId)
    if (byTurn === undefined) { byTurn = new Map(); turns.set(sessionId, byTurn) }
    let rec = byTurn.get(turn)
    if (rec === undefined) {
      rec = { declSeq: undefined, firstActCarrier: undefined, acting: false }
      byTurn.set(turn, rec)
    }
    return rec
  }
  /** 记一次行为动作：**首个**动作的载体消息序号决定该轮合不合规（design choice 6）。 */
  const noteAction = (sessionId, turn, carrier) => {
    const rec = recFor(sessionId, turn)
    rec.acting = true
    if (rec.firstActCarrier === undefined) rec.firstActCarrier = carrier
  }
  /** 合规（① 存在档）= 确实动过手，且门行落在**承载第一次动手的那条消息**或其之前（含同一条）。 */
  const compliant = (rec) => rec !== undefined && rec.acting === true
    && rec.declSeq !== undefined && rec.firstActCarrier !== undefined
    && rec.declSeq <= rec.firstActCarrier

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (sessionId === undefined) return
      if (typeof event?.data?.turn === 'number') lastTurn.set(sessionId, event.data.turn)
      if (event?.type === 'assistant/message') {
        const turn = event.data?.turn
        if (typeof turn !== 'number') return
        // 每条 assistant 消息都占一个序号（**包括没有文本的纯工具调用消息** —— 它正是那些
        // tool/call 的载体消息；漏掉它，载体映射会整体前移一格）。
        const seq = (msgSeq.get(sessionId) ?? 0) + 1
        msgSeq.set(sessionId, seq)
        lastMsg.set(sessionId, seq)
        const text = messageText(event.data?.message)
        if (text.trim() !== '') {
          const rec = recFor(sessionId, turn)
          // 认**第一次**出现的门行（该行必须是某条消息的**首行**），之后的文本不再改判。
          if (rec.declSeq === undefined && markers.some(marker => text.split('\n')[0].includes(marker))) {
            rec.declSeq = seq
          }
        }
        const byTurn = turns.get(sessionId)
        if (byTurn !== undefined) for (const key of [...byTurn.keys()]) if (key < turn - 1) byTurn.delete(key)
        return
      }
      // `tool/call` names the tool AND carries the turn. In PTC the outer call is
      // `run_code`, so its id is remembered and the inner names resolve through it.
      if (event?.type === 'tool/call') {
        const turn = event.data?.turn
        if (typeof turn !== 'number') return
        // 载体 = 产生这次调用的那条消息（tool/call 事件紧随它的 assistant/message）。
        const carrier = lastMsg.get(sessionId) ?? -1
        const callId = event.data?.callId
        if (typeof callId === 'string') {
          let byCall = callTurns.get(sessionId)
          if (byCall === undefined) { byCall = new Map(); callTurns.set(sessionId, byCall) }
          byCall.set(callId, { turn, carrier })
          for (const [id, seen] of byCall) if (seen.turn < turn - 1) byCall.delete(id)
        }
        if (BEHAVIOR_TOOLS.has(event.data?.name)) noteAction(sessionId, turn, carrier)
        return
      }
      if (event?.type === 'tool/ptc-dispatch' || event?.type === 'tool/ptc-dispatch-start') {
        const name = event.data?.name
        if (!BEHAVIOR_TOOLS.has(name)) return
        const owner = callTurns.get(sessionId)?.get(event.data?.rootCallId)
        if (owner === undefined) {
          // Loud, never silent: an unattributable dispatch means the eligibility rule
          // above can no longer see this turn. Asserted by the unit test's PTC case.
          warn('behavior tool "' + String(name) + '" has no attributable turn (rootCallId ' + String(event.data?.rootCallId) + ')')
          return
        }
        noteAction(sessionId, owner.turn, owner.carrier)
      }
    } catch (err) {
      warn('session/event observer failed: ' + String(err))
    }
  })

  /**
   * The gate — ORDERS, never vetoes: the downstream decision is awaited first and returned
   * untouched unless it is `allow`. Deny is gated on `gateEnforcing` (design choice 7).
   */
  ctx.on('tools/pre-execute', async (exec, next) => {
    let decision
    try {
      decision = await next()
    } catch (err) {
      warn('downstream tools/pre-execute failed: ' + String(err))
      throw err
    }
    try {
      if (decision?.kind !== 'allow') return decision
      const toolName = exec?.name
      if (!BEHAVIOR_TOOLS.has(toolName)) return decision
      const sessionId = exec?.agent?.session?.id
      if (sessionId === undefined) return decision
      const turn = lastTurn.get(sessionId)
      if (turn === undefined || userTurn.get(sessionId) !== turn) return decision
      const rec = recFor(sessionId, turn)
      // 载体 = 产生这次调用的那条消息；同一条消息里的门行算数，这正是 ① 档的定义。
      const carrier = lastMsg.get(sessionId) ?? -1
      if (rec.declSeq !== undefined && rec.declSeq <= carrier) return decision
      const gate = gateRec(sessionId, turn)
      gate.wouldDeny = true
      if (!gateEnforcing || gate.denied) return decision
      gate.denied = true
      return { kind: 'deny', reason: GATE_REASON }
    } catch (err) {
      warn('could not evaluate the intent gate: ' + String(err))
      return decision
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch (err) {
      // Never swallow a downstream failure: report it and let it propagate.
      warn('downstream agent/pre-step failed: ' + String(err))
      throw err
    }
    try {
      const { agent, messages, turn } = payload ?? {}
      if (decision?.kind !== 'enter') return decision                       // (1) never veto
      if (!Array.isArray(messages) || !messages.some(m => m?.source?.kind === 'user')) return decision  // (2)
      const depth = resolveDepth(agent)
      if (depth === undefined) {
        warn('agent.options.subagentDepth is malformed; skipping instead of guessing the depth')
        return decision
      }
      if (depth !== 0) return decision                                      // (3) orchestrator only
      const sessionId = agent?.session?.id
      if (sessionId === undefined) return decision
      userTurn.set(sessionId, turn)
      if (reminded.get(sessionId) === turn) return decision                  // (2) once per turn
      // 记录不存在（上一轮没有任何 assistant 消息）**不算漏**。只有「确实动过手、且门行没赶在
      // 动手之前」才提醒 —— 判据与合规分子同口径（design choice 6），两处已经漂移过一次。
      const previous = turns.get(sessionId)?.get(turn - 1)
      if (previous === undefined || previous.acting !== true) return decision
      const gate = gateSeen.get(sessionId)?.get(turn - 1)
      if (compliant(previous)) {
        // Observe-mode取证（design choice 7）：闸门在动作到达时没看到门行，而该轮最终合规
        // ⇒ 假拒候选。它不是提醒，是**证据**，所以只在观察模式、且确有其事时注入一次。
        if (gate?.wouldDeny === true && gate.denied !== true) {
          return { ...decision, messages: [...decision.messages, pluginMessage(RACE_REPORT, name)] }
        }
        return decision
      }
      reminded.set(sessionId, turn)
      return { ...decision, messages: [...decision.messages, pluginMessage(REMINDER, name)] }
    } catch (err) {
      warn('could not inject the intent-gate reminder: ' + String(err))
      return decision
    }
  })
}
