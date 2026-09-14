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
// HOW IT WORKS — two official hook points, each with in-tree precedent:
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
//      and the runtime option (subagent/src/depth.ts:28-36) — the same arithmetic
//      role-presentation.mjs re-implements.
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
//
// Zero `@deepseek-ai/*` imports on purpose (a preset directory lives under the
// user home, where Node cannot resolve the harness packages); Node builtins are
// allowed. The injected message must match `createUserMessage`'s shape exactly
// (llm/src/message.ts:186-211), which is why `pluginMessage` re-implements it.

import { randomUUID } from 'node:crypto'

export const name = 'intent-gate-watchdog'

/** Literal markers that count as "the gate line was emitted". Overridable via config. */
const DEFAULT_MARKERS = ['意图判定']

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
  '[intent-gate-watchdog] 上一轮是会改变行为的轮次（要委派 / 要拒绝 / 要提问 / 要改文件），但没有输出「意图判定」行。',
  '这一行的读者是**用户**，用途是动手前对齐需求：用结果说清你判断他要什么、依据是哪一点，再给出做法。格式：',
  '意图判定：<桶> — 你要的是 <结果/目的>（依据：<你话里让我这么读的那一点>）；我打算 <做法>。',
  '桶只取这六个：research / implementation / investigation / evaluation / fix / open-ended。',
  '⚠ 两件别做：①别照抄用户的话（复述 ≠ 理解）；②别塞内部记账（turn/step 号、看门狗或插件状态、',
  '证据文件名、脚本通过数）—— 用户拿这些做不了决定。这一行是承诺不是标签，请在回复第一行补上。',
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
 * Validate the marker list, failing LOUD at load time (like repeat-tool-reminder's
 * threshold validation) instead of silently watching for nothing.
 */
function resolveMarkers(config) {
  const configured = config?.markers
  if (configured === undefined) return DEFAULT_MARKERS
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error('intent-gate-watchdog: config.markers must be a non-empty array of strings')
  }
  for (const marker of configured) {
    if (typeof marker !== 'string' || marker.trim() === '') {
      throw new Error('intent-gate-watchdog: every config.markers entry must be a non-empty string')
    }
  }
  return configured
}

/**
 * Install the watchdog's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - optional `{ markers?: string[] }`.
 */
export function apply(ctx, config) {
  const markers = resolveMarkers(config)
  const warn = (message) => ctx.logger?.warn('[' + name + '] ' + message)

  /** sessionId -> turn -> whether the marker appeared in that turn's assistant text. */
  const turns = new Map()
  /** sessionId -> turn -> whether a behavior-changing tool ran in that turn (design choice 5). */
  const acting = new Map()
  /** sessionId -> callId -> turn, so a dispatch event (which carries no `turn`) can be attributed. */
  const callTurns = new Map()
  /** sessionId -> the turn this plugin already reminded. */
  const reminded = new Map()
  const markActing = (sessionId, turn) => {
    let byTurn = acting.get(sessionId)
    if (byTurn === undefined) { byTurn = new Map(); acting.set(sessionId, byTurn) }
    byTurn.set(turn, true)
    for (const key of [...byTurn.keys()]) if (key < turn - 1) byTurn.delete(key)
  }

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (sessionId === undefined) return
      if (event?.type === 'assistant/message') {
        const turn = event.data?.turn
        if (typeof turn !== 'number') return
        const text = messageText(event.data?.message)
        const seen = markers.some(marker => text.includes(marker))
        let byTurn = turns.get(sessionId)
        if (byTurn === undefined) { byTurn = new Map(); turns.set(sessionId, byTurn) }
        byTurn.set(turn, (byTurn.get(turn) ?? false) || seen)
        for (const key of [...byTurn.keys()]) if (key < turn - 1) byTurn.delete(key)
        return
      }
      // `tool/call` names the tool AND carries the turn. In PTC the outer call is
      // `run_code`, so its id is remembered and the inner names resolve through it.
      if (event?.type === 'tool/call') {
        const turn = event.data?.turn
        if (typeof turn !== 'number') return
        const callId = event.data?.callId
        if (typeof callId === 'string') {
          let byCall = callTurns.get(sessionId)
          if (byCall === undefined) { byCall = new Map(); callTurns.set(sessionId, byCall) }
          byCall.set(callId, turn)
          for (const [id, seen] of byCall) if (seen < turn - 1) byCall.delete(id)
        }
        if (BEHAVIOR_TOOLS.has(event.data?.name)) markActing(sessionId, turn)
        return
      }
      if (event?.type === 'tool/ptc-dispatch' || event?.type === 'tool/ptc-dispatch-start') {
        const name = event.data?.name
        if (!BEHAVIOR_TOOLS.has(name)) return
        const turn = callTurns.get(sessionId)?.get(event.data?.rootCallId)
        if (typeof turn !== 'number') {
          // Loud, never silent: an unattributable dispatch means the eligibility rule
          // above can no longer see this turn. Asserted by the unit test's PTC case.
          warn('behavior tool "' + String(name) + '" has no attributable turn (rootCallId ' + String(event.data?.rootCallId) + ')')
          return
        }
        markActing(sessionId, turn)
      }
    } catch (err) {
      warn('session/event observer failed: ' + String(err))
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
      if (reminded.get(sessionId) === turn) return decision                  // (2) once per turn
      // `undefined` (no previous assistant output observed) is NOT a miss: only an
      // explicit `false` — a real previous turn whose text lacked the marker — reminds.
      if (turns.get(sessionId)?.get(turn - 1) !== false) return decision
      // Design choice 5: the persona only requires the line on behavior-changing
      // turns, so only those are ever nudged.
      if (acting.get(sessionId)?.get(turn - 1) !== true) return decision
      reminded.set(sessionId, turn)
      return { ...decision, messages: [...decision.messages, pluginMessage(REMINDER, name)] }
    } catch (err) {
      warn('could not inject the intent-gate reminder: ' + String(err))
      return decision
    }
  })
}
