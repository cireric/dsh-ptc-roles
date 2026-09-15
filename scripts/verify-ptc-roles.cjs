#!/usr/bin/env node
// verify-ptc-roles.cjs — 零模型成本地验证 ptc-roles preset 的实际行为。
//
// 它只读 ~/.dsh/sessions 下的会话文件（解压后解析 JSONL），报告每一个会话：
//   角色（从子代理的 persona 标记识别）/ 模型 / **模型可见工具面** / 是否仍是 PTC。
// 并与期望白名单逐项比对，给出 PASS / FAIL / WARN。
//   * 两个**已知自身层泄漏**工具（KNOWN_SELF_LAYER）被容忍，但会**显式标注** ⊘ 且不计入 FAIL ——
//     它们掩不掉（见 docs/pitfalls.md #7），恒 FAIL 只会淹没真正的问题。
//   * depth≥2 且无角色 persona 的跳过行会提示「疑似孙代升级复发」，但**只对 BOUND_ADDED_AT
//     之后创建的会话**提示：那之前的那批是修复前的遗留，不该永久报警。
//   * **提权请求计数**（escalations）：数一数每个会话里模型真的发起了几次沙箱提权
//     （`sandbox_permissions` / `justification`，只认真实参数键，不扫文本）。角色子代理的会话带
//     `approval/policy {"policy":"never","source":"delegation"}`，提权会被**确定性拒绝且不可能弹给
//     用户**，所以这个计数不是 FAIL 而是**触发信号**：什么时候该做 sandbox-strip（docs/pitfalls.md C 节）。
//     ⚠️ 口径：**seeded 子会话继承父日志的事件**，其计数可能包含父的调用（输出里标 `(seeded)`）；
//     而已知自身层泄漏 / 角色子代理的判定不受影响。
//
//   * **意图门合规率**（intent gate）：逐轮判定主 agent「有没有输出门行」，并打印首行命中率。
//     门行 = 字面量 `意图判定`，与 preset/ptc-roles/intent-gate-watchdog.mjs 的 DEFAULT_MARKERS **同口径**
//     （两处必须同步改）。为什么要把它做进脚本：这个门的失败记录**只能当场测**——会话库是滚动窗口，
//     过一阵就测不回来了（见 docs/evidence/2026-09-15-intent-gate-failure-record.json）。
//     只统计 isPresetRoot 且创建于 PERSONA_V2_SINCE 之后的主 agent 会话（旧 persona 的输出形式不同，混进来会污染率）。
//     **合规分子与分母都只算「会改变行为」的轮次**（要委派 / 要拒绝 / 要提问 / 要改文件）—— persona 的
//     Phase 0 只在那些轮次要求门行；判据是同口径的 BEHAVIOR_TOOLS（见下），与看门狗插件**共享同一份列表**。
//     三个口径：「首行」（该轮第一条有文本的 assistant 消息的第一行）是**合规分子**；「可见回复」（该轮
//     任何 assistant 文本含 marker）与「任意文本」（该轮任何事件行含 marker，**含工具结果**）只作对照——
//     读过插件源码的轮次会命中「任意文本」，那不是合规。
//
// 为什么这样能验证：
//   * request/header 事件记录的是**真正发给模型的** header，其 tools 数组就是
//     模型可见工具面 —— native 子代理 = 白名单本身；PTC 子代理 = 只有 run_code。
//   * 子代理 persona 由 tool-subagent 的 persona 配置注入，文本里有 "You are **<role>**"。
//
// 用法：
//   node scripts/verify-ptc-roles.cjs             # 只看本项目的会话
//   node scripts/verify-ptc-roles.cjs --all       # 扫全部工作区
//   node scripts/verify-ptc-roles.cjs --raw       # 额外打印每个会话的完整工具名列表
//
// 全程只读，不写任何文件。

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PTC_MARK = 'is the only tool you can call directly'
const PROJECT_CWD = '/Users/eric/Project/tests/dsh-plugins/cireric-dsh-ptc-roles'
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/**
 * 期望的模型可见工具面（顺序无关）。
 *
 * 这里与 yml 的 `toolFilter.allow` 是**两处来源**，改角色白名单后要同步。刻意不做「从 yml 读」：
 * 这个脚本是**零依赖**的 CJS，要读 yml 就得手写正则解析一个嵌套 block —— 解析器一歪，**判定结论**
 * 就跟着歪（比手工同步更糟）。而漂移本来就**不会静默**：少同步一项立刻表现为 `✗ FAIL … 多出/缺失`，
 * 修就行。所以双份手工同步在这里是可接受的代价，不加解析器。
 */
