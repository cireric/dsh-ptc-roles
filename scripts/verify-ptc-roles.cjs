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
//   * **意图门合规率**（intent gate）：逐轮判定主 agent「有没有输出门行」。合规判据是 **① 存在口径**：
//     门行所在消息的序号 ≤ 承载**首个**行为动作的那条消息的序号（同一条消息里的门行**算数** ——
//     文本与工具调用是同一次生成，且没有工具调用的消息会结束本轮，见 pitfalls #19/#20）。
//     旧的 **② 前置口径**（门行**早于**动作载体）降为**对照读数**（「最好更早」），不再接合规分子。
//     门行 = 字面量 `Intent:`，与 preset/ptc-roles/intent-gate-watchdog.mjs 的 DEFAULT_MARKERS **同口径**
//     （两处必须同步改；本脚本另收旧 token `意图判定`，因为扫的是历史会话，见下方 INTENT_MARKERS 注释）。为什么要把它做进脚本：这个门的失败记录**只能当场测**——会话库是滚动窗口，
//     过一阵就测不回来了（见 docs/evidence/2026-09-15-intent-gate-failure-record.json）。
//     只统计 isPresetRoot 且创建于 PERSONA_V2_SINCE 之后的主 agent 会话（旧 persona 的输出形式不同，混进来会污染率）。
//     **合规分子与分母都只算「会改变行为」的轮次**（要委派 / 要拒绝 / 要提问 / 要改文件）—— persona 的
//     Phase 0 只在那些轮次要求门行；判据是同口径的 BEHAVIOR_TOOLS（见下），与看门狗插件**共享同一份列表**。
//     **单场静默可观测化**（ADR 0002 的 C 项）：合计率会把「一场 0%」平均掉，所以另按**会话**点名
//     「整场静默」——它是数据面观察、不接退出码（同 pitfalls #19 的取舍）。
//
//     **分母 = user-opened turns（2026-09-20 起）**。persona 把 Phase 0 的义务限定在
//     **user-opened turns**（一次授权一行；工具结果 / 子代理完成通知 / 注入提醒 / 回灌图片这类
//     **机器消息**续跑的轮次是**同一份授权还在跑**，不欠新行），插件只在「本轮 claim 的消息里含
//     `source.kind === 'user'`」的轮次上设 `userTurn` 并开闸（intent-gate-watchdog.mjs:349,358）。
//     读者此前按「每轮」做分母，于是插件从未开闸的机器轮次也被算进分母 —— 2026-09-19 两场真实任务里
//     闸门 0 拒绝而读者报 50–60%，差的就是这个资格口径（persona / 插件**都不动**，只换读者分母）。
//     - **唯一判据**：该轮起点被 claim 的那批 `user/message` 里**最近于轮起点的那一条**（按 `seq`）
//       的 `source.kind === 'user'` ⇒ user-opened；其余 kind 一律算**机器开轮**。
//       `user/message` 事件**不带 `turn` 字段**，只能按 `seq` 与时序反推（用 turn 归属会全空）。
//     - 合规**分子**仍是 ① 存在口径，只换**分母**：分子/分母都只算 user-opened 且**会改变行为**的轮次。
//     - **旧「每轮制」读数全部保留**，标为「对照口径（每轮制，旧读数）」；机器开轮的**数量**与其中
//       **动了手的轮数**打印为**观察项**，不进分子分母（与 pitfalls #19「观察项不接退出码」同取舍）。
//     - 同一判据的另一处登记是 persona 的字面量 `user-opened turns` —— 两处漂移不会静默：
//       `userOpenedScopeSelfTest`（同 behaviorToolsSelfTest 的形状）当场报 FAIL。
//
//   * **每会话常备读数（2026-09-20 新增）**：① `user/message` 通道构成（总条数 / 真用户 / 机器，
//     以及**实际见到的 kind 取值表**与解析用的 source 路径计数）；② token **四桶**
//     （uncachedInput / output / cacheRead / cacheWrite），折叠语义照抄 pitfalls #22②：
//     计入 `assistant/message`，同一 `(turn, step)` 是**替换**（取最后一条）；`assistant/attempt`
//     带 usage 时**单独报告**、不并入四桶，并打印 `llm/retry-started` 次数说明重试口径。
//     ⚠️ 框架里**没有价目表** ⇒ 只报 **token 桶**，不报「成本」；且**不跨会话汇总**
//     （seeded 会话是父事件的深拷贝，相加会把父的用量算第二遍，pitfalls #22③）。
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
// 默认工作区 = 本仓库根（`scripts/..`）。**不写死绝对路径**：换机 / 换 clone / 改目录名时，
// 写死会让「本项目下没有会话」静默退 0，而判定行看起来一切正常（2026-09-17 评审 M2/F-14）。
// `--cwd <path>` 覆盖；`--all` 仍然扫全部工作区。
const DEFAULT_PROJECT_CWD = path.resolve(__dirname, '..')
let SESSIONS_ROOT = process.env.PTC_SESSIONS !== undefined && process.env.PTC_SESSIONS.trim() !== ''
  ? path.resolve(process.env.PTC_SESSIONS)
  : path.join(os.homedir(), '.dsh', 'sessions')

/** `--control-sessions`：本次运行的输入是**合成会话夹具**，判据 = 失败集合相等（复盘 P1-2）。 */
const CONTROL_SESSIONS = process.argv.includes('--control-sessions')
/** 合成夹具 `scripts/fixtures/sessions-ci/main.jsonl` 上**必须**失败的那几条（名字与 failLine 一致）。 */
const REQUIRED_FIXTURE_FAILURES = ['主 agent 不是 PTC']
/** 夹具会话的 cwd —— 会话扫描按工作区过滤，所以夹具模式必须把工作区也指过去。 */
const FIXTURE_CWD = '/tmp/ptc-fixture-workspace'

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
 * 轮次资格口径的**字面量** —— persona 与 reader 各写一份，两处必须同口径。
 *
 * persona（`personas/orchestrator.md`）把 Phase 0 的义务写死成 `user-opened turns`；本脚本用同一串
 * 字面量给合规率的分母命名。这不是文档同步问题，而是**判据同步**问题：口径一改，两边必须同时改，
 * 否则读者量的是另一个东西（2026-09-16 的「任意位置 vs 首行」就是这么漂的，见 pitfalls #19）。
 * `userOpenedScopeSelfTest` 逐字比对这条字面量，并带三个内存变异对照证明它不会空转。
 */
const USER_OPENED_SCOPE = 'user-opened turns'
/** persona 文件 —— 口径的另一个登记点（与 BEHAVIOR_TOOLS 的插件↔脚本关系同构）。 */
const PERSONA_FILE = path.join(__dirname, '..', 'preset', 'ptc-roles', 'personas', 'orchestrator.md')
/** `user/message.data.source.kind` 取这个值 = **真用户**开的轮；其余 kind 一律算机器开轮。 */
const USER_KIND = 'user'

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

/**
 * `user/message` 的来源 kind —— 只有 `'user'` 是真用户，其余（plugin / subagent-settled /
 * agent-instructions / skill-catalog / agent-message / skill-invocation …）都是机器写的。
 *
 * 两条路径都读：判据的字面位置是 `data.message.source.kind`（框架/插件看到的是 `UserMessage`，
 * `intent-gate-watchdog.mjs:349` 判的就是 `m.source.kind`），而**落盘**形状把 UserMessage 摊在
 * `data` 下 ⇒ 实测 386/386 条都在 `data.source.kind`。两条都读、并把**实际走哪条**计数打印出来，
 * 是为了不让「提取器漏了兜底 ⇒ 全判机器开轮」这种错（pitfalls #24 表②）静默发生。
 */
function userMessageSource(event) {
  const m = event.data && event.data.message
  if (m && m.source && typeof m.source.kind === 'string') return { kind: m.source.kind, path: 'message' }
  const d = event.data
  if (d && d.source && typeof d.source.kind === 'string') return { kind: d.source.kind, path: 'data' }
  return { kind: undefined, path: 'none' }
}

/** 事件上的 usage 采样（`assistant/message` / `assistant/attempt` 逐 step 带，见 pitfalls #22①）。 */
function usageOf(event) {
  const u = event.data && event.data.usage
  return u !== null && typeof u === 'object' ? u : undefined
}

/**
 * 四桶提取 —— **不自造桶**（pitfalls #22①）：`inputTokens` 只是**未缓存输入**，
 * 计费输入 = uncachedInput + cacheRead + cacheWrite；`totalTokens` 不当分母，故不读。
 * 缺字段（例如本机实测多数路由没有 `cacheWriteTokens`）按 0 计，不猜。
 */
function bucketsOf(u) {
  return {
    uncachedInput: Number(u.inputTokens) || 0,
    output: Number(u.outputTokens) || 0,
    cacheRead: Number(u.cacheReadTokens) || 0,
    cacheWrite: Number(u.cacheWriteTokens) || 0,
  }
}

