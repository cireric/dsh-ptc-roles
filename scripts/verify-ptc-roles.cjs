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
//     门行 = 字面量 `Intent:`，与 preset/ptc-roles/intent-gate-watchdog.mjs 的 DEFAULT_MARKERS **同口径**
//     （两处必须同步改；本脚本另收旧 token `意图判定`，因为扫的是历史会话，见下方 INTENT_MARKERS 注释）。为什么要把它做进脚本：这个门的失败记录**只能当场测**——会话库是滚动窗口，
//     过一阵就测不回来了（见 docs/evidence/2026-09-15-intent-gate-failure-record.json）。
//     只统计 isPresetRoot 且创建于 PERSONA_V2_SINCE 之后的主 agent 会话（旧 persona 的输出形式不同，混进来会污染率）。
//     **合规分子与分母都只算「会改变行为」的轮次**（要委派 / 要拒绝 / 要提问 / 要改文件）—— persona 的
//     Phase 0 只在那些轮次要求门行；判据是同口径的 BEHAVIOR_TOOLS（见下），与看门狗插件**共享同一份列表**。
//     三个口径：「首行」（该轮第一条有文本的 assistant 消息的第一行）是**合规分子**；「可见回复」（该轮
//     任何 assistant 文本含 marker）与「任意文本」（该轮任何事件行含 marker，**含工具结果**）只作对照——
//     读过插件源码的轮次会命中「任意文本」，那不是合规。
//     **单场静默可观测化**（ADR 0002 的 C 项）：合计率会把「一场 0%」平均掉，所以另按**会话**点名
//     「整场静默」——它是数据面观察、不接退出码（同 pitfalls #19 的取舍）。
//
//   * **不可归属派发计数**（复审裁定 R-02）：`tool/ptc-dispatch` 回指不到任何 `tool/call` 时既不静默、
//     也不只是打印 —— 它是 **✗ FAIL**（归因失明 = 判据看不见东西，属未知异常，健康会话必须为 0；
//     与容忍的 `⊘ 已知自身层泄漏` 不同类，理由见 docs/pitfalls.md #7 与脚本内的注释）。
//     它的阳性路径由 `scripts/fixtures/attribution-cases.json` 的合成日志断言（真机恒为 0，自证不了）。
//     没有 warn 落盘通道这件事见 docs/pitfalls.md #9。
//
//   * **角色事实静态检查**（ADR 0002 的 E 项）：把 yml / 期望白名单（EXPECTED）/ README 角色表三处
//     角色事实做**静态**比对 —— 不再依赖「该角色被派发过」才暴露漂移（没派过的角色，EXPECTED 写错了
//     也没人知道；README 的表从来没人查）。解析器只服务这条检查、失败即 FAIL，四个内存变异对照证明它有牙。
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
 * 这里与 yml 的 `toolFilter.allow` 仍是**两处来源**（不从 yml 生成 EXPECTED、也不在挂载路径上引入第二套
 * 解析 —— pitfalls #11 的教训），但两处的关系现在由**静态漂移检查**证明：见 `roleFactFindings`。
 * 那个解析器只读文本、不参与运行时判定；解析不出来就**响亮失败**，并由四个内存变异对照证明它有牙。
 *
 * 为什么还需要它（原来是「漂移不会静默，因为运行时会 FAIL」）：那条只在**该角色真的被派发过**的窗口里
 * 成立 —— 没派过的角色，EXPECTED 写错了也没人知道；README 的角色表更是从来没人查
 * （pitfalls #12 记的两次被咬：README 模型档写反、脚本里还藏着第三处角色名枚举）。
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
 * 意图门门行（intent gate）的 markers —— 与 preset/ptc-roles/intent-gate-watchdog.mjs 的
 * DEFAULT_MARKERS 同口径（那里是看门狗实际注入提醒的判据）。改一处就要同步另一处：
 * 解析插件配置会引入一个会歪的解析器，而漂移不会静默（合规率立刻变 0）。
 *
 * **这里比插件多一个 token 是有意的**（2026-09-16 门行迁移：意图判定 → `Intent:`）：
 * 本脚本扫的是**历史**会话，迁移前那批只会说旧 token；插件只看**上一轮**，故保持严格。
 * 插件（严）+ 脚本（宽）⇒ 历史读数与 ADR 0002 的回归基线仍然可比。
 */
const INTENT_MARKERS = ['Intent:', '意图判定']

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

