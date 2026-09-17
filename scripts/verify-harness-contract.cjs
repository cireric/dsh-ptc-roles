#!/usr/bin/env node
// verify-harness-contract.cjs — **升级 dsh 本体之前**跑的契约门禁（ADR 0002 的 D 项）。
//
// 为什么需要它：本 preset 有三处「手工复刻框架口径」的依赖 ——
//   ① role-presentation.mjs / intent-gate-watchdog.mjs **各存一份** resolveDepth，复刻
//      subagent/src/depth.ts 的 "Math.max(header, runtime)" 语义与畸形值抛 TypeError 的行为；
//   ② 翻转插件唯一的写入路径是 tools.presentAs(mode)，它依赖「一 scope 一声明 + 近层优先」；
//   ③ 看门狗靠 agent/created 认子代理、靠 agent/pre-step 的 waterfall 决策注入提醒。
// 上游 issues 已关闭 + AGENTS.md 规则 1（禁改框架）+ 规则 3（插件零 import）⇒ 框架漂移**只能自兜**。
// 这道门就是那个兜：读目标 checkout 的源码文本，断言这些契约**还在**。升级后再跑，变红的那条
// 直接指出 preset 侧要改哪一处。
//
// 与其他脚本的分工（别在这里重复）：
//   * 「工具名是否仍存在、白名单是否精确命中」是 verify-ptc-roles.cjs 的活（它读**真正发给模型的**工具面）；
//     本脚本只读源码文本，不做运行时验证。
//   * 版本差异事实与 rc 后的修复清单是 docs/dsh-v0.1.6-ptc-impact.md 的活（唯一来源）。
//
// 用法：
//   node scripts/verify-harness-contract.cjs                             # --harness → $DSH_CHECKOUT → ~/.dsh/dsh-harness
//   node scripts/verify-harness-contract.cjs --harness /path/to/dsh      # 指向灰度 checkout
//
// 退出码契约（与另外三个脚本一致）：0 = 本次运行符合预期；有 ✗ FAIL 才非 0；
// checkout / 契约载体读不到 ⇒ 2（响亮失败，绝不静默跳过）。
//
// 阴性对照：每条断言都配一条**内存变异**（不落盘、不随时间腐坏）；变异没生效时该条对照自己 FAIL
// —— 否则它就是空转（与 verify-ptc-roles.cjs 的静态角色事实检查同一纪律）。
//
// 全程只读：不联网、不调模型、不写文件。

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.join(__dirname, '..')
const PRESET_YML = path.join(REPO, 'preset', 'ptc-roles', 'agent.cordis.yml')
const PLUGIN_FILES = {
  'role-presentation.mjs': path.join(REPO, 'preset', 'ptc-roles', 'role-presentation.mjs'),
  'intent-gate-watchdog.mjs': path.join(REPO, 'preset', 'ptc-roles', 'intent-gate-watchdog.mjs'),
}
/** 契约载体（相对目标 checkout 的路径）。文件搬家 ⇒ 契约变了，必须响亮失败。 */
const SOURCES = {
  depth: 'packages/subagent/subagent/src/depth.ts',
  tools: 'packages/core/tools/src/index.ts',
  agent: 'packages/core/agent/src/index.ts',
  runtimeTypes: 'packages/core/agent/src/runtime-types.ts',
  agentLoop: 'packages/core/agent-loop/src/agent.ts',
}
// 默认 harness 与 Makefile 同源的单链：`--harness` → `$DSH_CHECKOUT` → `~/.dsh/dsh-harness`。
// **不写死本机绝对路径**：写死会让「契约门禁通过」这句判定行可能来自另一棵树，而输出里只有一行
// 路径串可辨（2026-09-17 评审 M6）。换机后路径不存在 ⇒ 走 missingFiles 分支退 2（响亮）。
const DEFAULT_HARNESS = path.join(os.homedir(), '.dsh', 'dsh-harness')

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return undefined }
}

/** 抽出 "function <name>(...) { … }" 的整段文本（含签名到匹配的闭合大括号）。 */
function extractFunction(text, name) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('function ' + name + '(')
  if (start < 0) return undefined
  const open = text.indexOf('{', start)
  if (open < 0) return undefined
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** 两份复本的第一处差异行（用于把「不一致」说得可查）。 */
function firstDiff(a, b) {
  if (a === undefined || b === undefined) return '(有一份不存在)'
  const la = a.split('\n')
  const lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) return '第 ' + (i + 1) + ' 行 ' + JSON.stringify(la[i] || '') + ' ≠ ' + JSON.stringify(lb[i] || '')
  }
  return '(无差异)'
}