const ZERO_BUCKETS = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const BUCKET_KEYS = ['uncachedInput', 'output', 'cacheRead', 'cacheWrite']

function addBuckets(a, b) {
  const out = {}
  for (const k of BUCKET_KEYS) out[k] = a[k] + b[k]
  return out
}

/** 千分位 —— 只影响打印，不参与判定。 */
function num(n) { return n.toLocaleString('en-US') }

/**
 * token 四桶的折叠（pitfalls #22② 的 ① 与 ②）：**同一 `(turn, step)` 是替换，不是累加**
 * （取最后一条 `assistant/message` 的 usage）。`assistant/attempt` 另有 usage 时**单独报告**
 * —— 框架的替换槽由 `llm/retry-started` 关闭（重试的那一次要**加**），这里不替框架做那个加法。
 */
function usageTotals(r) {
  let totals = { ...ZERO_BUCKETS }
  for (const b of r.usage.bySlot.values()) totals = addBuckets(totals, b)
  let attempts = { ...ZERO_BUCKETS }
  for (const s of r.usage.attempts) attempts = addBuckets(attempts, s.buckets)
  return { totals, attempts }
}

function findSessionFiles() {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      // `.jsonl` = 明文合成会话（CI 夹具）。真机会话一律 `.zstd`。
      else if (e.name.endsWith('.zstd') || e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(SESSIONS_ROOT)
  return out
}

/** zstd 可用性：**先探测**。缺失时逐文件静默跳过 = 行为判据整段消失却仍退 0（评审 M2/F-4）。 */
function zstdAvailable() {
  try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

/** 解不开的按类记账：ENOENT（环境缺 zstd）与其余（文件损坏 / 超 maxBuffer）是两类事实。 */
const decodeFailures = { enoent: 0, other: 0 }

function decode(file) {
  // 明文合成会话（CI 夹具）：直接读 —— 这条路径让「非 PTC 主 agent」这类分支能被合成输入触发，
  // 而不是只能等真机上恰好出现（复盘 P1-2）。
  if (file.endsWith('.jsonl')) {
    try { return fs.readFileSync(file, 'utf8') } catch { decodeFailures.other += 1; return undefined }
  }
  try { return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 29 }).toString('utf8') }
  catch (err) {
    // 不写空 catch（AGENTS.md 全局 Never 表）：解不开这件事必须留下**分类计数**，否则
    // 「全部解不开」与「一个都没坏」在读数上长得一模一样。
    if (err && err.code === 'ENOENT') decodeFailures.enoent += 1
    else decodeFailures.other += 1
    return undefined
  }
}

/** 工作区比较：先归一，再退到 realpath —— 同一目录的两种写法（软链 / 尾斜杠）不该被 filter 掉。 */
function sameCwd(a, b) {
  if (typeof a !== 'string' || a === '') return false
  const abs = path.resolve(a)
  if (abs === b) return true
  let ra
  let rb
  try { ra = fs.realpathSync(abs) } catch { return false }
  try { rb = fs.realpathSync(b) } catch { return false }
  return ra === rb
}