/**
 * 本平台的 shell 工具名。yml 的 shell 段里 `tool-bash` 在 win32 禁用、
 * `tool-pwsh` 在非 win32 禁用 —— 所以带 shell 的角色**恰好**只拿到这两个名字中的一个。
 * 角色行用平台表达式（`!!js "process.platform === 'win32' ? 'pwsh' : 'bash'"`）解析，
 * 这里用同一个表达式在 JS 侧复算，两处必须同口径。
 */
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

const EXPECTED = {
  explorer: ['read', 'grep', 'glob', 'lsp', 'mcp__codegraph__codegraph_explore'],
  librarian: ['read', 'web_search', 'web_fetch', 'mcp__context7__resolve-library-id', 'mcp__context7__query-docs', 'mcp__gh-grep__searchGitHub', 'mcp__exa__web_search_exa', 'mcp__exa__web_fetch_exa'],
  oracle: ['read', 'grep', 'glob', 'lsp', 'explorer', 'librarian'],
  implementer: ['read', 'write', 'edit', 'glob', 'grep', SHELL, 'lsp', 'todo_write'],
  designer: ['read', 'write', 'edit', 'glob', 'grep', SHELL],
}
/** 保留传输：任何角色都不该看到它（native 模式本来就不注入）。 */
const RESERVED = 'run_code'

/**
 * 已知「自身层泄漏」：与白名单无关、也不该被误判成白名单写错。
 *
 * 来源已定位到源码：preset 的 tool-subagent 行设了 `modelSelectionSettings: true`，
 * 于是 tool-subagent 走 standing scoped install 路径
 * （packages/subagent/tool-subagent/src/index.ts:663-680 installScoped →
 * candidate.ctx.inject(...)），对**组合内每个 agent**（编排器与每个角色子代理）
 * 把 `subagent` 与 `list_subagent_models`（同文件 :362）注册进**该 agent 自己的
 * scope 层**。而 core/tools/src/index.ts:1166-1172 把自身层注册插在掩码循环之后
 * （"own registrations last … outside the filter above"）——所以 toolFilter.allow
 * 天生掩不掉它们。同组的 subagent_fork 不经过这条路径，只作为继承面存在，因此被
 * 正确遮蔽（实测：子代理面里没有它）。
 *
 * 这里**容忍但显式标注**，而不是把它们并进 EXPECTED：并进去等于把泄漏定义成期望，
 * 将来第三个泄漏也会被当成正常。运行时的真正缓解是 agent.cordis.yml 里
 * tool-subagent 行的 `maxDepth: 1`（堵死深度 1 角色再派孙代）。
 */
const KNOWN_SELF_LAYER = ['subagent', 'list_subagent_models']

/**
 * Tools that expose `sandbox_permissions` / `justification` at all (verified against
 * the live schemas: bash, pwsh, edit, write). Restricting the scan to these keeps the
 * counter precise — a `run_code` argument or a file body mentioning the field is not
 * an escalation attempt.
 */
const ESCALATION_TOOLS = new Set(['bash', 'pwsh', 'edit', 'write'])

/**
 * 通用 `subagent` 行被加上 `maxDepth: 1` 的时刻 —— 本 preset 孙代升级的修复点。
 * 本脚本扫的是**全部历史**会话，所以修复之前那批孙代（2026-09-13 09:01–09:02Z）会被永久
 * 判成「疑似复发」。用时间界定把它们排除，提示才只对**修复之后新出现**的孙代说话。
 */