/** 枚举目标 checkout 下 packages 目录里每个 package.json 的 name（跳过 node_modules / dist）。 */
function collectPackageNames(harness) {
  const names = new Set()
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) {
        if (e.name === 'package.json') {
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'))
            if (typeof pkg.name === 'string') names.add(pkg.name)
          } catch { /* 坏的 package.json 不该让门禁崩；计数对不上时会在断言里显出来 */ }
        }
        continue
      }
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue
      walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(path.join(harness, 'packages'), 0)
  return names
}

/** preset 里引用的 @deepseek-ai/* 包名（去掉子路径导出，如 .../tool-subagent-control/list-agents）。 */
function presetPackageRefs(ymlText) {
  const out = new Set()
  const re = /name:\s*'?(@deepseek-ai\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)'?/g
  let m
  while ((m = re.exec(ymlText)) !== null) {
    const parts = m[1].split('/')
    out.add(parts.slice(0, 2).join('/'))          // @scope/pkg（其余段是子路径导出）
  }
  return [...out].sort()
}

/** 缺包时给个方向：同 token 的候选名（升级改名的典型场景）。 */
function candidatesFor(name, pkgNames) {
  const tokens = name.replace('@deepseek-ai/', '').split('-').filter((t) => t.length > 3)
  return [...pkgNames]
    .filter((n) => tokens.some((t) => n.includes(t)) && !n.endsWith('/' + name))
    .slice(0, 4)
}

const has = (text, needle) => typeof text === 'string' && text.includes(needle)