function analyze(raw) {
  const result = { header: undefined, tools: undefined, model: undefined, role: undefined, ptc: false, systemText: '', escalations: [], intentTurns: new Map(), unattributable: new Set(),
    // ── 每会话常备读数（2026-09-20）─────────────────────────────────────────
    /** 逐条 `user/message`：**没有 turn 字段**，只能按 `seq` 归轮（`{ seq, kind }`，文件顺序即 seq 顺序）。 */
    userMsgs: [],
    /** 实际见到的 source.kind 取值表（kind → 条数）—— 打印出来供复核。 */
    userKindCounts: new Map(),
    /** 解析走了哪条路径（判据字面位置 vs 落盘形状 vs 都没读到）。 */
    userSourcePaths: { message: 0, data: 0, none: 0 },
    /** token 折叠：`(turn,step)` → 最后一条 `assistant/message` 的四桶；attempt 另存。 */
    usage: { bySlot: new Map(), attempts: [], attemptsSeen: 0, retries: 0, samples: 0 } }
  /** callId -> { turn, carrier }：把无 turn 的 `tool/ptc-dispatch` 归回它所属的那一轮，并记下载体消息。 */
  const callTurns = new Map()
  /** 单调递增的 assistant 消息序号（**含纯工具调用消息**）；①/② 判据只比较同一轮内的消息先后。 */
  let msgSeq = 0
  /** 最近一条 assistant 消息的序号 —— 紧随其后的 tool/call 产生自它。 */
  let lastMsgSeq = -1
  const recFor = (t) => {
    let rec = result.intentTurns.get(t)
    if (rec === undefined) {
      rec = { any: false, reply: false, first: false, seenText: false, acting: false,
        declSeq: undefined, firstActCarrier: undefined, carriers: [],
        // 轮次资格（user-opened）用：轮起点 seq 与该轮首个 assistant/message 的 seq。
        originSeq: undefined, firstAsstSeq: undefined }
      result.intentTurns.set(t, rec)
    }
    return rec
  }
  /** 记一次行为动作及其载体消息序号（① 口径：**首个**动作的载体决定该轮合不合规）。
   *  同时记下首个动作的**工具名** —— 成因分类要用它认出「开轮 shell 侦察」（pitfalls #17）。 */
  const noteAction = (t, carrier, name) => {
    const rec = recFor(t)
    rec.acting = true
    rec.carriers.push(carrier)
    if (rec.firstActCarrier === undefined) { rec.firstActCarrier = carrier; rec.firstActName = name }
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
      // 载体 = 产生这次调用的那条消息（tool/call 事件紧随它的 assistant/message）。
      if (typeof callId === 'string') callTurns.set(callId, { turn, carrier: lastMsgSeq })
      if (BEHAVIOR_TOOLS.has(toolName)) noteAction(turn, lastMsgSeq, toolName)
    } else if (event.type === 'tool/ptc-dispatch' && BEHAVIOR_TOOLS.has(toolName)) {
      // 只计**完成**事件：同一派发会同时出 `-start` 与完成两个事件，而两者的 `owner.carrier` 完全相同
      // （载体来自外层 `tool/call` 的映射）⇒ 计两次只会让 `carriers` 翻倍，即覆盖率的分母凭空翻倍
      // （2026-09-20 修：实测一场 30 次派发被印成 60）。
      const rootCallId = event.data && event.data.rootCallId
      const owner = callTurns.get(rootCallId)
      if (owner !== undefined) noteAction(owner.turn, owner.carrier, toolName)
      // 归因失败**绝不静默**（按 rootCallId 去重：同一派发会同时出 -start 与完成两个事件，
      // 按事件计数会把数字凭空翻倍）。插件 intent-gate-watchdog.mjs 在同情形 warn；
      // 这里没有 warn 通道（pitfalls #9），所以它必须进**数据面**：计数并进汇总行。
      else result.unattributable.add(typeof rootCallId === 'string' ? rootCallId : '<no rootCallId>')
    }
    if (typeof turn === 'number') {
      const rec = recFor(turn)
      if (rec.originSeq === undefined && typeof event.seq === 'number') rec.originSeq = event.seq
      if (INTENT_MARKERS.some((m) => line.includes(m))) rec.any = true
      if (event.type === 'assistant/message') {
        const text = messageText(event)
        msgSeq += 1
        lastMsgSeq = msgSeq
        if (rec.firstAsstSeq === undefined && typeof event.seq === 'number') rec.firstAsstSeq = event.seq
        if (INTENT_MARKERS.some((m) => text.includes(m))) rec.reply = true
        if (text.trim() !== '') {
          if (!rec.seenText) {
            rec.seenText = true
            if (hasFirstLineMarker(text)) rec.first = true
          }
          // ① / ② 的共用输入：认**第一次**出现的门行（某条消息的首行），之后不再改判。
          if (rec.declSeq === undefined && hasFirstLineMarker(text)) rec.declSeq = msgSeq
        }
        // token 折叠（pitfalls #22②）：同一 (turn, step) 是**替换** ⇒ Map 后写覆盖先写（取最后一条）。
        const u = usageOf(event)
        if (u !== undefined) {
          result.usage.samples += 1
          result.usage.bySlot.set(turn + ':' + event.data.step, bucketsOf(u))
        }
      } else if (event.type === 'assistant/attempt') {
        // attempt 的 usage **单独报告**，不进四桶：替换槽由 `llm/retry-started` 关闭（#22②），
        // 要不要把重试那一次加上是框架投影的语义，读者不替它做，只在打印里说清。
        const u = usageOf(event)
        if (u !== undefined) result.usage.attempts.push({ turn, step: event.data.step, buckets: bucketsOf(u) })
      }
    }
    if (event.type === 'assistant/attempt') result.usage.attemptsSeen += 1
    else if (event.type === 'llm/retry-started') result.usage.retries += 1
    else if (event.type === 'user/message') {
      // `user/message` **没有 turn 字段**（pitfalls #24② 那类提取器错误的现场）：这里只把每条按
      // `seq` 收进 `userMsgs`，**归轮**在 intentGateStats/qualifyTurn 里按 seq 切（用 turn 归属会全空）。
      const src = userMessageSource(event)
      result.userMsgs.push({ seq: typeof event.seq === 'number' ? event.seq : undefined, kind: src.kind })
      result.userKindCounts.set(String(src.kind), (result.userKindCounts.get(String(src.kind)) || 0) + 1)
      result.userSourcePaths[src.path] += 1
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

/** 首行（**该轮第一条有文本的 assistant 消息**的首行）是否是门行 —— 三个口径共用这一个判断。 */
function hasFirstLineMarker(text) { return INTENT_MARKERS.some((m) => text.split('\n')[0].includes(m)) }

/**
 * ① 存在口径（合规判据，2026-09-17 起）：门行所在消息的序号 **≤** 承载**首个**行为动作的
 * 载体消息序号 —— 同一条消息里的门行**算数**。
 *
 * 为什么同消息算数：文本与工具调用在同一条 assistant 消息里是**同一次生成**
 * （agent-loop/src/agent.ts:466-489），而**没有工具调用的消息会结束本轮**（agent.ts:487-488），
 * 所以「单发一条声明再动手」在本框架里不可能；模型能写的那一行只能与动作同处一条消息。
 * ② 前置口径（`declSeq < firstActCarrier`，见 declaredBefore）**不再**是义务，只作对照读数。
 * 口径登记处：docs/pitfalls.md #19。
 */
function declared(rec) {
  return rec !== undefined && rec.acting === true && rec.declSeq !== undefined
    && rec.firstActCarrier !== undefined && rec.declSeq <= rec.firstActCarrier
}

/** ② 前置口径 —— **对照读数**（「最好更早」）：门行所在消息严格早于首个动作的载体消息。 */
function declaredBefore(rec) {
  return rec !== undefined && rec.acting === true && rec.declSeq !== undefined
    && rec.firstActCarrier !== undefined && rec.declSeq < rec.firstActCarrier
}

/** 「整场静默」判据（① 口径，**每轮制对照**）—— 打印与自测**共用同一份**，两处漂移会让 C 项变成空转。 */
function gateSilent(s) { return s.eligible > 0 && s.eligibleDeclared === 0 }

/** 同一条观察的 **user-opened 口径**版（新分母）：有该欠行的轮次却整场 0 命中。 */
function gateSilentUserOpened(s) { return s.userOpenedEligible > 0 && s.userOpenedDeclared === 0 }

/**
 * 一轮的**资格**（轮次资格 = user-opened turns，2026-09-20 起是合规率的分母）。
 *
 * 唯一判据：该轮起点被 claim 的那批 `user/message` 里**最近于轮起点的那一条**（按 `seq`）的
 * `source.kind === 'user'` ⇒ `origin === 'user'`（user-opened）；**其余 kind 一律算机器开轮**；
 * 无法按 seq 归轮（旧日志 / 合成夹具没有 seq）⇒ `origin === 'unknown'`，也算机器开轮但**单独计数**。
 *
 * 为什么不按 `turn` 字段：`user/message` 事件**不带 turn**（pitfalls #24② 那类提取器错误的现场）
 * —— 用 turn 归属会一条都取不到，必须按 `seq`/时序反推。
 *
 * 两个观察项（都**不进分子分母**）：
 *   · `batchUserNotFirst`：批内**含** user 但最近那条不是它。插件判据是
 *     `messages.some(m => m.source.kind === 'user')`（intent-gate-watchdog.mjs:349），本判据是
 *     「最近那一条」；实测 161/161 个含 user 的开轮批次里 user 都是首条 ⇒ 两者等价。一旦不等价，
 *     这个计数会把它打印出来 —— 口径分歧必须可见（那是 pitfalls #12 那类漂移的入口）。
 *   · `midTurnUserOnly`：机器开轮的**轮内**（开轮批次之后）才出现真用户消息 —— 那是「重新授权」，
 *     但**不改变开轮归属**（本口径按「开轮」计，照实打印以免被读成真用户开轮）。
 */
function qualifyTurn(r, t, nextOriginSeq) {
  const rec = r.intentTurns.get(t)
  const originSeq = rec === undefined ? undefined : rec.originSeq
  const none = { origin: 'unknown', batch: [], batchUserNotFirst: false, midTurnUserOnly: false }
  if (typeof originSeq !== 'number') return none
  const hi = rec !== undefined && typeof rec.firstAsstSeq === 'number'
    ? rec.firstAsstSeq
    : (typeof nextOriginSeq === 'number' ? nextOriginSeq : Infinity)
  const batch = r.userMsgs.filter((m) => typeof m.seq === 'number' && m.seq > originSeq && m.seq < hi)
  const near = batch.length > 0 ? batch[0] : undefined
  if (near === undefined) return { ...none, batch }
  const origin = near.kind === USER_KIND ? 'user' : 'machine'
  return {
    origin,
    batch,
    batchUserNotFirst: origin !== 'user' && batch.some((m) => m.kind === USER_KIND),
    midTurnUserOnly: origin !== 'user' && r.userMsgs.some((m) => m.kind === USER_KIND
      && typeof m.seq === 'number' && m.seq >= hi
      && m.seq < (typeof nextOriginSeq === 'number' ? nextOriginSeq : Infinity)),
  }
}

/**
 * 逐轮资格 + 计数（**唯一实现**，供门合规率与每会话常备读数两处共用）：
 * 返回 `{ rows, userOpened, machineOpened, unknownOrigin, machineOpenedActing }`。
 * 两处各算一遍 = pitfalls #12 那类副本病，所以只有这一个函数做分类。
 */
function turnQualification(r) {
  const turns = [...r.intentTurns.keys()].sort((a, b) => a - b)
  const out = { rows: [], userOpened: 0, machineOpened: 0, unknownOrigin: 0, machineOpenedActing: 0 }
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i]
    const nextOrigin = i + 1 < turns.length ? r.intentTurns.get(turns[i + 1]).originSeq : undefined
    const q = { turn: t, ...qualifyTurn(r, t, nextOrigin) }
    out.rows.push(q)
    if (q.origin === 'user') out.userOpened += 1
    else {
      out.machineOpened += 1
      if (q.origin === 'unknown') out.unknownOrigin += 1
      const rec = r.intentTurns.get(t)
      if (rec !== undefined && rec.acting === true) out.machineOpenedActing += 1
    }
  }
  return out
}

/** 开轮首发是 shell 侦察 —— 「门行 + 侦察同消息」在 ② 下必然不算前置（pitfalls #17）。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/**
 * 一轮的**诊断标签**（2026-09-17 复盘 P1）：原先只有一个 ✗，病因得靠人肉复现会话日志才知道。
 * `ok` / `ok-same-message` 都是**合规**（① 口径）；后者单独标出来，因为它是①与②的**唯一**分歧面，
 * 也是 pitfalls #17 里 shell 首发那一类的所在（`✓[同消息]`）。
 * 失败三种的标签不变：`✗[无门行]` / `✗[动后补]` / `✗[无法归因]`。
 */
function turnVerdict(rec) {
  if (rec === undefined || rec.acting !== true) return 'not-acting'
  if (rec.firstActCarrier === undefined) return 'unattributable'
  if (rec.declSeq === undefined) return 'no-marker'
  if (rec.declSeq === rec.firstActCarrier) return 'ok-same-message'
  if (rec.declSeq > rec.firstActCarrier) return 'after-action'
  return 'ok'
}

const CAUSE_LABEL = {
  'ok-same-message': '同消息', 'no-marker': '无门行', 'after-action': '动后补',
  unattributable: '无法归因', 'not-acting': '-',
}

/** 逐轮诊断标签：合规 = `✓`（同消息者标 `✓[同消息]`），失败 = `✗[成因]`（与 turnVerdict 同一份判据）。 */
function verdictLabel(rec) {
  const v = turnVerdict(rec)
  if (v === 'ok') return '✓'
  if (v === 'ok-same-message') return '✓[' + CAUSE_LABEL[v] + ']'
  return '✗[' + (CAUSE_LABEL[v] || v) + ']'
}

/**
 * 逐轮统计：① 存在口径（**每轮制对照读数**）+ 行为动作覆盖率 + ② 前置口径与两个文本口径（对照）
 * + 「门行与首动作同消息」的拆读数 + **轮次资格（user-opened turns）**。
 *
 * ① 与 ② 都由**同一批记录**、同一组判据函数（declared / declaredBefore）算出 —— 不复制分类器，
 * 否则两个读数会各自漂移（pitfalls #19 记的正是「同一个词有四个数」）。
 */