const BOUND_ADDED_AT = Date.parse('2026-09-13T09:10:48Z')

/**
 * round-5「Sisyphus 纪律补全」persona 的时间锚与标记。
 *
 * persona 是在**挂载时**读取的，所以「纪律补全到底有没有生效」在**数据面**上只有这一条信号：
 * 主 agent 的 system prompt 里有没有那段新纪律（见 docs/decisions/0001，第 5 轮追加节）。标记取 `Delegation contract`
 * —— 它在 round-5 之前的 persona 里**不存在**，且只会出现一次。
 * 与 BOUND_ADDED_AT 同理：脚本扫全部历史会话，所以只对 PERSONA_V2_SINCE **之后创建**的会话判定；
 * 之前的会话本来就跑旧 persona，永久报错没有意义。
 */
const PERSONA_V2_SINCE = Date.parse('2026-09-13T14:39:29Z')
const PERSONA_V2_MARK = 'Delegation contract'

/**
 * 意图门门行（intent gate）的 markers —— **必须与 preset/ptc-roles/intent-gate-watchdog.mjs 的
 * DEFAULT_MARKERS 同口径**（那里是看门狗实际注入提醒的判据）。改一处就要同步另一处，理由同 EXPECTED：
 * 解析插件配置会引入一个会歪的解析器，而漂移不会静默（合规率立刻变 0）。
 */
const INTENT_MARKERS = ['意图判定']

/**
 * 「会改变行为」的工具 —— 唯一有权要求门行的那批轮次（persona 的 Phase 0 口径）。
 * **必须与 preset/ptc-roles/intent-gate-watchdog.mjs 的 BEHAVIOR_TOOLS 同口径**：那里用它决定
 * 「要不要提醒」，这里用它决定「合规率的分母」。两处漂移不会静默 —— 合规率会当场翻脸。
 * 注意 PTC 下行为工具的名字出现在 `tool/ptc-dispatch`（该事件**没有 turn**，要靠 rootCallId 经
 * `tool/call` 回映射）。
 */
const BEHAVIOR_TOOLS = new Set([
  'write', 'edit', 'bash', 'pwsh',
  'explorer', 'librarian', 'oracle', 'implementer', 'designer',
  'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'ralph',
  'ask_user_question',
])

/** 命中率格式化：0 轮时给 '—'，避免出现 NaN%。 */
function rate(hit, total) { return total === 0 ? '—' : Math.round((hit / total) * 100) + '%' }

/** 拼接一条 assistant 消息的文本块（与看门狗插件的 messageText 同口径：块间补换行）。 */
function messageText(event) {
  const blocks = (event.data && event.data.message && event.data.message.content) || []
  let text = ''
  for (const b of blocks) if (b && b.type === 'text' && typeof b.text === 'string') text += b.text + '\n'
  return text
}

function findSessionFiles() {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.zstd')) out.push(p)
    }
  }
  walk(SESSIONS_ROOT)
  return out
}

function decode(file) {
  try { return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 29 }).toString('utf8') } catch { return undefined }
}

