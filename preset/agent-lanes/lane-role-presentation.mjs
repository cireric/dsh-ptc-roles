// lane-role-presentation.mjs — agent-lanes preset companion plugin.
//
// The preset runs in PTC presentation (see the base `tool-presentation` row): the
// orchestrator keeps the cheaper collapsed tool surface. Delegated role children
// must NOT keep it — under PTC a child's only callable tool is `run_code`, and
// `run_code` is a reserved transport no `toolFilter` can remove (tools.restrict()
// refuses to name it), while it runs with the host process's fs/child_process.
// A "read-only" role would therefore still be able to write files.
//
// So: flip every delegated child (delegationDepth >= 1) to `native` in the
// child's OWN scope at `agent/created`. `tools.modeFor` resolves nearest scope
// first, so the child's own declaration overrides the preset's PTC for that child
// alone; the orchestrator keeps PTC.
//
// Why `agent/created` and not `agent/pre-step`: a step's prompt and tool schemas
// are assembled BEFORE the pre-step waterfall (agent-loop/src/agent.ts:245 comes
// before :249), so a flip there would only take effect from the NEXT step.
// `agent/created` fires during agent publication, before any step exists.
//
// Zero imports on purpose: a preset directory lives under the user home, where
// Node cannot resolve the harness's packages, so an `@deepseek-ai/*` import from
// here would need a createRequire/"npm root -g" workaround. This plugin only
// touches the cordis context and the agent, so it needs none of that.
//
// ── depth criterion (hardened 2026-09-13, HANDOFF §8 G2) ──────────────────────
// Two independent signals identify a delegated child, because either one alone
// has a silent failure mode:
//
//   1. `delegationDepth` — resolved the way the harness resolves it
//      (`delegationDepthOf`, subagent/src/depth.ts:28-36): the persisted session
//      header is the monotone floor and runtime `AgentOptions.subagentDepth` may
//      only DEEPEN it, so the answer is `Math.max(header, runtime)`. The previous
//      revision read `agent.session.header.delegationDepth` alone and returned
//      silently on 0 — any creation path that recorded the runtime option but not
//      the header would have left a real child in PTC, i.e. an invisible
//      `run_code` escape.
//   2. `origin === 'subagent'` — written by the harness in the SAME
//      `childSessionMeta` as the depth (subagent/src/child-agent.ts:138-156), so
//      today it is redundant; it is kept as the fail-safe for a path that records
//      the origin but not the depth. Flipping is the safe direction: a child that
//      loses `run_code` while still holding its allow-list is exactly the intent.
//
// The depth arithmetic is re-implemented instead of imported because of the
// zero-import rule above — keep it in sync with subagent/src/depth.ts if the
// harness ever changes. Both signals are read from fields the harness documents
// as public; nothing here reaches into framework internals.

export const name = 'lane-role-presentation'

/**
 * Resolve an agent's delegation depth the way the harness does.
 * @param agent - the agent published by `agent/created`.
 * @returns the non-negative depth, or `undefined` when `options.subagentDepth`
 *   is present but malformed (the harness throws a TypeError there; this plugin
 *   reports it and falls back to the header so a child still loses `run_code`).
 */
function resolveDepth(agent) {
  const header = agent?.session?.header?.delegationDepth ?? 0
  const runtime = agent?.options?.subagentDepth
  if (runtime === undefined) return Math.max(header, 0)
  if (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0)) return undefined
  return Math.max(header, runtime)
}

export function apply(ctx) {
  /** Agents already switched, so a retried event cannot re-declare the mode. */
  const flipped = new WeakSet()
  const warn = (message) => ctx.logger?.warn('[agent-lanes] ' + message)

  ctx.on('agent/created', ({ agent }) => {
    try {
      if (agent === undefined || agent === null) return
      const header = agent.session?.header
      const depth = resolveDepth(agent)
      if (depth === undefined) {
        warn('agent.options.subagentDepth is not a non-negative safe integer ('
          + String(agent.options?.subagentDepth) + '); using the session header alone')
      }
      const childDepth = depth === undefined ? (header?.delegationDepth ?? 0) : depth
      if (childDepth < 1 && header?.origin !== 'subagent') return   // the orchestrator keeps the preset's PTC
      if (flipped.has(agent)) return
      if (childDepth < 1) {
        // Fail LOUD rather than silently: this is the path that used to keep a
        // real child in PTC. Flipping it is the safe direction (run_code goes
        // away); the warning is what makes the anomaly visible, since this
        // deployment has no log sink the plugin could rely on.
        warn("a delegated child (origin 'subagent') reports depth 0; flipping it to native anyway")
      }
      const tools = agent.ctx?.tools
      if (tools === undefined) {
        warn('agent/created without ctx.tools; role child keeps PTC presentation')
        return
      }
      tools.presentAs('native')                   // run_code disappears -> the allow-list becomes a real boundary
      flipped.add(agent)
    } catch (err) {
      // Fail open but LOUD: a role that silently stays in PTC would look
      // read-only while `run_code` still let it write.
      warn('could not switch a role child to native presentation: ' + String(err))
    }
  })
}