function intentGateStats(r) {
  const turns = [...r.intentTurns.keys()].sort((a, b) => a - b)
  // 轮次资格走**唯一实现**（turnQualification ⇒ qualifyTurn）：门合规率与常备读数不会各自漂移。
  const qual = turnQualification(r)
  const s = {
    turns, first: 0, reply: 0, anywhere: 0,
    eligible: 0, eligibleFirst: 0, eligibleDeclared: 0,
    contrastEligible: 0, sameMsg: 0, sameMsgShell: 0, sameMsgNonShell: 0,
    acts: 0, actsCovered: 0, actsUserOpened: 0, actsCoveredUserOpened: 0,
    // ── 轮次资格（2026-09-20）：分母换成 user-opened turns，其余只作观察 ──────
    userOpened: qual.userOpened, machineOpened: qual.machineOpened, unknownOrigin: qual.unknownOrigin,
    userOpenedEligible: 0, userOpenedDeclared: 0,
    machineOpenedActing: qual.machineOpenedActing,
    batchUserNotFirst: 0, midTurnUserOnly: 0,
    /** 逐轮资格（t → 'user' | 'machine' | 'unknown'）—— 逐轮打印与它同源，避免第二份判据。 */
    originByTurn: new Map(),
  }
  for (const row of qual.rows) {
    const t = row.turn
    const rec = r.intentTurns.get(t)
    s.originByTurn.set(t, row.origin)
    if (row.batchUserNotFirst) s.batchUserNotFirst += 1
    if (row.midTurnUserOnly) s.midTurnUserOnly += 1
    if (rec.first) s.first += 1
    if (rec.reply) s.reply += 1
    if (rec.any) s.anywhere += 1
    if (rec.acting) {
      s.eligible += 1
      if (row.origin === 'user') {
        // 新分母：user-opened **且会改变行为**的轮次；新分子：其中 ① 存在口径达标者。
        s.userOpenedEligible += 1
        if (declared(rec)) s.userOpenedDeclared += 1
      }
      if (rec.first) s.eligibleFirst += 1
      if (declared(rec)) s.eligibleDeclared += 1
      if (declaredBefore(rec)) s.contrastEligible += 1
      // 拆读数（pitfalls #17）：**① 合规**且门行与首个动作同处一条消息的轮次里，首发是不是 shell 侦察。
      // 「① 合规」这个前置条件不能省 —— 它才是与上方诊断行（「门行与首动作同消息」）对齐的口径；
      // 少了它，声明落在首次动手**之后**的轮次（`declSeq === firstActCarrier` 对它们也成立）会被多算进来。
      if (declared(rec) && rec.declSeq === rec.firstActCarrier) {
        s.sameMsg += 1
        if (rec.firstActName !== undefined && SHELL_TOOLS.has(rec.firstActName)) s.sameMsgShell += 1
        else s.sameMsgNonShell += 1
      }
      // 覆盖率是**连续读数**：声称要做的动作里，有多少条消息在「声明已经存在」之后。
      // 起算点与合规判据同源：① 合规（含同消息）时声明所在消息**就是**起算点（`carrier >= declSeq`）；
      // 不合规（声明落在首次动手之后）时，声明所在那条消息本身也不算被覆盖（`carrier > declSeq`）——
      // 那是历史口径，保住与 2026-09-16 基线的可比性。declSeq 缺失 ⇒ 一个都不覆盖。
      const coverFrom = rec.declSeq === undefined ? undefined : (declared(rec) ? rec.declSeq : rec.declSeq + 1)
      for (const carrier of rec.carriers) {
        s.acts += 1
        if (coverFrom !== undefined && carrier >= coverFrom) s.actsCovered += 1
        // 与轮次资格同源：机器开轮的轮次不要求门行（pitfalls #19 v4），它们的动作也就不该进
        // 现役覆盖率的分母；全轮次的口径仍保留为对照读数。
        if (row.origin === 'user') {
          s.actsUserOpened += 1
          if (coverFrom !== undefined && carrier >= coverFrom) s.actsCoveredUserOpened += 1
        }
      }
    }
  }
  return s
}

/**
 * 逐轮资格 + 三行聚合读数（会话级与合计级**共用**同一份渲染，避免两处格式字面量各自漂移）。
 * 第 1 行是**现役口径**（分母 = user-opened turns，分子 = ① 存在）；第 2 行是**每轮制旧读数**
 * （全部保留，标明对照）；第 3 行是资格构成与两个观察项；第 4 行是原有的同消息拆读数。
 */
function gateLines(s, labelPrefix, indent) {
  const lines = []
  // 会话级 `s.turns` 是轮次数组、合计级是轮次数 —— 这里归一，免得合计行印出 `undefined`。
  const turnCount = Array.isArray(s.turns) ? s.turns.length : s.turns
  lines.push(indent + labelPrefix + '意图门合规率（' + USER_OPENED_SCOPE + ' 口径，① 存在分子）: '
    + s.userOpenedDeclared + '/' + s.userOpenedEligible + ' (' + rate(s.userOpenedDeclared, s.userOpenedEligible) + ')'
    + ' | 行为动作覆盖（user-opened 轮）: ' + s.actsCoveredUserOpened + '/' + s.actsUserOpened
    + ' (' + rate(s.actsCoveredUserOpened, s.actsUserOpened) + ') ｜ 每轮制对照 ' + s.actsCovered + '/' + s.acts)
  lines.push(indent + '对照口径（每轮制，旧读数）: ① 存在 ' + s.eligibleDeclared + '/' + s.eligible
    + ' (' + rate(s.eligibleDeclared, s.eligible) + ') | ② 前置 ' + s.contrastEligible + '/' + s.eligible
    + ' | 可见回复 ' + s.reply + ' | 任意文本 ' + s.anywhere)
  lines.push(indent + '轮次资格（按 seq 反推）: 总 ' + turnCount + ' 轮 = user-opened ' + s.userOpened
    + ' + 机器开轮 ' + s.machineOpened + '；其中机器开轮里**动了手** ' + s.machineOpenedActing
    + ' 轮（观察项，不进分子分母）；无法按 seq 归轮 ' + s.unknownOrigin + ' 轮；'
    + '批内 user 非首条 ' + s.batchUserNotFirst + ' / 轮内才出现真用户消息 ' + s.midTurnUserOnly)
  lines.push(indent + '其中「同消息」达标 ' + s.sameMsg + ' 轮：首发是 shell 侦察 ' + s.sameMsgShell + ' 轮 / 非 shell '
    + s.sameMsgNonShell + ' 轮（pitfalls #17：门行与侦察同处一条消息，在 ② 下必然不算前置）')
  return lines
}

/**
 * **每会话常备读数**（2026-09-20 新增，与门合规率无关、任何会话都打印）：
 *   ① `user/message` 通道构成 —— 总条数 / 真用户 / 机器，外加**实际见到的 kind 取值表**
 *      与解析走的 source 路径计数（判据字面位置 vs 落盘形状，漏兜底会让「全判机器开轮」静默发生）；
 *   ② token **四桶** —— 折叠语义照抄 pitfalls #22②（计入 `assistant/message`，同一 `(turn, step)`
 *      **替换**取最后一条）；`assistant/attempt` 带 usage 时**单独报告**、不并入四桶，并打印
 *      `llm/retry-started` 次数说明重试口径。
 *   ⚠️ 只报 token 桶，**不报成本**（框架无价目表，pitfalls #22）；也**不跨会话汇总**
 *   （seeded 会话是父事件的深拷贝，相加会把父的用量算第二遍，#22③）。
 */