function analyze(raw) {
  const result = { header: undefined, tools: undefined, model: undefined, role: undefined, ptc: false, systemText: '', escalations: [], intentTurns: new Map(), unattributable: new Set() }
  /** callId -> turn，用于把 `tool/ptc-dispatch`（无 turn）归回它所属的那一轮。 */
  const callTurns = new Map()
  const recFor = (t) => {
    let rec = result.intentTurns.get(t)
    if (rec === undefined) { rec = { any: false, reply: false, first: false, seenText: false, acting: false }; result.intentTurns.set(t, rec) }
    return rec
  }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    // 意图门逐轮记录（判定在打印处做）。任何带 turn 的事件都算「该轮发生过」，但只有
    // assistant/message 的文本能构成「模型输出了门行」；只有 BEHAVIOR_TOOLS 的调用能让该轮
    // 成为「会改变行为」（= 门行被要求的那类轮次）。
    const turn = event.data && event.data.turn
    const toolName = event.data && event.data.name
    if (event.type === 'tool/call' && typeof turn === 'number') {
      const callId = event.data && event.data.callId
      if (typeof callId === 'string') callTurns.set(callId, turn)
      if (BEHAVIOR_TOOLS.has(toolName)) recFor(turn).acting = true
    } else if ((event.type === 'tool/ptc-dispatch' || event.type === 'tool/ptc-dispatch-start') && BEHAVIOR_TOOLS.has(toolName)) {
      const rootCallId = event.data && event.data.rootCallId
      const t = callTurns.get(rootCallId)
      if (typeof t === 'number') recFor(t).acting = true
      // 归因失败**绝不静默**（按 rootCallId 去重：同一派发会同时出 -start 与完成两个事件，
      // 按事件计数会把数字凭空翻倍）。插件 intent-gate-watchdog.mjs 在同情形 warn；
      // 这里没有 warn 通道（pitfalls #9），所以它必须进**数据面**：计数并进汇总行。
      else result.unattributable.add(typeof rootCallId === 'string' ? rootCallId : '<no rootCallId>')
    }
    if (typeof turn === 'number') {
      const rec = recFor(turn)
      if (INTENT_MARKERS.some((m) => line.includes(m))) rec.any = true
      if (event.type === 'assistant/message') {
        const text = messageText(event)
        if (INTENT_MARKERS.some((m) => text.includes(m))) rec.reply = true
        if (text.trim() !== '' && !rec.seenText) {
          rec.seenText = true
          if (INTENT_MARKERS.some((m) => text.split('\n')[0].includes(m))) rec.first = true
        }
      }
    }
    if (event.type === 'session') result.header = event
    else if (event.type === 'request/header') {
      const h = event.data && event.data.header
      if (h && result.tools === undefined) {
        result.tools = Array.isArray(h.tools) ? h.tools.map((t) => t && t.name).filter(Boolean) : []
        result.model = h.config && h.config.model
      }
    } else if (event.type === 'system/message') {
      // 只取本会话自己的 system prompt —— 绝不能扫整份 JSONL：工具结果里也会出现
      // persona 文本（例如恰好 cat 过预设文件），那会把角色识别带偏。
      const blocks = (event.data && event.data.message && event.data.message.content) || []
      for (const b of blocks) if (b && typeof b.text === 'string') result.systemText += b.text + '\n'
    } else if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch') {
      // A model-initiated sandbox-escalation request. Match the PARSED argument keys,
      // never the raw text: the field names also appear inside files these tools read.
      const toolName = event.data && event.data.name
      if (ESCALATION_TOOLS.has(toolName)) {
        let args = event.data.arguments
        if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = undefined } }
        if (args !== null && typeof args === 'object'
          && ('sandbox_permissions' in args || 'justification' in args)) {
          result.escalations.push({
            tool: toolName,
            sandboxPermissions: 'sandbox_permissions' in args,
            justification: 'justification' in args,
          })
        }
      }
    }
  }
  result.ptc = result.systemText.includes(PTC_MARK)
  // 角色开场句式要求后面跟逗号，避免命中 orchestrator 委派表里的 '**explorer** — ...'
  // 刻意**不**在此枚举角色名：那会是除 yml 与 EXPECTED 之外的**第三处**手工登记点，
  // 新角色漏登记时会走 `!r.role` 分支报「认不出角色」，与 EXPECTED 的 `!want` 分支混在一起、难定位
  // （2026-09-13 新增 designer 时实测踩中）。这里只做**通用**捕获，登记与否交给 EXPECTED 判定：
  // 未登记的角色会得到明确的「新角色没登记进 EXPECTED？」WARN。
  const m = result.systemText.match(/You are \*\*([a-z][a-z0-9-]*)\*\*,/)
  result.role = m ? m[1] : undefined
  // 本 preset 的编排器 persona 独有标记；子代理的 role persona 会遮蔽它，所以只用于识别主 agent
  result.isPresetRoot = result.systemText.includes('Phase 0 — Intent Gate')
  return result
}

