#!/usr/bin/env node
// verify-lane-role-presentation.cjs — 零成本单元校验：preset 的翻转插件
// （preset/agent-lanes/lane-role-presentation.mjs）。
//
// 为什么单独有这个脚本：插件的决定「哪些 agent 失去 run_code」是一条安全边界。
// 会话日志（verify-agent-lanes.cjs）只能证明**happy path**（真的派出去、真的 native），
// 但驱动不了失败路径 —— 畸形深度、缺 ctx.tools、只记了 runtime 选项没记 header 的
// 恢复型子代理。那些路径恰恰是「子代理静默留在 PTC = run_code 逃逸」的入口，必须直接断言。
//
// 用法：node scripts/verify-lane-role-presentation.cjs
// 全程只读：不联网、不调模型、不写文件。退出码非 0 表示有断言失败。

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// LANE_PLUGIN_PATH is the negative-control hook: point it at the PREVIOUS revision and
// the same assertions must fail on the paths this hardening closes — otherwise the
// suite would be passing vacuously and would not have caught the silent-PTC bug.
const PLUGIN = process.env.LANE_PLUGIN_PATH
  || path.join(__dirname, '..', 'preset', 'agent-lanes', 'lane-role-presentation.mjs')

let checks = 0
let failures = 0

function check(name, ok, detail) {
  checks += 1
  if (ok) console.log('  ✓ ' + name)
  else { failures += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : ' — ' + detail)) }
}

/** Load a fresh plugin instance: apply() runs per call, so the WeakSet starts empty. */
async function open() {
  const state = { warns: [] }
  let handler
  const ctx = {
    logger: { warn: (message) => state.warns.push(String(message)) },
    on: (event, fn) => { if (event === 'agent/created') handler = fn },
  }
  const mod = await import(pathToFileURL(PLUGIN).href)
  mod.apply(ctx)
  if (typeof handler !== 'function') throw new Error('plugin did not subscribe to agent/created')
  return { state, fire: (agent) => handler({ agent }) }
}

/** tools: 'ok' (counts) | 'missing' (no ctx.tools) | 'throwing' (presentAs rejects). */
function makeAgent({ header = {}, options = {}, tools = 'ok' } = {}) {
  const calls = { presentAs: 0 }
  const agent = { session: { header }, options }
  if (tools === 'ok') agent.ctx = { tools: { presentAs: () => { calls.presentAs += 1 } } }
  else if (tools === 'missing') agent.ctx = {}
  else if (tools === 'throwing') agent.ctx = { tools: { presentAs: () => { calls.presentAs += 1; throw new Error('mode declaration rejected') } } }
  return { agent, calls }
}

const mentions = (state, needle) => state.warns.some((w) => w.includes(needle))

async function main() {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(PLUGIN)).digest('hex')
  console.log('plugin: ' + PLUGIN)
  console.log('sha256: ' + sha + '\n')

  // 1 — the orchestrator must keep the preset's PTC (the whole cost argument).
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: {}, options: {} })
    h.fire(agent)
    check('orchestrator (depth 0, no origin) keeps PTC', calls.presentAs === 0 && h.state.warns.length === 0,
      'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 2 — the documented in-process child: header depth only.
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: { delegationDepth: 1, origin: 'subagent' } })
    h.fire(agent)
    check('child with header depth 1 flips to native', calls.presentAs === 1 && h.state.warns.length === 0,
      'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 3 — THE REGRESSION THIS HARDENING IS FOR: depth recorded only in the runtime option.
  //     The previous revision read the header alone -> silently returned -> child stayed PTC.
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: {}, options: { subagentDepth: 2 } })
    h.fire(agent)
    check('child whose depth lives only in options.subagentDepth flips (Math.max)', calls.presentAs === 1 && h.state.warns.length === 0,
      'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 4 — fail-safe signal: the harness writes origin in the same meta as the depth, so
  //     origin alone still means "child". Flip, and make the depth-0 anomaly audible.
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: { origin: 'subagent' } })
    h.fire(agent)
    check("child with origin 'subagent' but depth 0 flips AND warns", calls.presentAs === 1 && mentions(h.state, 'depth 0'),
      'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 5 — malformed runtime depth: the harness throws a TypeError; here it must be reported,
  //     and the header must still be honoured so the child does not keep run_code.
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: { delegationDepth: 1 }, options: { subagentDepth: -1 } })
    h.fire(agent)
    check('malformed options.subagentDepth warns, falls back to header, still flips',
      calls.presentAs === 1 && mentions(h.state, 'safe integer'), 'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: {}, options: { subagentDepth: 1.5 } })
    h.fire(agent)
    check('malformed depth on an orchestrator still warns but does not flip',
      calls.presentAs === 0 && mentions(h.state, 'safe integer'), 'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: { delegationDepth: 1 }, options: { subagentDepth: -0 } })
    h.fire(agent)
    check('negative zero is rejected as malformed', calls.presentAs === 1 && mentions(h.state, 'safe integer'),
      'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 6 — a child without ctx.tools must be loud, never silent and never a crash.
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: { delegationDepth: 1 }, tools: 'missing' })
    let threw
    try { h.fire(agent) } catch (err) { threw = err }
    check('child without ctx.tools warns instead of throwing', threw === undefined && calls.presentAs === 0 && mentions(h.state, 'ctx.tools'),
      'threw=' + String(threw) + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 7 — a failing presentAs must be surfaced, not swallowed (no empty catch).
  {
    const h = await open(); const { agent } = makeAgent({ header: { delegationDepth: 1 }, tools: 'throwing' })
    let threw
    try { h.fire(agent) } catch (err) { threw = err }
    check('presentAs failure is caught and warned', threw === undefined && mentions(h.state, 'could not switch'),
      'threw=' + String(threw) + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 8 — idempotence: a retried event must not re-declare the mode.
  {
    const h = await open(); const { agent, calls } = makeAgent({ header: { delegationDepth: 2 } })
    h.fire(agent); h.fire(agent)
    check('repeated agent/created flips once', calls.presentAs === 1 && h.state.warns.length === 0,
      'presentAs=' + calls.presentAs + ' warns=' + JSON.stringify(h.state.warns))
  }

  // 9 — defensive: a payload without an agent must not throw or warn.
  {
    const h = await open()
    let threw
    try { h.fire(undefined) } catch (err) { threw = err }
    check('undefined agent is a no-op', threw === undefined && h.state.warns.length === 0,
      'threw=' + String(threw) + ' warns=' + JSON.stringify(h.state.warns))
  }

  console.log('\n汇总: ' + (checks - failures) + '/' + checks + ' 通过' + (failures === 0 ? '  ✓ 全绿' : '  ✗ ' + failures + ' 项失败'))
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => { console.error('harness error: ' + String(err && err.stack || err)); process.exitCode = 2 })