/** 「整场静默」判据 —— 打印与自测**共用同一份**，两处漂移会让 C 项变成空转。 */
function gateSilent(s) { return s.eligible > 0 && s.eligibleFirst === 0 }

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

/**
 * R-02 的归因计数器自测：阳性路径**只能**用合成日志证明（真机健康会话里该值恒为 0），
 * 所以合成日志落成 fixture 文件、断言进 PASS/FAIL —— 否则「修好了」这句话的证据是一次性的
 * （与 HANDOFF 里「批准链只活在该会话」同一类问题）。
 * fixture 口径见 scripts/fixtures/attribution-cases.json 的 `what` / `why`。
 */
const ATTRIBUTION_FIXTURE = path.join(__dirname, 'fixtures', 'attribution-cases.json')

function attributionSelfTest() {
  let spec
  try { spec = JSON.parse(fs.readFileSync(ATTRIBUTION_FIXTURE, 'utf8')) } catch (e) {
    return [{ name: 'fixture ' + path.basename(ATTRIBUTION_FIXTURE) + ' 可读', ok: false, detail: '读/解析失败：' + (e && e.message) }]
  }
  const cases = Array.isArray(spec.cases) ? spec.cases : []
  if (cases.length === 0) return [{ name: 'fixture 至少含一条 case', ok: false, detail: 'cases 为空' }]
  return cases.map((c) => {
    const raw = (c.events || []).map((e) => JSON.stringify(e)).join('\n')
    const got = analyze(raw).unattributable.size
    return { name: c.name, ok: got === c.expectUnattributable, detail: '期望 ' + c.expectUnattributable + '，实得 ' + got }
  })
}

// ── 角色事实静态检查（ADR 0002 的 E 项） ─────────────────────────────────────
//
// 单一源 = preset 的 yml。这里只做**比对**：不生成 EXPECTED、不动挂载路径、不参与运行时判定。
const PRESET_YML = path.join(__dirname, '..', 'preset', 'ptc-roles', 'agent.cordis.yml')
const README_FILE = path.join(__dirname, '..', 'README.md')

/** 求值一条 allow 项：普通名字原样返回；`!!js "expr"` 按 yml 的语义求值（只为比对）。 */
function allowEntry(text, role, findings) {
  if (!text.startsWith('!!js')) return text
  const m = /^!!js\s+"(.+)"$/.exec(text)
  if (m === null) {
    // pitfalls #11 的坑：不带引号的 `!!js` 是合法 YAML，但会解析成复合 mapping key ——
    // 静默产出一个**非字符串**的 allow 项，排障极难。这里静态把它点出来。
    findings.push('角色 ' + role + ' 的 !!js 白名单项没加引号（见 pitfalls #11）')
    return text
  }
  try {
    const v = new Function('return (' + m[1] + ')')()
    if (typeof v !== 'string') {
      findings.push('角色 ' + role + ' 的 !!js 项求值不是字符串：' + JSON.stringify(v))
      return '<non-string !!js>'
    }
    return v
  } catch (e) {
    findings.push('角色 ' + role + ' 的 !!js 项求值失败：' + String((e && e.message) || e))
    return '<!!js error>'
  }
}

/**
 * 从 yml 文本里抽角色行。只认「顶层 `- id: role-*` 且 `name` 是 tool-subagent」的块
 * （`role-presentation` 那个插件行因此被排除）；解析不出任何角色行时**记一条 finding**，
 * 绝不允许静默返回空集 —— 那正是「解析器一歪、结论跟着歪」的形态。
 */