function channelLines(r, indent) {
  const lines = []
  const total = r.userMsgs.length
  const real = r.userKindCounts.get(String(USER_KIND)) || 0
  const table = [...r.userKindCounts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([k, n]) => k + ' ' + n).join(' / ')
  lines.push(indent + 'user/message 通道构成: 总 ' + total + ' 条 = 真用户(kind=user) ' + real
    + ' + 机器 ' + (total - real) + (total === 0 ? '' : '（机器占 ' + rate(total - real, total) + '）'))
  // 轮次那一半（与门合规率**同一份**资格实现 turnQualification，不是第二份判据）。
  const q = turnQualification(r)
  lines.push(indent + '  开轮归属（按 seq 反推，共 ' + q.rows.length + ' 轮）: user-opened ' + q.userOpened
    + ' 轮 / 机器开轮 ' + q.machineOpened + ' 轮（其中动手 ' + q.machineOpenedActing + ' 轮）/ 无法归轮 ' + q.unknownOrigin + ' 轮')
  lines.push(indent + '  kind 取值表（实际见到的全部取值）: ' + (table || '（无）'))
  lines.push(indent + '  source 路径: data.message.source ' + r.userSourcePaths.message
    + ' / data.source ' + r.userSourcePaths.data + ' / 无 ' + r.userSourcePaths.none)
  const { totals, attempts } = usageTotals(r)
  const billableIn = totals.uncachedInput + totals.cacheRead + totals.cacheWrite
  lines.push(indent + 'token 四桶（assistant/message，同 (turn,step) 替换取最后一条）: uncachedInput ' + num(totals.uncachedInput)
    + ' / output ' + num(totals.output) + ' / cacheRead ' + num(totals.cacheRead) + ' / cacheWrite ' + num(totals.cacheWrite)
    + '（计费输入 = 前三桶之和 ' + num(billableIn) + '；' + r.usage.samples + ' 条带 usage 的 step / ' + r.usage.bySlot.size + ' 个 (turn,step) 槽）')
  lines.push(indent + '  assistant/attempt: ' + r.usage.attemptsSeen + ' 条，其中带 usage ' + r.usage.attempts.length
    + ' 条' + (r.usage.attempts.length > 0
      ? '（四桶 ' + num(attempts.uncachedInput) + '/' + num(attempts.output) + '/' + num(attempts.cacheRead) + '/' + num(attempts.cacheWrite) + '）'
      : '') + ' —— **单独报告、未并入四桶**；llm/retry-started ' + r.usage.retries
    + ' 次（框架口径：retry 关闭替换槽 ⇒ 重试的那一次要**加**，#22②；本脚本只折叠 assistant/message，'
    + '不替框架做那次加法）。只报 token 桶，不报成本（框架无价目表）')
  return lines
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

// ── 轮次资格 / token 折叠的自测（2026-09-20） ────────────────────────────────
//
// 两条新读数都有「合成日志才能证明」的分支：user-opened 的判据按 seq 反推（真机健康会话里
// `batchUserNotFirst` 恒为 0），token 折叠的替换语义（同 (turn,step) 取最后一条）在真机上
// 实测无重复槽 ⇒ 也证不了。所以两条都落成 fixture、断言进 PASS/FAIL（同 attributionSelfTest 的取舍）。

const USER_OPENED_FIXTURE = path.join(__dirname, 'fixtures', 'user-opened-cases.json')
const TOKEN_FIXTURE = path.join(__dirname, 'fixtures', 'token-cases.json')

/** 每条 case 的 `expect` 键集必须**恰好**等于这个列表 —— 漏写一个维度 = 这条 case 静默不测它。 */
const USER_OPENED_EXPECT_KEYS = ['userOpened', 'machineOpened', 'unknownOrigin', 'userOpenedEligible',
  'userOpenedDeclared', 'machineOpenedActing', 'batchUserNotFirst', 'midTurnUserOnly',
  'eligible', 'eligibleDeclared']
const TOKEN_EXPECT_KEYS = ['uncachedInput', 'output', 'cacheRead', 'cacheWrite', 'attemptUncachedInput',
  'attemptOutput', 'attemptCacheRead', 'attemptCacheWrite', 'samples', 'slots', 'attemptsSeen',
  'attemptsWithUsage', 'retries']

/** fixture 的通用跑法：解析 → 逐 case 取「实得」→ 与 `expect` 逐键比对（键集不齐即 FAIL）。 */
function runFixtureCases(file, keys, gotOf) {
  let spec
  try { spec = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    return [{ name: 'fixture ' + path.basename(file) + ' 可读', ok: false, detail: '读/解析失败：' + (e && e.message) }]
  }
  const cases = Array.isArray(spec.cases) ? spec.cases : []
  if (cases.length === 0) return [{ name: 'fixture ' + path.basename(file) + ' 至少含一条 case', ok: false, detail: 'cases 为空' }]
  return cases.map((c) => {
    const raw = (c.events || []).map((e) => JSON.stringify(e)).join('\n')
    const got = gotOf(analyze(raw))
    const want = c.expect || {}
    const wantKeys = Object.keys(want).sort().join(',')
    if (wantKeys !== [...keys].sort().join(',')) {
      return { name: c.name, ok: false, detail: '断言维度不齐：应为 ' + [...keys].sort().join(',') + '，实得 ' + (wantKeys || '（空）') }
    }
    const bad = keys.filter((k) => got[k] !== want[k])
    return {
      name: c.name,
      ok: bad.length === 0,
      detail: bad.length === 0 ? '' : bad.map((k) => k + ' 期望 ' + JSON.stringify(want[k]) + ' 实得 ' + JSON.stringify(got[k])).join('；'),
    }
  })
}

/** 轮次资格（user-opened turns）的 fixture 自测 —— 新分母/新分子的阳性与阴性路径。 */
function userOpenedSelfTest() {
  return runFixtureCases(USER_OPENED_FIXTURE, USER_OPENED_EXPECT_KEYS, (r) => {
    const s = intentGateStats(r)
    return {
      userOpened: s.userOpened, machineOpened: s.machineOpened, unknownOrigin: s.unknownOrigin,
      userOpenedEligible: s.userOpenedEligible, userOpenedDeclared: s.userOpenedDeclared,
      machineOpenedActing: s.machineOpenedActing,
      batchUserNotFirst: s.batchUserNotFirst, midTurnUserOnly: s.midTurnUserOnly,
      eligible: s.eligible, eligibleDeclared: s.eligibleDeclared,
    }
  })
}

/** token 四桶折叠的 fixture 自测 —— 同 `(turn,step)` 替换、attempt 单列、缺桶按 0。 */
function tokenFoldingSelfTest() {
  return runFixtureCases(TOKEN_FIXTURE, TOKEN_EXPECT_KEYS, (r) => {
    const { totals, attempts } = usageTotals(r)
    return {
      ...totals,
      attemptUncachedInput: attempts.uncachedInput, attemptOutput: attempts.output,
      attemptCacheRead: attempts.cacheRead, attemptCacheWrite: attempts.cacheWrite,
      samples: r.usage.samples, slots: r.usage.bySlot.size,
      attemptsSeen: r.usage.attemptsSeen, attemptsWithUsage: r.usage.attempts.length,
      retries: r.usage.retries,
    }
  })
}

/**
 * 轮次资格**口径**的跨文件守卫（同 behaviorToolsSelfTest 的形状）：persona 把义务写死成
 * `user-opened turns`，本脚本用同一串字面量给分母命名。两处漂移不会报错、只会让读数变形
 * （pitfalls #19：「同一个词有四个数」）⇒ 逐字比对，并用内存变异证明它有牙。
 * 对照自身也必须能失败：变异没生效 ⇒ 这条对照自己 FAIL（pitfalls #21 第二条）。
 */
function userOpenedScopeSelfTest() {
  let text
  try { text = fs.readFileSync(PERSONA_FILE, 'utf8') } catch (e) {
    return [{ name: '读 persona（' + PERSONA_FILE + '）', ok: false, detail: String((e && e.message) || e) }]
  }
  /** 找出「persona 文本里有没有 expected 这个口径字面量」；解析不出来 = 响亮失败，不当成通过。 */
  const finding = (personaText, expected) => {
    if (typeof personaText !== 'string' || personaText === '') return 'persona 文本为空/读不到'
    if (!personaText.includes(expected)) {
      return 'persona 里找不到字面量 ' + JSON.stringify(expected) + ' —— 口径改名了？persona 与本脚本必须同口径'
    }
    return ''
  }
  const out = []
  const bad = finding(text, USER_OPENED_SCOPE)
  out.push({
    name: 'persona 写死字面量 ' + JSON.stringify(USER_OPENED_SCOPE) + '，本脚本用同一串给分母命名',
    ok: bad === '',
    detail: bad,
  })
  const control = (label, personaText, expected) => {
    const detail = finding(personaText, expected)
    out.push({ name: label, ok: detail !== '', detail: detail === '' ? '没报差异 —— 断言空转' : detail })
  }
  const renamed = text.split(USER_OPENED_SCOPE).join('per-turn scope')
  if (renamed === text) out.push({ name: '对照①：persona 给口径改名 ⇒ 报告漂移', ok: false, detail: '对照组本身失效：变异目标文本不存在' })
  else control('对照①：persona 给口径改名 ⇒ 报告漂移', renamed, USER_OPENED_SCOPE)
  const removed = text.split(USER_OPENED_SCOPE).join('')
  if (removed === text) out.push({ name: '对照②：persona 里口径字面量整块消失 ⇒ 报告漂移', ok: false, detail: '对照组本身失效：变异目标文本不存在' })
  else control('对照②：persona 里口径字面量整块消失 ⇒ 报告漂移', removed, USER_OPENED_SCOPE)
  // 对照③ 走**本脚本那一侧**：把期望字面量改成另一个词（等价于脚本常量漂移）⇒ 同一份 persona 立刻对不上。
  control('对照③：本脚本的口径常量换成另一个词 ⇒ 报告漂移', text, 'per-turn turns')
  return out
}

// ── 角色事实静态检查（ADR 0002 的 E 项） ─────────────────────────────────────
//
// 单一源 = preset 的 yml。这里只做**比对**：不生成 EXPECTED、不动挂载路径、不参与运行时判定。
const PRESET_YML = path.join(__dirname, '..', 'preset', 'ptc-roles', 'agent.cordis.yml')
const WATCHDOG_PLUGIN = path.join(__dirname, '..', 'preset', 'ptc-roles', 'intent-gate-watchdog.mjs')

/** 抽 `NAME = new Set([ … ])` 里的字符串字面量（按出现顺序）；解析不出返回 undefined（**响亮**，不当成空集）。 */
function arrayStrings(text, name) {
  const marker = name + ' = new Set(['
  const start = text.indexOf(marker)
  if (start < 0) return undefined
  const open = start + marker.length
  const close = text.indexOf('])', open)
  if (close < 0) return undefined
  const out = []
  const re = /'([^']*)'|"([^"]*)"/g
  let m
  while ((m = re.exec(text.slice(open, close))) !== null) out.push(m[1] !== undefined ? m[1] : m[2])
  return out.length > 0 ? out : undefined
}