/** 全部契约断言。入参收成对象，是为了让阴性对照能在内存里替换任意一处文本。 */
function contractChecks(input) {
  const { sources: s, plugins, pkgNames, refs } = input
  const checks = []
  const check = (name, conds) => {
    const bad = conds.filter((c) => !c[1]).map((c) => c[0])
    checks.push({ name, ok: bad.length === 0, detail: bad.length === 0 ? '' : '未满足：' + bad.join('；') })
  }
  const bodies = Object.entries(plugins).map(([n, t]) => [n, extractFunction(t, 'resolveDepth')])
  const bodyA = bodies[0] === undefined ? undefined : bodies[0][1]
  const bodyB = bodies[1] === undefined ? undefined : bodies[1][1]
  const noBody = bodies.filter((b) => b[1] === undefined).map((b) => b[0])
  const missingPkgs = refs.filter((n) => !pkgNames.has(n))

  check('subagent/depth.ts：delegationDepthOf 公式与畸形值语义未变（插件复刻的就是它）', [
    ['delegationDepthOf 不见了', has(s.depth, 'function delegationDepthOf')],
    ['公式不再是 Math.max(header, runtime)', has(s.depth, 'Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)')],
    ['畸形 runtime 不再抛错（不再校验 safe integer）', has(s.depth, 'Number.isSafeInteger(runtime)')],
    ['TypeError 文案变了（插件注释引用了它）', has(s.depth, 'must be a non-negative safe integer')],
  ])

  check('两个插件里的 resolveDepth 复本逐字相同（pitfalls #18：不能合并，但必须一致）', [
    ['插件里找不到 resolveDepth：' + (noBody.join(', ') || '无'), noBody.length === 0],
    ['两份复本不一致 —— ' + firstDiff(bodyA, bodyB), noBody.length === 0 && bodyA === bodyB],
  ])

  check('resolveDepth 仍与框架同口径（header 兜底 + runtime 覆盖 + 负零拒绝）', [
    ['缺 return Math.max(header, runtime)', has(bodyA, 'return Math.max(header, runtime)')],
    ['缺 header 读取', has(bodyA, 'agent?.session?.header?.delegationDepth ?? 0')],
    ['缺 runtime 读取', has(bodyA, 'agent?.options?.subagentDepth')],
    ['缺 Number.isSafeInteger 守卫', has(bodyA, 'Number.isSafeInteger(runtime)')],
    ['缺负零拒绝', has(bodyA, 'Object.is(runtime, -0)')],
  ])

  check('tools.presentAs 仍是「一 scope 一声明 + 近层优先」（翻转插件唯一的写入路径）', [
    ['presentAs(mode: ToolPresentationMode) 不见了', has(s.tools, 'presentAs(mode: ToolPresentationMode)')],
    ['不再要求 scoped context', has(s.tools, 'requires a scoped context')],
    ['同一 scope 的第二个声明不再被拒（冲突判定没了）', has(s.tools, 'conflicts with')],
    ['声明不再写进 layer.mode', has(s.tools, 'layer.mode = mode')],
    ['modeFor(scope) 不见了（近层优先没了）', has(s.tools, 'modeFor(scope')],
  ])

  check('run_code 仍是保留传输（白名单删不掉它、也没人能遮蔽它）', [
    ['restrict 的保留传输拒绝不见了', has(s.tools, 'tools.restrict() cannot name reserved PTC mode presentation transport')],
    ['「不可注册 / 不可遮蔽」拒绝不见了', has(s.tools, 'cannot be registered or shadowed')],
    ['PTC_ONLY_INSTRUCTION 措辞变了（verify-ptc-roles 的 PTC_MARK 依赖它）', has(s.tools, 'is the only tool you can call directly')],
  ])

  check('agent/created 仍带 { agent } 载荷（翻转插件与看门狗的唯一入口）', [
    ['事件名不见了', has(s.agent, "'agent/created'")],
    ['载荷形状不再是 { agent: … }', /'agent\/created',\s*\{[^}]*agent\s*:/.test(s.agent)],
  ])

  check("agent/pre-step 仍是 waterfall，决策仍含 kind: 'enter' + messages（看门狗的消息注入）", [
    ['事件签名不见了', has(s.runtimeTypes, "'agent/pre-step'")],
    ['载荷不再带 messages: UserMessage[]', has(s.runtimeTypes, 'messages: UserMessage[]')],
    ['载荷不再带 turn: number', has(s.runtimeTypes, 'turn: number')],
    ["决策联合里没有 kind: 'enter' 分支", /\{\s*kind:\s*'enter'/.test(s.runtimeTypes)],
    ['agent-loop 不再走 dispatch.waterfall', has(s.agentLoop, "'agent/pre-step'")],
  ])

  check('preset 引用的 @deepseek-ai/* 包在目标 checkout 里都存在（升级改名会在这里断）', [
    ['缺包：' + (missingPkgs.map((n) => {
      const c = candidatesFor(n, pkgNames)
      return n + (c.length > 0 ? '（疑似新名：' + c.join(', ') + '）' : '')
    }).join('、') || '无'), missingPkgs.length === 0],
  ])

  return checks
}

/** 阴性对照：每条断言至少被一条内存变异打中一次。变异没生效 ⇒ 该条对照自己 FAIL。 */
function contractControls(input) {
  const out = []
  const findingsOf = (mutated) => contractChecks(mutated).filter((c) => !c.ok)
  const control = (label, mutated, expectSubstring) => {
    const hit = findingsOf(mutated).some((c) => (c.name + ' ' + c.detail).includes(expectSubstring))
    out.push({
      name: label,
      ok: hit,
      detail: hit ? '' : '期望报告含「' + expectSubstring + '」，实得：'
        + (findingsOf(mutated).map((c) => c.name).join(' | ') || '（无 finding —— 变异可能没生效）'),
    })
  }
  const mut = (text, from, to) => {
    const next = text.split(from).join(to)
    return next === text ? undefined : next
  }
  const bad = (label) => { out.push({ name: label, ok: false, detail: '对照组本身失效：变异目标文本不存在（契约文本已改，请同步本脚本的对照）' }) }

  const depthMut = mut(input.sources.depth, 'delegationDepth ?? 0, runtime ?? 0)', 'delegationDepth ?? 0, runtime ?? 0, 1)')
  if (depthMut === undefined) bad('对照①：改掉 depth 公式 ⇒ 报告契约漂移')
  else control('对照①：改掉 depth 公式 ⇒ 报告契约漂移', { ...input, sources: { ...input.sources, depth: depthMut } }, '公式')

  const copyMut = mut(input.plugins['intent-gate-watchdog.mjs'], 'runtime < 0', 'runtime < -1')
  if (copyMut === undefined) bad('对照②：改掉一份复本 ⇒ 报告两份不一致')
  else control('对照②：改掉一份复本 ⇒ 报告两份不一致',
    { ...input, plugins: { ...input.plugins, 'intent-gate-watchdog.mjs': copyMut } }, '不一致')

  const presentMut = mut(input.sources.tools, 'conflicts with', 'shadows something else than')
  if (presentMut === undefined) bad('对照③：删掉 presentAs 的冲突判定 ⇒ 报告近层语义漂移')
  else control('对照③：删掉 presentAs 的冲突判定 ⇒ 报告近层语义漂移',
    { ...input, sources: { ...input.sources, tools: presentMut } }, '冲突判定')

  const createdMut = mut(input.sources.agent, "'agent/created', { agent: entry.agent }", "'agent/created', {}")
  if (createdMut === undefined) bad('对照④：改掉 agent/created 载荷 ⇒ 报告载荷漂移')
  else control('对照④：改掉 agent/created 载荷 ⇒ 报告载荷漂移',
    { ...input, sources: { ...input.sources, agent: createdMut } }, '载荷形状')

  const pkgs = new Set(input.pkgNames)
  pkgs.delete('@deepseek-ai/dsh-tool-bash')
  control('对照⑤：抽掉一个包名 ⇒ 报告缺包（升级改名的典型现场）', { ...input, pkgNames: pkgs }, 'dsh-tool-bash')

  return out
}

function harnessVersion(harness) {
  const pkg = readIf(path.join(harness, 'package.json'))
  let version = '?'
  if (pkg !== undefined) { try { version = JSON.parse(pkg).version || '?' } catch { version = '?' } }
  let describe = ''
  try { describe = execFileSync('git', ['-C', harness, 'describe', '--tags'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { describe = '(git describe 不可用)' }
  return version + ' / ' + describe
}

function main() {
  const argv = process.argv.slice(2)
  const flag = argv.indexOf('--harness')
  const harness = path.resolve(flag >= 0 && argv[flag + 1] !== undefined ? argv[flag + 1] : (process.env.DSH_CHECKOUT || DEFAULT_HARNESS))

  const yml = readIf(PRESET_YML)
  if (yml === undefined) { console.error('✗ 读不到 preset yml：' + PRESET_YML); process.exitCode = 2; return }
  const sources = {}
  const missingFiles = []
  for (const [key, rel] of Object.entries(SOURCES)) {
    const text = readIf(path.join(harness, rel))
    if (text === undefined) missingFiles.push(rel)
    sources[key] = text === undefined ? '' : text
  }
  console.log('harness: ' + harness)
  console.log('版本锚点: ' + harnessVersion(harness) + '\n')
  if (missingFiles.length > 0) {
    console.log('✗ FAIL 契约载体文件不见了（升级改了路径？）：')
    for (const f of missingFiles) console.log('   ' + f)
    console.log('  ⇒ 先确认新路径，再同步 scripts/verify-harness-contract.cjs 的 SOURCES；别把这个失败改成跳过。')
    process.exitCode = 2
    return
  }

  const plugins = {}
  for (const [name, file] of Object.entries(PLUGIN_FILES)) {
    const text = readIf(file)
    if (text === undefined) { console.error('✗ 读不到插件：' + file); process.exitCode = 2; return }
    plugins[name] = text
  }
  const pkgNames = collectPackageNames(harness)
  const refs = presetPackageRefs(yml)
  if (pkgNames.size === 0) { console.error('✗ 目标 checkout 里没扫到任何 package.json（路径不对？）'); process.exitCode = 2; return }

  const input = { sources, plugins, pkgNames, refs }
  console.log('preset 引用 ' + refs.length + ' 个 @deepseek-ai/* 包；目标 checkout 扫到 ' + pkgNames.size + ' 个包名\n')

  let pass = 0
  let fail = 0
  for (const c of contractChecks(input)) {
    if (c.ok) { console.log('  ✓ ' + c.name); pass += 1 }
    else { console.log('  ✗ FAIL ' + c.name + '（' + c.detail + '）'); fail += 1 }
  }
  console.log('\n契约自测（内存变异 —— 阴性对照，证明断言不是空转）:')
  for (const c of contractControls(input)) {
    if (c.ok) { console.log('  ✓ ' + c.name); pass += 1 }
    else { console.log('  ✗ FAIL ' + c.name + '（' + c.detail + '）'); fail += 1 }
  }
  console.log('\n汇总: ✓' + pass + '  ✗' + fail + '（目标 checkout: ' + harness + '）')
  if (fail === 0) console.log('  ⇒ 契约成立：这份 preset 依赖的框架口径与目标 checkout 一致（升级后重跑即是差异报告）。')
  process.exitCode = fail === 0 ? 0 : 1
}

main()
