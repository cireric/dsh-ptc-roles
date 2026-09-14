export const name = 'lane-role-presentation'

export function apply(ctx) {
  const flipped = new WeakSet()

  ctx.on('agent/created', ({ agent }) => {
    try {
      const depth = agent?.session?.header?.delegationDepth ?? 0
      if (depth < 1) return
      if (flipped.has(agent)) return
      const tools = agent.ctx?.tools
      if (tools === undefined) {
        ctx.logger?.warn('[agent-lanes] agent/created without ctx.tools; role child keeps PTC presentation')
        return
      }
      tools.presentAs('native')
      flipped.add(agent)
    } catch (err) {
      ctx.logger?.warn('[agent-lanes] could not switch a role child to native presentation: ' + String(err))
    }
  })
}