function parseRoleFacts(text, findings) {
  const blocks = new Map()
  let block = null
  for (const line of text.split('\n')) {
    const idMatch = /^- id: role-([A-Za-z0-9_-]+)\s*$/.exec(line)
    if (idMatch !== null) {
      block = { id: idMatch[1], isRoleRow: false, hasToolFilter: false, allow: [], maxDepth: undefined, effort: undefined }
      blocks.set(block.id, block)
      continue
    }
    if (/^- /.test(line)) { block = null; continue }          // 下一个顶层条目 ⇒ 当前块结束
    if (block === null) continue
    if (/^  name: '@deepseek-ai\/dsh-tool-subagent'\s*$/.test(line)) { block.isRoleRow = true; continue }
    const toolName = /^    toolName: (.+)$/.exec(line)
    if (toolName !== null) { block.toolName = toolName[1].trim(); continue }
    const maxDepth = /^    maxDepth: (\d+)\s*$/.exec(line)
    if (maxDepth !== null) { block.maxDepth = Number(maxDepth[1]); continue }
    const effort = /^      reasoningEffort: (.+)$/.exec(line)
    if (effort !== null) { block.effort = effort[1].trim(); continue }
    if (/^    toolFilter:\s*$/.test(line)) { block.hasToolFilter = true; continue }
    const item = /^        - (.+)$/.exec(line)
    if (item !== null && block.hasToolFilter) block.allow.push(allowEntry(item[1].trim(), block.id, findings))
  }
  const roles = new Map()
  for (const [id, b] of blocks) {
    if (id === 'presentation' || !b.isRoleRow) continue      // 插件行 / 非角色行
    if (!b.hasToolFilter) { findings.push('角色行 ' + id + ' 没有 toolFilter（形状变了？）'); continue }
    roles.set(b.toolName || id, b)
  }
  if (roles.size === 0) findings.push('从 yml 解析不出任何角色行 —— 结构变了吗？改解析器，别让它静默通过')
  return roles
}