/**
 * BEHAVIOR_TOOLS 的跨文件守卫（2026-09-17 评审 M5）。
 * 这个名单**同时**决定插件「要不要提醒」与本脚本「合规率分母」：漂移不会报错，只会让读数变形，
 * 而 pitfalls #19 记的恰恰是「同一个词有四个数、没人能从数字反推病因」。姊妹事实 resolveDepth 的
 * 两份复本有 verify-harness-contract.cjs 的逐字断言，这个名单此前**没有任何守卫** —— 实测把任一侧
 * 加一个假工具名，三支脚本全绿。判据同 roleFacts：解析不出即 FAIL，并带内存变异对照。
 */
function behaviorToolsSelfTest() {
  let pluginText
  try { pluginText = fs.readFileSync(WATCHDOG_PLUGIN, 'utf8') }
  catch (err) { return [{ name: '读插件源码（' + WATCHDOG_PLUGIN + '）', ok: false, detail: String(err && err.message || err) }] }

  const mine = [...BEHAVIOR_TOOLS]
  const compare = (theirs) => {
    if (theirs === undefined) return '解析不出 ' + WATCHDOG_PLUGIN + ' 里的 BEHAVIOR_TOOLS 字面量（写法变了？）'
    if (theirs.length !== mine.length) return '条数不同：插件 ' + theirs.length + ' / 本脚本 ' + mine.length
    const at = mine.findIndex((tool, i) => theirs[i] !== tool)
    if (at >= 0) return '第 ' + (at + 1) + ' 项不同：插件 ' + JSON.stringify(theirs[at]) + ' / 本脚本 ' + JSON.stringify(mine[at])
    return ''
  }

  const out = []
  const bad = compare(arrayStrings(pluginText, 'const BEHAVIOR_TOOLS'))
  out.push({
    name: '插件的 BEHAVIOR_TOOLS 与本脚本逐字一致（顺序也一致）',
    ok: bad === '',
    detail: bad === '' ? '' : bad + ' —— 两处必须同口径（踩过：2026-09-16「任意位置」vs「首行」）',
  })

  const mutated = pluginText.replace("'ask_user_question',", "'zzz_control_tool',")
  if (mutated === pluginText) out.push({ name: '对照①：插件换掉一个工具名 ⇒ 报告名单漂移', ok: false, detail: '对照组本身失效：变异目标文本不存在' })
  else {
    const detail = compare(arrayStrings(mutated, 'const BEHAVIOR_TOOLS'))
    // 基础世界已经漂移时（上面那条已经红），「换一个名字」的差异会被条数差异抢先命中 ——
    // 此时只要**报告了差异**就算这条对照成立；基础世界干净时仍要求点名那个假名字。
    out.push({
      name: '对照①：插件换掉一个工具名 ⇒ 报告名单漂移',
      ok: detail !== '' && (detail.includes('zzz_control_tool') || bad !== ''),
      detail: detail === '' ? '没报差异 —— 断言空转' : detail,
    })
  }

  const removed = pluginText.replace(/const BEHAVIOR_TOOLS = new Set\(\[[\s\S]*?\n\]\)\n/, '')
  if (removed === pluginText) out.push({ name: '对照②：插件的名单整块消失 ⇒ 报告解析失败', ok: false, detail: '对照组本身失效：变异目标文本不存在' })
  else {
    const detail = compare(arrayStrings(removed, 'const BEHAVIOR_TOOLS'))
    out.push({ name: '对照②：插件的名单整块消失 ⇒ 报告解析失败', ok: detail !== '', detail: detail === '' ? '没报差异 —— 空 vs 空被判成了「一致」' : detail })
  }
  return out
}
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
 *
 * 每条 case 同时钉**两个口径**：`eligibleDeclared`（① 存在，合规分子）与 `contrastEligible`（② 前置，对照）。
 * 两者相等只说明 case 没落在①与②的分歧面上；「门行与首动作同消息」那两条正是分歧点（①=1 / ②=0），
 * 它们在 fixture 里**必须同时**被断言 —— 否则「② 只是对照读数」这句话就没有可执行的定义
 * （而 ② 的分母与 ① 共用 eligible，不另设字段）。
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
    const ok = s.eligible === want.eligible && s.eligibleDeclared === want.eligibleDeclared
      && s.contrastEligible === want.contrastEligible
      && s.acts === want.acts && s.actsCovered === want.actsCovered && silent === want.silent
      // 新的一对只在夹具显式给出时期望（其余 case 不因它变红）。
      && (want.actsUserOpened === undefined
        || (s.actsUserOpened === want.actsUserOpened && s.actsCoveredUserOpened === want.actsCoveredUserOpened))
    return { name: c.name, ok, detail: '期望 ' + JSON.stringify(want) + '，实得 eligible=' + s.eligible
      + ' eligibleDeclared=' + s.eligibleDeclared + ' contrastEligible=' + s.contrastEligible
      + ' acts=' + s.acts + ' actsCovered=' + s.actsCovered + ' actsUserOpened=' + s.actsUserOpened
      + ' actsCoveredUserOpened=' + s.actsCoveredUserOpened + ' silent=' + silent }
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
  const cwdFlag = args.indexOf('--cwd')
  const sessionsFlag = args.indexOf('--sessions')
  if (sessionsFlag >= 0 && args[sessionsFlag + 1] !== undefined) {
    SESSIONS_ROOT = path.resolve(args[sessionsFlag + 1])
  } else if (CONTROL_SESSIONS) {
    SESSIONS_ROOT = path.join(__dirname, 'fixtures', 'sessions-ci')
  }
  const projectCwd = cwdFlag >= 0 && args[cwdFlag + 1] !== undefined
    ? path.resolve(args[cwdFlag + 1])
    : (CONTROL_SESSIONS ? FIXTURE_CWD : DEFAULT_PROJECT_CWD)
  const rawOut = args.includes('--raw')
  let pass = 0, fail = 0, warn = 0, escChild = 0, escRoot = 0, escOther = 0
  /** 失败**名字**清单 —— `--control-sessions` 的判据是它与 REQUIRED_FIXTURE_FAILURES 集合相等。 */
  const failedNames = []
  const failLine = (name, text) => { failedNames.push(name); fail += 1; console.log(text) }
  let silentSessions = 0     // 单场「门行整场静默」的会话数（每轮制对照；观察项，不接退出码 —— pitfalls #19）
  let silentUserOpenedSessions = 0  // 同上，**user-opened 口径**（现役分母）
  const gate = { turns: 0, first: 0, reply: 0, anywhere: 0, eligible: 0, eligibleFirst: 0, eligibleDeclared: 0,
    contrastEligible: 0, sameMsg: 0, sameMsgShell: 0, sameMsgNonShell: 0, acts: 0, actsCovered: 0,
  actsUserOpened: 0, actsCoveredUserOpened: 0, sessions: 0,
    userOpened: 0, machineOpened: 0, unknownOrigin: 0, userOpenedEligible: 0, userOpenedDeclared: 0,
    machineOpenedActing: 0, batchUserNotFirst: 0, midTurnUserOnly: 0 }
  /** 进了上面的合计的那些轮次记录 —— 下方成因分类 / 拆读数必须只看这一批，否则与合计行对不上。 */
  const gatedRecs = []

  // 角色事实静态检查**先跑**，且不因「没有会话」被跳过 —— 它只读仓库文件（ADR 0002 的 E 项）。
  console.log('角色事实静态检查（E —— 单一源 = preset/ptc-roles/agent.cordis.yml；比对 yml / EXPECTED / README 角色表）:')
  for (const t of roleFactsSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { failLine(t.name, '   ✗ FAIL ' + t.name + '（' + t.detail + '）') }
  }

  // 判据侧的一致性也是**静态**的：插件「要不要提醒」与本脚本「合规率分母」共用同一份
  // BEHAVIOR_TOOLS，此前没有任何守卫（见 behaviorToolsSelfTest 的注释）。
  console.log('\n行为工具名单一致性（插件 intent-gate-watchdog.mjs ↔ 本脚本，逐字 + 顺序）:')
  for (const t of behaviorToolsSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { failLine(t.name, '   ✗ FAIL ' + t.name + '（' + t.detail + '）') }
  }

  // 同一形状的守卫，守的是**轮次资格口径**：persona 的义务字面量 ↔ 本脚本的分母命名
  // （`user-opened turns`）。口径漂移不会报错、只会让读数变形，所以必须逐字比对（pitfalls #19）。
  console.log('\n轮次资格口径一致性（persona personas/orchestrator.md ↔ 本脚本，字面量 ' + JSON.stringify(USER_OPENED_SCOPE) + '）:')
  for (const t of userOpenedScopeSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { failLine(t.name, '   ✗ FAIL ' + t.name + '（' + t.detail + '）') }
  }

  // 两支 fixture 自测与「本机有没有会话」无关 ⇒ 提到任何 return **之前**（2026-09-17 评审 M2/F-3：
  // 原先它们排在会话扫描之后，于是没有会话的机器会整段跳过它们，而脚本仍退 0 报「符合预期」）。
  console.log('\n归因计数器自测（合成日志 fixture scripts/fixtures/attribution-cases.json —— R-02 的阳性路径）:')
  for (const t of attributionSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { failLine(t.name, '   ✗ FAIL ' + t.name + '（' + t.detail + '）') }
  }
  console.log('\n意图门统计自测（合成日志 fixture scripts/fixtures/intent-gate-cases.json —— C 项的阳性路径）:')
  for (const t of gateSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { failLine(t.name, '   ✗ FAIL ' + t.name + '（' + t.detail + '）') }
  }
  console.log('\n轮次资格自测（合成日志 fixture scripts/fixtures/user-opened-cases.json —— 新分母的阳性/阴性路径）:')
  for (const t of userOpenedSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { failLine(t.name, '   ✗ FAIL ' + t.name + '（' + t.detail + '）') }
  }
  console.log('\ntoken 折叠自测（合成日志 fixture scripts/fixtures/token-cases.json —— 同一 (turn,step) 的替换语义）:')
  for (const t of tokenFoldingSelfTest()) {
    if (t.ok) { console.log('   ✓ ' + t.name); pass += 1 }
    else { failLine(t.name, '   ✗ FAIL ' + t.name + '（' + t.detail + '）') }
  }

  const files = findSessionFiles()
  if (files.length === 0) {
    console.log('\n! 行为判据**本次未验证**：没找到任何会话文件（' + SESSIONS_ROOT + '）—— 上面的静态检查与 fixture 自测仍有效')
    console.log('汇总: ✓' + pass + '  ✗' + fail + '  !' + warn)
    process.exitCode = fail === 0 ? 0 : 1
    return
  }
  if (files.some((f) => f.endsWith('.zstd')) && !zstdAvailable()) {
    // 响亮而不是静默跳过：解不开会话时，行为判据一条都没跑 —— 退 0 等于把「没验证」说成「符合预期」。
    console.log('\n✗ FAIL 找不到 zstd —— 有 ' + files.length + ' 个会话文件却一个都解不开：行为判据**本次未验证**。')
    console.log('  ⇒ 装上 zstd（或让它进 PATH）后重跑；本脚本拒绝在这种状态下报「符合预期」（2026-09-17 评审 M2/F-4）。')
    process.exitCode = 2
    return
  }

  const seen = new Map()
  let skipped = 0
  for (const file of files) {
    const raw = decode(file)
    if (raw === undefined) { skipped += 1; continue }
    const a = analyze(raw)
    if (!a.header) continue
    if (!all && !sameCwd(a.header.cwd, projectCwd)) continue
    const id = String(a.header.id)
    const prev = seen.get(id)
    if (!prev || raw.length > prev.raw.length) seen.set(id, { file, raw, ...a })
  }
  if (seen.size === 0) {
    console.log('\n! 行为判据**本次未验证**：本工作区（' + (all ? 'ALL' : projectCwd) + '）下没有会话 —— ')
    console.log('  换过机器 / 换过 clone 路径时用 `--cwd <path>` 指定工作区，或 `--all` 扫全部工作区')
    console.log('汇总: ✓' + pass + '  ✗' + fail + '  !' + warn)
    process.exitCode = fail === 0 ? 0 : 1
    return
  }

  const rows = [...seen.values()].sort((x, y) => (x.header.createdAt || 0) - (y.header.createdAt || 0))
  console.log('\n会话 ' + rows.length + ' 个（工作区 ' + (all ? 'ALL' : projectCwd) + '），跳过错文件 ' + skipped + '\n')
  if (decodeFailures.other > 0) {
    console.log('! 有 ' + decodeFailures.other + ' 个会话文件解不开（非 zstd 缺失 ⇒ 损坏或超 maxBuffer）—— 它们不在本次判据里')
    warn += 1
  }

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
    // 每会话常备读数（与门合规率无关、任何非跳过会话都打印）：user 通道构成 + token 四桶。
    // 角色子代理也打印 —— 那正是 ADR 0002 B 项（每角色用量归因）读盘的那一格。
    // ⚠️ 只报 token 桶，不报成本；且不跨会话汇总（seeded 会重复计父，pitfalls #22③）。
    for (const line of channelLines(r, '   ')) console.log(line)

    if (depth === 0) {
      // 主 agent 丢掉 PTC 与 :670 的「子代理仍是 PTC」是同一枚硬币的两面 —— 都是底座
      // tool-presentation 行坏掉的信号，因此同样进 fail、接退出码（2026-09-17 评审 M7：原先
      // 只打 `!`，而下面的注释把 `!` 明确限定为**合法**的已知现象，它不在那个清单里）。
      // 这里只对 isPresetRoot 的主会话生效（非 ptc-roles 主会话在上面就 continue 了）。
      if (r.ptc) { console.log('   ✓ 主 agent 保持 PTC（预期）'); pass += 1 }
      else { failLine('主 agent 不是 PTC', '   ✗ FAIL 主 agent 不是 PTC —— 检查底座 tool-presentation 行') }
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
          gate.eligibleDeclared += g.eligibleDeclared; gate.acts += g.acts; gate.actsCovered += g.actsCovered
      gate.actsUserOpened += g.actsUserOpened; gate.actsCoveredUserOpened += g.actsCoveredUserOpened
          gate.contrastEligible += g.contrastEligible
          gate.sameMsg += g.sameMsg; gate.sameMsgShell += g.sameMsgShell; gate.sameMsgNonShell += g.sameMsgNonShell
          gate.userOpened += g.userOpened; gate.machineOpened += g.machineOpened
          gate.unknownOrigin += g.unknownOrigin; gate.userOpenedEligible += g.userOpenedEligible
          gate.userOpenedDeclared += g.userOpenedDeclared
          gate.machineOpenedActing += g.machineOpenedActing
          gate.batchUserNotFirst += g.batchUserNotFirst; gate.midTurnUserOnly += g.midTurnUserOnly
          for (const t of g.turns) {
            const rec = r.intentTurns.get(t)
            if (rec !== undefined && rec.acting === true) gatedRecs.push(rec)
          }
          for (const line of gateLines(g, '', '   ')) console.log(line)
          console.log('   逐轮（资格 + ① 存在口径）: ' + g.turns.map((t) => 'T' + t
            + (g.originByTurn.get(t) === 'user' ? '[user]' : g.originByTurn.get(t) === 'unknown' ? '[?]' : '[机器]')
            + verdictLabel(r.intentTurns.get(t))).join(' ')
            + ' | 会改变行为: ' + (g.turns.filter((t) => r.intentTurns.get(t).acting).map((t) => 'T' + t).join(' ') || '无'))
          // C（ADR 0002）：总量里的一个「0%」会被平均掉，所以要**按会话**点名「整场静默」——
          // 那是「旗舰机制静默死」唯一的可见形态。它是**观察项**：模型行为不该让套件随机变红（pitfalls #19）。
          // 两口径都点名：每轮制（旧对照）与 user-opened（现役分母）。
          if (gateSilent(g)) {
            silentSessions += 1
            console.log('   ! 本场门行**整场静默（每轮制对照）**：会改变行为 ' + g.eligible + ' 轮、① 存在口径命中 0 —— 见 ADR 0002「旗舰行为机制可以整场静默失效」')
            console.log('     （观察项，不接退出码；要判定是「模型没写」还是「口径把只读轮算进去了」，看上面的逐轮与会改变行为两行）')
          }
          if (gateSilentUserOpened(g)) {
            silentUserOpenedSessions += 1
            console.log('   ! 本场门行**整场静默（' + USER_OPENED_SCOPE + ' 口径，现役分母）**：该欠行的轮次 ' + g.userOpenedEligible + '、① 存在口径命中 0')
          }
        }
      }
      console.log('   工具面: ' + (rawOut ? tools.join(', ') : tools.slice(0, 8).join(', ') + (tools.length > 8 ? ' …' : '')))
      continue
    }
    if (r.ptc) { failLine('子代理仍是 PTC', '   ✗ FAIL 子代理仍是 PTC：run_code 逃逸还在，白名单不是硬边界'); continue }
    if (!r.role) { console.log('   ! WARN 认不出角色（persona 没注入？）'); warn += 1; continue }
    const want = EXPECTED[r.role]
    if (!want) { console.log('   ! WARN 没有 ' + r.role + ' 的期望白名单（新角色没登记进 EXPECTED？）'); warn += 1; continue }
    const d = compare(tools, want)
    const note = d.known.length > 0 ? ' | ⊘ 已知自身层泄漏（非白名单问题）: ' + d.known.join(', ') : ''
    if (d.extra.length === 0 && d.missing.length === 0) { console.log('   ✓ PASS native + 白名单精确匹配（' + want.length + ' 项）' + note); pass += 1 }
    else { failLine('角色白名单不符', '   ✗ FAIL 白名单不符 | 多出: ' + (d.extra.join(', ') || '无') + ' | 缺失: ' + (d.missing.join(', ') || '无') + note) }
    if (rawOut) console.log('   工具面: ' + tools.join(', '))
  }
  if (gate.turns > 0) {
    console.log('\n意图门合规率（合计 ' + gate.sessions + ' 个主 agent 会话 / ' + gate.turns + ' 轮，其中会改变行为 ' + gate.eligible + ' 轮）')
    for (const line of gateLines(gate, '', '  ')) console.log(line)
    {
      // 成因分类（P1）：分子只有一个数时，「同消息（仍合规，只是没抢在动作前）/ 整轮没写 / 动后补」三者的处置完全不同。
      // 只统计**进了上面那个合计**的会话（gatedRecs）—— 先前这里遍历的是**全部** rows，
      // 于是它会把被跳过 / 早于 PERSONA_V2_SINCE 的会话一起数进来，与合计行对不上（实测 23 vs 16）。
      const causes = { 'ok-same-message': 0, 'no-marker': 0, 'after-action': 0, unattributable: 0 }
      let shellFirst = 0        // 首发动作是 shell 的轮次（含**合规**的那些）
      let shellSameMessage = 0  // 其中属于「门行与它同一条消息」的 —— ① 合规、② 不算前置
      for (const rec of gatedRecs) {
        const v = turnVerdict(rec)
        if (causes[v] !== undefined) causes[v] += 1
        if (rec.firstActName !== undefined && SHELL_TOOLS.has(rec.firstActName)) {
          shellFirst += 1
          if (v === 'ok-same-message') shellSameMessage += 1
        }
      }
      console.log('  合规轮里的诊断: 门行与首动作同消息 ' + causes['ok-same-message'] + ' 轮（① 算合规、② 不算前置）'
        + ' / 整轮无门行 ' + causes['no-marker'] + ' / 门行在动作之后 ' + causes['after-action']
        + ' / 无法归因 ' + causes['unattributable'])
      console.log('  其中「同一条消息」那类里，首发动作是 shell 侦察（bash/pwsh）的 ' + shellSameMessage + ' 轮'
        + ' —— 在 ② 口径下必然不算前置，属口径产物而非模型漏行（pitfalls #17 的载体耦合）；'
        + '本窗口首发为 shell 的轮次共 ' + shellFirst + ' 轮')
    }
    console.log('  整场静默的会话（每轮制对照）: ' + silentSessions + '/' + gate.sessions
      + ' | ' + USER_OPENED_SCOPE + ' 口径: ' + silentUserOpenedSessions + '/' + gate.sessions
      + '（观察项，不进 ✓/✗/! 的账 —— 模型行为不该让套件随机变红，见 pitfalls #19）')
    console.log('  口径: **分母 = ' + USER_OPENED_SCOPE + '**（该轮起点被 claim 的那批 `user/message` 里最近于轮起点的那一条、'
      + '按 seq 反推，其 source.kind === \'user\' ⇒ user-opened；其余 kind 一律算机器开轮），分子 = ① 存在'
      + '（门行所在消息的序号 ≤ 承载首个行为动作的载体消息序号，同一条消息算数，pitfalls #19/#20），'
      + '分子分母都只算**会改变行为**的轮次（要委派 / 要拒绝 / 要提问 / 要改文件），行为判据 = tool/call 或 '
      + 'tool/ptc-dispatch 的 name 命中 BEHAVIOR_TOOLS（与 intent-gate-watchdog.mjs 同口径）；'
      + 'marker = ' + JSON.stringify(INTENT_MARKERS) + '（与插件的 DEFAULT_MARKERS 同口径）。')
    console.log('  对照读数（全部保留，不接分子分母）: 每轮制的 ① 存在 / ② 前置（declSeq < firstActCarrier）/ 可见回复 / 任意文本；'
      + '机器开轮的数量与其中动手的轮数只作观察项。「任意文本」含工具结果与工具参数 ⇒ 读过插件源码的轮次也会命中，那不是合规。')
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
    failedNames.push('不可归属的 tool/ptc-dispatch')
    fail += 1
  } else {
    console.log('不可归属的 tool/ptc-dispatch: 0（归因路径健康）')
  }
  // 归因计数 / 意图门统计的**阳性路径**由 fixture 自测覆盖 —— 它们与会话库无关，已在上面
  // （任何 return 之前）跑过。见 2026-09-17 评审 M2/F-3。
  console.log('\n汇总: ✓' + pass + '  ✗' + fail + '  !' + warn)
  console.log('提权请求（实测计数）: ptc-roles 主 agent ' + escRoot + ' / ptc-roles 角色子代理 ' + escChild
    + ' / 其他会话 ' + escOther)
  if (escChild === 0) console.log('  ← ptc-roles 角色子代理零提权，与 approval policy never 一致（尚无理由做 sandbox-strip）')
  if (escRoot + escChild + escOther === 0) console.log('  ! 全为 0 —— 用 --all 复核：其他工作区应有非零计数，否则本计数器的阳性路径未被证明')
  if (pass + fail + warn === 0) console.log('提示: 没有任何 ptc-roles 角色子代理会话（只看到主 agent 属正常）。先派 1~2 个角色子代理，再重跑本脚本。')

  // 退出码契约（三个脚本统一为「0 = 符合预期」）：只有 ✗ FAIL 让退出码非 0。
  // `!` 与脚本内的 ✓/⊘ 标记保持 0 —— 它们按设计包含**合法**的已知现象（`⊘ 已知自身层泄漏`
  // 见 pitfalls #7、「非 ptc-roles 子代理」跳过、零提权提示、门行整场静默），升级为失败会让脚本
  // 常态变红而失去信号。**主 agent 丢 PTC 不在这个清单里**（2026-09-17 评审 M7：它是 FAIL）。
  // 「没找到会话 / 本工作区没有会话」也不让退出码非 0，但判定行会显式写「本次未验证」。
  process.exitCode = fail === 0 ? 0 : 1

  // ── 合成会话夹具的阴性对照（复盘 P1-2）────────────────────────────────────
  // 判据同样是**集合相等**：夹具必须恰好让 REQUIRED_FIXTURE_FAILURES 那几条失败 ——
  // 「本该红的断言没红」与「夹具坏得超出预期」都判不符合预期。
  if (CONTROL_SESSIONS) {
    const missing = REQUIRED_FIXTURE_FAILURES.filter((n) => !failedNames.includes(n))
    const extra = failedNames.filter((n) => !REQUIRED_FIXTURE_FAILURES.includes(n))
    const ok = missing.length === 0 && extra.length === 0
    console.log(ok
      ? '阴性对照符合预期：合成会话恰好让 ' + REQUIRED_FIXTURE_FAILURES.length + ' 条指定断言失败（一一对应，共 ' + fail + ' 项失败）。'
      : '⚠ 阴性对照不符合预期：应为指定 ' + REQUIRED_FIXTURE_FAILURES.length + ' 条、实得 ' + fail + ' 条'
        + (missing.length > 0 ? '；**该失败却没失败**：' + missing.join(' | ') : '')
        + (extra.length > 0 ? '；**意外多失败**：' + extra.join(' | ') : ''))
    process.exitCode = ok ? 0 : 1
  }
}

main()