/** 逐轮统计：首行 / 可见回复 / 任意文本 三个口径各命中几轮。 */
function intentGateStats(r) {
  const turns = [...r.intentTurns.keys()].sort((a, b) => a - b)
  const s = { turns, first: 0, reply: 0, anywhere: 0, eligible: 0, eligibleFirst: 0 }
  for (const t of turns) {
    const rec = r.intentTurns.get(t)
    if (rec.first) s.first += 1
    if (rec.reply) s.reply += 1
    if (rec.any) s.anywhere += 1
    if (rec.acting) {
      s.eligible += 1
      if (rec.first) s.eligibleFirst += 1
    }
  }
  return s
}

function compare(tools, expected) {
  const have = new Set(tools)
  const want = new Set(expected)
  const extra = [...have].filter((n) => !want.has(n) && n !== RESERVED)
  return {
    extra: extra.filter((n) => !KNOWN_SELF_LAYER.includes(n)),
    known: extra.filter((n) => KNOWN_SELF_LAYER.includes(n)),
    missing: [...want].filter((n) => !have.has(n)),
  }
}

function main() {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const rawOut = args.includes('--raw')
  const files = findSessionFiles()
  if (files.length === 0) { console.log('没找到任何会话文件（' + SESSIONS_ROOT + '）'); return }

  const seen = new Map()
  let skipped = 0
  for (const file of files) {
    const raw = decode(file)
    if (raw === undefined) { skipped += 1; continue }
    const a = analyze(raw)
    if (!a.header) continue
    if (!all && a.header.cwd !== PROJECT_CWD) continue
    const id = String(a.header.id)
    const prev = seen.get(id)
    if (!prev || raw.length > prev.raw.length) seen.set(id, { file, raw, ...a })
  }
  if (seen.size === 0) { console.log('本项目下没有会话（用 --all 扫全部工作区）'); return }

  const rows = [...seen.values()].sort((x, y) => (x.header.createdAt || 0) - (y.header.createdAt || 0))
  let pass = 0, fail = 0, warn = 0, escChild = 0, escRoot = 0, escOther = 0
  const gate = { turns: 0, first: 0, reply: 0, anywhere: 0, eligible: 0, eligibleFirst: 0, sessions: 0 }
  console.log('会话 ' + rows.length + ' 个（工作区 ' + (all ? 'ALL' : PROJECT_CWD) + '），跳过错文件 ' + skipped + '\n')

  for (const r of rows) {
    const depth = r.header.delegationDepth || 0
    if (depth > 0 && !r.role) {
      // 保留跳过（同 cwd 下可能有别的 preset 的子代理，判 FAIL 会误报），但把 depth 与
      // 工具数打出来：§2 步骤 1.2 要确认「孙代升级不复现」，而孙代的特征正是
      // depth>=2 且无角色 persona —— 静默跳过会让这条验证没法查。
      const note = depth >= 2 && (r.header.createdAt || 0) >= BOUND_ADDED_AT
        ? ' — depth≥2 且无角色 persona：留意是否为 §7.7 孙代升级复发'
        : ''
      escOther += (r.escalations || []).length
      console.log('─ 跳过 ' + String(r.header.id).slice(0, 20) + '（非 ptc-roles 子代理：depth=' + depth + ' tools=' + (r.tools || []).length
        + ' esc=' + (r.escalations || []).length + (r.header.isSeeded === true ? ' (seeded — 计数含继承的父日志)' : '') + note + '）')
      continue
    }
    if (depth === 0 && !r.isPresetRoot) { console.log('─ 跳过 ' + String(r.header.id).slice(0, 20) + '（非 ptc-roles 主会话）'); continue }
    const kind = depth === 0 ? '主 agent' : '子代理 d' + depth
    const role = r.role || (depth === 0 ? 'orchestrator(未识别)' : '(未识别)')
    const tools = r.tools || []
    console.log('─ ' + kind + '  ' + String(r.header.id).slice(0, 20) + '  role=' + role + '  model=' + (r.model || '?') + '  ptc=' + (r.ptc ? 'YES' : 'no') + '  tools=' + tools.length)

    const esc = r.escalations || []
    if (depth === 0) escRoot += esc.length
    else escChild += esc.length
    if (esc.length > 0) {
      const detail = esc.map((e) => e.tool + (e.sandboxPermissions ? ' +sandbox_permissions' : '') + (e.justification ? ' +justification' : '')).join(', ')
      console.log('   ' + (depth === 0 ? 'ℹ' : '⚠') + ' 沙箱提权请求 ' + esc.length + ' 次: ' + detail
        + (depth === 0
          ? '（编排器可用，属正常）'
          : ' ← docs/pitfalls.md C 节：子代理的 approval policy 是 never，必被确定性拒绝且不会弹给用户；'
            + '只有在角色子代理上**持续出现**才值得做 sandbox-strip'))
    }

    if (depth === 0) {
      console.log(r.ptc ? '   ✓ 主 agent 保持 PTC（预期）' : '   ! 主 agent 不是 PTC —— 检查底座 tool-presentation 行')
      // round-5 persona 断言：persona 不生效是**静默**的（没有日志通道，见 docs/pitfalls.md #9），
      // 所以这条数据面信号就是「纪律补全是否真的加载」的唯一可查证途径。
      if ((r.header.createdAt || 0) >= PERSONA_V2_SINCE) {
        if (r.systemText.includes(PERSONA_V2_MARK)) {
          console.log('   ✓ 主 agent 载入 round-5 纪律 persona（含 "' + PERSONA_V2_MARK + '"）')
          pass += 1
        } else {
          console.log('   ✗ FAIL 主 agent 未载入 round-5 persona：system prompt 里没有 "' + PERSONA_V2_MARK + '"')
          console.log('     ⇒ 纪律补全没生效。检查 ~/.dsh/.agent-presets/ptc-roles/personas 软链在位，且本会话是 PERSONA_V2_SINCE 之后新开的。')
          fail += 1
        }
      }
      // 意图门合规率：只对**装了门的**主 agent 会话统计（老 persona 的输出形式不同，混入会污染率）。
      if (r.isPresetRoot && (r.header.createdAt || 0) >= PERSONA_V2_SINCE) {
        const g = intentGateStats(r)
        if (g.turns.length > 0) {
          gate.sessions += 1
          gate.turns += g.turns.length; gate.first += g.first; gate.reply += g.reply; gate.anywhere += g.anywhere
          gate.eligible += g.eligible; gate.eligibleFirst += g.eligibleFirst
          console.log('   意图门合规率: ' + g.turns.length + ' 轮（会改变行为 ' + g.eligible + ' 轮）| 首行命中 '
            + g.eligibleFirst + '/' + g.eligible + ' (' + rate(g.eligibleFirst, g.eligible) + ')'
            + ' | 可见回复命中 ' + g.reply + ' | 任意文本命中 ' + g.anywhere)
          console.log('   逐轮(首行): ' + g.turns.map((t) => 'T' + t + (r.intentTurns.get(t).first ? '✓' : '✗')).join(' ')
            + ' | 会改变行为: ' + (g.turns.filter((t) => r.intentTurns.get(t).acting).map((t) => 'T' + t).join(' ') || '无'))
        }
      }
      console.log('   工具面: ' + (rawOut ? tools.join(', ') : tools.slice(0, 8).join(', ') + (tools.length > 8 ? ' …' : '')))
      continue
    }
    if (r.ptc) { console.log('   ✗ FAIL 子代理仍是 PTC：run_code 逃逸还在，白名单不是硬边界'); fail += 1; continue }
    if (!r.role) { console.log('   ! WARN 认不出角色（persona 没注入？）'); warn += 1; continue }
    const want = EXPECTED[r.role]
    if (!want) { console.log('   ! WARN 没有 ' + r.role + ' 的期望白名单（新角色没登记进 EXPECTED？）'); warn += 1; continue }
    const d = compare(tools, want)
    const note = d.known.length > 0 ? ' | ⊘ 已知自身层泄漏（非白名单问题）: ' + d.known.join(', ') : ''
    if (d.extra.length === 0 && d.missing.length === 0) { console.log('   ✓ PASS native + 白名单精确匹配（' + want.length + ' 项）' + note); pass += 1 }
    else { console.log('   ✗ FAIL 白名单不符 | 多出: ' + (d.extra.join(', ') || '无') + ' | 缺失: ' + (d.missing.join(', ') || '无') + note); fail += 1 }
    if (rawOut) console.log('   工具面: ' + tools.join(', '))
  }
  if (gate.turns > 0) {
    console.log('\n意图门合规率（合计 ' + gate.sessions + ' 个主 agent 会话 / ' + gate.turns + ' 轮，其中会改变行为 ' + gate.eligible + ' 轮）: 首行命中 '
      + gate.eligibleFirst + '/' + gate.eligible + ' (' + rate(gate.eligibleFirst, gate.eligible) + ') | 可见回复命中 ' + gate.reply + ' | 任意文本命中 ' + gate.anywhere)
    console.log('  口径: 分子与分母都只算**会改变行为**的轮次（要委派 / 要拒绝 / 要提问 / 要改文件），行为判据 = '
      + 'tool/call 或 tool/ptc-dispatch 的 name 命中 BEHAVIOR_TOOLS（与 intent-gate-watchdog.mjs 同口径）；'
      + 'marker = ' + JSON.stringify(INTENT_MARKERS) + '（与插件的 DEFAULT_MARKERS 同口径）；'
      + '「任意文本」含工具结果与工具参数 ⇒ 读过插件源码的轮次也会命中，只作对照，不作合规分子。')
  }
  const unattributableAll = [...rows].reduce((n, r) => n + (r.unattributable ? r.unattributable.size : 0), 0)
  if (unattributableAll > 0) {
    // 归因失明 ⇒ 那些轮次的「会改变行为」判据看不见东西，合规率分母偏低。插件在同情形
    // 会 warn；这里没有 warn 通道（pitfalls #9），所以这个计数就是它的数据面替身。
    console.log('不可归属的 tool/ptc-dispatch: ' + unattributableAll + ' 个 rootCallId —— 这些轮次的行为判据失明，'
      + '合规率分母偏低（插件 intent-gate-watchdog.mjs 对同情形 warn，见 pitfalls #17）。')
  } else {
    console.log('不可归属的 tool/ptc-dispatch: 0（归因路径健康）')
  }
  console.log('\n汇总: ✓' + pass + '  ✗' + fail + '  !' + warn)
  console.log('提权请求（实测计数）: ptc-roles 主 agent ' + escRoot + ' / ptc-roles 角色子代理 ' + escChild
    + ' / 其他会话 ' + escOther)
  if (escChild === 0) console.log('  ← ptc-roles 角色子代理零提权，与 approval policy never 一致（尚无理由做 sandbox-strip）')
  if (escRoot + escChild + escOther === 0) console.log('  ! 全为 0 —— 用 --all 复核：其他工作区应有非零计数，否则本计数器的阳性路径未被证明')
  if (pass + fail + warn === 0) console.log('提示: 没有任何 ptc-roles 角色子代理会话（只看到主 agent 属正常）。先派 1~2 个角色子代理，再重跑本脚本。')

  // 退出码契约（三个脚本统一为「0 = 符合预期」）：只有 ✗ FAIL 让退出码非 0。
  // `!` 与脚本内的 ✓/⊘ 标记保持 0 —— 它们按设计包含**合法**的已知现象（`⊘ 已知自身层泄漏`
  // 见 pitfalls #7、「非 ptc-roles 子代理」跳过、零提权提示），升级为失败会让脚本常态变红而失去信号。
  process.exitCode = fail === 0 ? 0 : 1
}

main()