/** 从 README 的角色表抽 `| \`role\` | 职责 | maxDepth | 白名单要点 | 模型档 |` 行。 */
function parseReadmeRoles(text) {
  const out = new Map()
  for (const line of text.split('\n')) {
    if (!line.startsWith('| `')) continue                   // orchestrator 行无引号 ⇒ 天然不参与（它不来自 yml）
    const cols = line.split('|').map((c) => c.trim())
    if (cols.length < 7) continue
    const tierText = cols[5]
    const tier = /不声明 effort/.test(tierText) ? 'none'
      : /\blow\b/.test(tierText) ? 'low'
        : /\bhigh\b/.test(tierText) ? 'high' : 'unknown'
    out.set(cols[1].replace(/`/g, ''), { maxDepth: cols[3], tier })
  }
  return out
}

/** 三处事实（yml / EXPECTED / README 角色表）逐项比对，返回漂移清单（空 = 一致）。 */
function roleFactFindings(ymlText, readmeText, expected) {
  const findings = []
  const roles = parseRoleFacts(ymlText, findings)
  for (const [name, b] of roles) {
    const want = expected[name]
    if (want === undefined) { findings.push('yml 有角色 ' + name + '，但 EXPECTED 未登记'); continue }
    const have = new Set(b.allow)
    const wantSet = new Set(want)
    const missing = want.filter((n) => !have.has(n))
    const extra = b.allow.filter((n) => !wantSet.has(n))
    if (missing.length > 0) findings.push('角色 ' + name + '：yml 的 allow 少了 ' + missing.join(', '))
    if (extra.length > 0) findings.push('角色 ' + name + '：yml 的 allow 多出 ' + extra.join(', '))
  }
  for (const name of Object.keys(expected)) {
    if (!roles.has(name)) findings.push('EXPECTED 有角色 ' + name + '，但 yml 里没有对应的角色行')
  }
  const rows = parseReadmeRoles(readmeText)
  for (const [name, b] of roles) {
    const row = rows.get(name)
    if (row === undefined) { findings.push('README 角色表缺 ' + name + ' 行'); continue }
    if (String(b.maxDepth) !== String(row.maxDepth)) {
      findings.push('角色 ' + name + '：README maxDepth=' + row.maxDepth + ' 与 yml ' + b.maxDepth + ' 不一致')
    }
    const wantTier = b.effort === undefined ? 'none' : b.effort
    if (row.tier !== wantTier) {
      findings.push('角色 ' + name + '：README 模型档「' + row.tier + '」与 yml reasoningEffort='
        + (b.effort === undefined ? '未声明' : b.effort) + ' 不一致')
    }
  }
  for (const name of rows.keys()) if (!roles.has(name)) findings.push('README 角色表有 ' + name + '，但 yml 里没有')
  return findings
}

/**
 * 静态检查的自证：先在真文件上比一次，再用**内存变异**造四种真漂移 —— 每一种都必须被抓到。
 * 变异以当前文件内容为基准（对照不会随时间腐坏）；变异没生效时**这条对照自己 FAIL**，
 * 否则它就成了空转（同 attributionSelfTest 与两个单测的 --control 纪律）。
 */
function roleFactsSelfTest() {
  let yml, readme
  try {
    yml = fs.readFileSync(PRESET_YML, 'utf8')
    readme = fs.readFileSync(README_FILE, 'utf8')
  } catch (e) {
    return [{ name: 'preset yml 与 README 可读', ok: false, detail: String((e && e.message) || e) }]
  }
  const out = []
  const clean = roleFactFindings(yml, readme, EXPECTED)
  out.push({ name: '静态检查：yml ↔ EXPECTED ↔ README 三处角色事实一致', ok: clean.length === 0, detail: clean.join('；') })
  const control = (label, findings, expectSubstring) => {
    const hit = findings.some((f) => f.includes(expectSubstring))
    out.push({ name: label, ok: hit, detail: hit ? '' : '期望报告含「' + expectSubstring + '」，实得：' + (findings.join('；') || '（无 finding）') })
  }
  const mutated = (text, from, to) => {
    const next = text.split(from).join(to)
    return next === text ? undefined : next
  }
  const uniq = '        - mcp__codegraph__codegraph_explore\n'
  const noExplore = mutated(yml, uniq, '')
  control('对照①：yml 删掉 explorer 的一项 allow ⇒ 报告 yml 侧漂移',
    noExplore === undefined ? [{ phantom: '对照组失效：变异目标文本不存在' }] : roleFactFindings(noExplore, readme, EXPECTED), noExplore === undefined ? '永不匹配' : 'explorer')
  const noDesigner = mutated(readme, '| `designer` |', '| `designer-GONE` |')
  control('对照②：README 角色表改名（等价于缺行）⇒ 报告 README 侧漂移',
    noDesigner === undefined ? [{ phantom: '对照组失效：变异目标文本不存在' }] : roleFactFindings(yml, noDesigner, EXPECTED), noDesigner === undefined ? '永不匹配' : 'designer')
  const bogusExpected = { ...EXPECTED, explorer: [...EXPECTED.explorer, 'phantom_tool'] }
  control('对照③：EXPECTED 多一项 ⇒ 报告脚本侧漂移', roleFactFindings(yml, readme, bogusExpected), 'phantom_tool')
  const unquoted = mutated(yml, `- !!js "process.platform === 'win32' ? 'pwsh' : 'bash'"`, `- !!js process.platform === 'win32' ? 'pwsh' : 'bash'`)
  control('对照④：yml 里 !!js 去掉引号 ⇒ 报告 pitfalls #11 的坑',
    unquoted === undefined ? [{ phantom: '对照组失效：变异目标文本不存在' }] : roleFactFindings(unquoted, readme, EXPECTED), unquoted === undefined ? '永不匹配' : '引号')
  return out
}

/**
 * C（ADR 0002「单场合规失败的可观测化」）的自证：「整场静默」在真机上会随滚动窗口消失，
 * 所以用合成日志 fixture 把阳性/阴性路径钉住。口径见 scripts/fixtures/intent-gate-cases.json。
 */
const GATE_FIXTURE = path.join(__dirname, 'fixtures', 'intent-gate-cases.json')

function gateSelfTest() {
  let spec
  try { spec = JSON.parse(fs.readFileSync(GATE_FIXTURE, 'utf8')) } catch (e) {
    return [{ name: 'fixture ' + path.basename(GATE_FIXTURE) + ' 可读', ok: false, detail: '读/解析失败：' + (e && e.message) }]
  }
  const cases = Array.isArray(spec.cases) ? spec.cases : []
  if (cases.length === 0) return [{ name: 'fixture 至少含一条 case', ok: false, detail: 'cases 为空' }]
  return cases.map((c) => {
    const raw = (c.events || []).map((e) => JSON.stringify(e)).join('\n')
    const s = intentGateStats(analyze(raw))
    const silent = gateSilent(s)
    const want = c.expect || {}
    const ok = s.eligible === want.eligible && s.eligibleFirst === want.eligibleFirst && silent === want.silent
    return { name: c.name, ok, detail: '期望 ' + JSON.stringify(want) + '，实得 eligible=' + s.eligible
      + ' eligibleFirst=' + s.eligibleFirst + ' silent=' + silent }
  })
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
  let pass = 0, fail = 0, warn = 0, escChild = 0, escRoot = 0, escOther = 0
  let silentSessions = 0     // 单场「门行整场静默」的会话数（观察项，不接退出码 —— pitfalls #19）
  const gate = { turns: 0, first: 0, reply: 0, anywhere: 0, eligible: 0, eligibleFirst: 0, sessions: 0 }

  // 角色事实静态检查**先跑**，且不因「没有会话」被跳过 —— 它只读仓库文件（ADR 0002 的 E 项）。
  console.log('角色事实静态检查（E —— 单一源 = preset/ptc-roles/agent.cordis.yml；比对 yml / EXPECTED / README 角色表）:')
  for (const t of roleFactsSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { console.log('   ✗ FAIL ' + t.name + '（' + t.detail + '）'); fail += 1 }
  }

  const files = findSessionFiles()
  if (files.length === 0) {
    console.log('\n没找到任何会话文件（' + SESSIONS_ROOT + '）—— 上面的静态检查结论仍有效')
    console.log('\n汇总: ✓' + pass + '  ✗' + fail + '  !' + warn)
    return
  }

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
  if (seen.size === 0) {
    console.log('本项目下没有会话（用 --all 扫全部工作区）—— 上面的静态检查结论仍有效')
    console.log('\n汇总: ✓' + pass + '  ✗' + fail + '  !' + warn)
    return
  }

  const rows = [...seen.values()].sort((x, y) => (x.header.createdAt || 0) - (y.header.createdAt || 0))
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
          // C（ADR 0002）：总量里的一个「0%」会被平均掉，所以要**按会话**点名「整场静默」——
          // 那是「旗舰机制静默死」唯一的可见形态。它是**观察项**：模型行为不该让套件随机变红（pitfalls #19）。
          if (gateSilent(g)) {
            silentSessions += 1
            console.log('   ! 本场门行**整场静默**：会改变行为 ' + g.eligible + ' 轮、首行命中 0 —— 见 ADR 0002「旗舰行为机制可以整场静默失效」')
            console.log('     （观察项，不接退出码；要判定是「模型没写」还是「口径把只读轮算进去了」，看上面的逐轮与会改变行为两行）')
          }
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
    console.log('  整场静默的会话: ' + silentSessions + '/' + gate.sessions
      + '（观察项，不进 ✓/✗/! 的账 —— 模型行为不该让套件随机变红，见 pitfalls #19）')
    console.log('  口径: 分子与分母都只算**会改变行为**的轮次（要委派 / 要拒绝 / 要提问 / 要改文件），行为判据 = '
      + 'tool/call 或 tool/ptc-dispatch 的 name 命中 BEHAVIOR_TOOLS（与 intent-gate-watchdog.mjs 同口径）；'
      + 'marker = ' + JSON.stringify(INTENT_MARKERS) + '（与插件的 DEFAULT_MARKERS 同口径）；'
      + '「任意文本」含工具结果与工具参数 ⇒ 读过插件源码的轮次也会命中，只作对照，不作合规分子。')
  }
  const unattributableAll = [...rows].reduce((n, r) => n + (r.unattributable ? r.unattributable.size : 0), 0)
  if (unattributableAll > 0) {
    // 归因失明 ⇒ 那些轮次的「会改变行为」判据看不见东西，合规率分母偏低。插件在同情形
    // 会 warn；这里没有 warn 通道（pitfalls #9），所以这个计数就是它的数据面替身。
    // 它是 **FAIL 而不是提示**：`⊘ 已知自身层泄漏`（#7）是已知且掩不掉的合法现象，所以容忍；
    // 归因失明是**未知异常**，健康会话里必须为 0 —— 同 R-01 判「单向判据不合格」的理由。
    console.log('✗ FAIL 不可归属的 tool/ptc-dispatch: ' + unattributableAll + ' 个 rootCallId —— 这些轮次的行为判据失明，'
      + '合规率分母偏低（插件 intent-gate-watchdog.mjs 对同情形 warn，见 pitfalls #9）。')
    console.log('  ⇒ 先查 tool/call 的 callId 与派发的 rootCallId 是否还同名同源；别把这个数字降回提示。')
    fail += 1
  } else {
    console.log('不可归属的 tool/ptc-dispatch: 0（归因路径健康）')
  }
  // 归因计数的**阳性路径**（真机恒为 0，自证不了）：改用 fixture 里的合成日志断言，见自测说明。
  console.log('\n归因计数器自测（合成日志 fixture scripts/fixtures/attribution-cases.json —— R-02 的阳性路径）:')
  for (const t of attributionSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { console.log('   ✗ FAIL ' + t.name + '（' + t.detail + '）'); fail += 1 }
  }
  console.log('\n意图门统计自测（合成日志 fixture scripts/fixtures/intent-gate-cases.json —— C 项的阳性路径）:')
  for (const t of gateSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { console.log('   ✗ FAIL ' + t.name + '（' + t.detail + '）'); fail += 1 }
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
