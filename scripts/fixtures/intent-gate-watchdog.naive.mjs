// intent-gate-watchdog.naive.mjs — 阴性对照【故意削弱的基线实现】，不是历史版本。
//
// 用途：证明 scripts/verify-intent-gate-watchdog.cjs 的断言不是空转。它不是某个真实旧版
// （本插件 2026-09-14 才诞生），而是"第一直觉会写出来的那版"—— 把这一串坑一次踩全：
//   ① 没有首轮保护（把"没有上一轮数据"当成"漏了"）        → 应在 first-turn 断言失败
//   ② 覆盖下游决策（reject 也照样塞提醒）                  → 应在 reject 断言失败
//   ③ 不判深度（连子代理一起提醒，畸形深度也不警告）        → 应在三条 depth 断言失败
//   ④ 不限制每轮一次（同一 turn 每个 step 都提醒）          → 应在 once-per-turn 断言失败
//   ⑤ 不看"这一轮该不该有门行"（只读轮次也提醒）           → 应在三条 eligibility 断言失败
//   ⑥ 闸门是"无条件拒"：不看 config.gate（观察模式也拒）、不限每轮一次、不看本轮是不是真人开的、
//      覆盖下游决定、也不留竞态取证                 → 应在五条闸门/取证断言失败
// 期望：恰好上面这些条目失败，其余全过（否则说明对照版坏得超出了预期，或断言写弱了）——
// 具体清单由 REQUIRED_CONTROL_FAILURES 持有（判据是集合相等），本注释不登记条数（数字必漂）。
// 具体清单由脚本内的 REQUIRED_CONTROL_FAILURES 持有（判据是集合相等），本注释不重复登记条数细节。
//
// 改这个文件前先读上面这段：它的"错误"是被要求的。

import { randomUUID } from 'node:crypto'

export const name = 'intent-gate-watchdog'

const DEFAULT_MARKERS = ['Intent:']

const BEHAVIOR_TOOLS = new Set([
  'write', 'edit', 'bash', 'pwsh',
  'explorer', 'librarian', 'oracle', 'implementer', 'designer',
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'ralph',
  'ask_user_question',
])

const REMINDER = [
  '[intent-gate-watchdog] 上一轮没有输出门行。',
  '规则（orchestrator persona 的 Phase 0）：动手之前先用一行分类并说明计划，以字面量 `Intent:` 开头。',
].join('\n')

const GATE_REASON = '[intent-gate] 这一次调用没有门行垫底 —— 先写 `Intent: <桶> — …`，再重发。'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function pluginMessage(text, plugin) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form: 'notice', summary: 'intent gate missing' },
  })
}

function messageText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text + '\n'
  }
  return text
}

export function apply(ctx) {
  const markers = DEFAULT_MARKERS
  const warn = (message) => ctx.logger?.warn('[' + name + '] ' + message)
  const turns = new Map()

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return
      const turn = event.data?.turn
      if (typeof turn !== 'number') return
      const sessionId = session?.id
      if (sessionId === undefined) return
      const seen = markers.some(marker => messageText(event.data?.message).includes(marker))
      let byTurn = turns.get(sessionId)
      if (byTurn === undefined) { byTurn = new Map(); turns.set(sessionId, byTurn) }
      byTurn.set(turn, (byTurn.get(turn) ?? false) || seen)
    } catch (err) {
      warn('session/event observer failed: ' + String(err))
    }
  })

  // ⑥ 闸门（tools/pre-execute）的"第一直觉版"：下游决定 await 了、行为工具也认出来了，
  // 但除此之外全部不讲道理 —— 不看 config.gate（观察模式也拒）、不看本轮是不是真人开的、
  // 每轮不限一次（没有 `denied` 位）、下游不是 allow 也照样换成自己的 deny、也不留竞态取证。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (!BEHAVIOR_TOOLS.has(exec?.name)) return decision
    return { kind: 'deny', reason: GATE_REASON }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
    } catch (err) {
      warn('downstream agent/pre-step failed: ' + String(err))
      throw err
    }
    try {
      const { agent, messages, turn } = payload ?? {}
      if (!Array.isArray(messages) || !messages.some(m => m?.source?.kind === 'user')) return decision
      const sessionId = agent?.session?.id
      if (sessionId === undefined) return decision
      if (turns.get(sessionId)?.get(turn - 1) === true) return decision   // ① 只看 true；undefined 也当漏
      // ② 不看 decision.kind（reject 也覆盖）；③ 不判深度；④ 不记"本轮已提醒"
      const base = decision?.kind === 'enter' ? decision : { kind: 'enter', messages: [] }
      return { ...base, messages: [...base.messages, pluginMessage(REMINDER, name)] }
    } catch (err) {
      warn('could not inject the intent-gate reminder: ' + String(err))
      return decision
    }
  })
}
