# 踩坑与排障 —— 本 preset 的机制事实（唯一知识源）

> **「机制 / 坑 / 怎么办」只写在这里。** `AGENTS.md` 只放规则、`HANDOFF.md` 只放交接，
> 两者都**引用**本文件而**不复制**内容；加新坑请加在这里。
> 编号 **1–18 是稳定锚点**，外部统一按 `docs/pitfalls.md` #N 引用。

## A. 生效路径（改完怎么才算生效）

DSH 从 `~/.dsh/.agent-presets/ptc-roles/` 读，那里是**真目录 + 内部 5 个软链**指向本仓库
（`agent.cordis.yml` / `role-presentation.mjs` / `intent-gate-watchdog.mjs` / `preset.yml` / `personas`）。

- 改 `agent.cordis.yml` / `personas/*.md` → **开新会话即生效**（每次新会话重读）。
- 改 `role-presentation.mjs` → 先 `dev_reload_preset preset=ptc-roles`（bump `?v=N` 绕 ESM 缓存），
  **再开新会话**。⚠️ 该工具只认**不带引号**的 `.mjs` 引用：写成 `'./x.mjs'` 时它回「无相对 .mjs 引用」
  然后**什么都不做**，主机的 ESM 缓存继续把**旧代**插件发给每个新会话，而你以为热更新过了（已实测）。
  改完**确认输出含 `x.mjs -> ?v=N`**。
- **本会话改的不生效** —— 配置在挂载时已读取，要验证必须开新会话。

## B. 机制与坑（1–18）

1. **`maxDepth` 是子代理的绝对深度上限**：`childDepth = parentDepth + 1`，超过就抛 `SubagentDepthError`。
   主 agent 深度 0 ⇒ **`maxDepth: 0` 会让它一个子代理都派不出去**。当前取值：explorer / librarian = `2`
   （让 depth-1 的 oracle 也能派它们），oracle / implementer / designer = `1`。
2. **叶子性不能靠 `maxDepth` 表达**（一个工具实例服务所有调用深度）—— 靠 **allow 白名单不含任何角色工具名**。
3. **`@deepseek-ai/dsh-persona` 的字段是 `prefix`（必填），没有 `text`**（0.1.3-alpha.2 改名）。
   写错会让**整个 preset 挂载失败**。
4. **表现模式翻转必须在 `agent/created`**：一步的 prompt / 工具装配发生在 `agent/pre-step` **之前**
   （`agent-loop/src/agent.ts:245` 早于 `:249`），在 pre-step 里改 mode 要下一轮才生效。
5. **子代理继承父的 preset 组合**（`composeFrom` → `bindScopeParent`）⇒ preset 声明 PTC 时子代理默认也是
   PTC —— 这正是翻转插件要修的东西。
6. **`run_code` 是保留传输**：`tools.restrict()` 拒绝命名它，任何白名单都删不掉；它跑在宿主进程的 worker
   里、有 `fs` / `child_process`，**绕过 DSH 文件沙箱** ⇒ PTC 下「只读角色」根本不成立 —— 这是整个
   native 翻转的动机。
7. **自身层泄漏：`toolFilter` 掩不掉「本 scope 自己注册的」工具。** `view()` 先对**继承面**套限制，再把该
   scope 自身层的注册**原样插入**（`core/tools/src/index.ts:1166-1172`，注释原文 "own registrations last …
   outside the filter above"）—— 所以 `allow` 只能遮蔽继承来的工具，`deny` 也一样。
   **根因**：preset 的 `tool-subagent` 行设了 `modelSelectionSettings: true` ⇒ 它走 standing scoped install，
   对组合内**每个 agent** 把 `subagent` 与 `list_subagent_models` 注册进**各自的 scope 层**；同组的
   `subagent_fork` 不走这条路径、只作继承面存在，因此被**正确遮蔽**（这解释了「为何恰好只多这两个」）。
   **危害实测**：泄漏的通用 `subagent` 当时既无 toolFilter 也无 maxDepth，depth-1 的 oracle 派出了 3 个
   depth-2 孙代（各 162 工具 + orchestrator persona）。
   **缓解**：该行 `maxDepth: 1` **不能删** —— 删了 depth-1 角色就能派出无限制孙代。再派时工具面回朴素
   文本 `Error: subagent depth 2 exceeds maxDepth 1`（`SubagentDepthError` 是真实类名，但**不穿过工具面**，
   引用时别混为一谈）。验证脚本对这两个泄漏工具**容忍并显式标注**（`KNOWN_SELF_LAYER`），别去「修」。
8. **角色的 model + `reasoningEffort` 必须对得上 provider 实时目录。** 实测：`meituan/LongCat-2.0:free`
   没有任何可选 effort 档、`z-ai/glm-5.3-flash` 只有 `low|high|max`（写 `medium` 即派发报错）。
   两个关键点：①**门禁不是** `llm-commandcode.visibleModels` —— 改那里没有任何效果；②`settings.yaml` 的
   `subagent-model-selection.allowedModels`（默认 `enabled: false`）**只校验模型侧显式选择**，角色行写在
   `agentOptions` 里的 provider/model 走 `llm.resolveCallConfig` 的**真实目录 + effort 校验**。
   排障顺序：provider 实时目录（`~/.commandcode/models-cache.json`）→ effort 支持表（provider `lib/index.js`
   的 `KNOWN_EFFORTS` / `KNOWN_THINKING_MODELS`）→ 最后才考虑 Session 白名单。
9. **`ctx.logger.warn` 在本部署没有落盘通道。** 三证：`~/.dsh/logs` 不存在；穷举 30 种 session 事件类型
   **没有任何** log / warn / error；`apps/cli/src` 无日志文件 sink。⇒ AGENTS.md 硬约束（失败必须可见）
   **不能靠日志兑现**：要可见，失败就得进**数据面**（会话事件 → 脚本判定）。
   **含义：排障走脚本，别走日志。**
10. **翻转插件的深度判据：对齐框架口径 + `origin` 兜底。** 权威口径是
    `Math.max(session.header.delegationDepth ?? 0, options.subagentDepth ?? 0)`（`subagent/src/depth.ts:28-36`；
    header 是**单调下界**，runtime 只能加深）。今天两者同源故等价，但任何「只记 options、不记 header」的
    创建路径都会让真子代**零告警地留在 PTC** = `run_code` 逃逸。现插件四层：①按上面的 `Math.max` 解析
    ②再认 `origin === 'subagent'` 兜底 ③`options.subagentDepth` 畸形时告警并退回 header（框架在此抛
    TypeError；插件选「响亮告警 + 仍翻转」而非静默）④深度 0 但 origin 是子代理时也告警。
    **钉住这条是因为翻转本身就是安全边界**，而日志在本部署不可回溯（#9）。
    断言见 `scripts/verify-role-presentation.cjs`（11 条；旧版作阴性对照必须恰 5 项失败，否则断言空转）。
11. **yml 里的表达式与白名单有三个坑。**
    - **`!!js` 表达式必须带引号。** 不带引号的 `- !!js a ? 'pwsh' : 'bash'` 是**合法 YAML**，但会解析成
      **复合 mapping key**（实测得到 `{"[object Object]":"bash"}`）—— **不报错**，静默产出一个**非字符串**的
      allow 项，排障极难。必须写成 `- !!js "…"`，照 `packages/preset/agent-presets/presets/cordis/agent.cordis.yml:260`
      的引号风格。机制：loader 的 `interpolate()` 对**数组元素**递归求值（`cordis-plugin-loader/lib/index.js`）。
    - **角色 allow-list 不能硬编码 `bash`。** `tool-bash` 在 win32 被禁用（那台机器只有 `pwsh`），而 allow 里的
      **未知名会让角色派发直接失败**（响亮失败是有意设计）⇒ 带 shell 的角色行必须写平台表达式
      `!!js "process.platform === 'win32' ? 'pwsh' : 'bash'"`。JS 侧同口径是验证脚本的 `SHELL` 常量 ——
      **改一处要同步另一处**。
    - **加角色只动两处：yml + `EXPECTED`。** 验证脚本原先还把角色名**硬枚举**在角色识别正则里（`EXPECTED`
      之外的**第三处**登记点，且无注释）：加 designer 时实测踩中 —— 漏改会走「认不出角色」WARN，而
      `EXPECTED.designer` **永远查不到**，报错还指向错误方向。现已改成**通用捕获**。再出现第三处枚举就并掉它。
12. **同一批角色事实有 3 份手工副本，改一处就会漂移。** `agent.cordis.yml` 的 `allow`、验证脚本的
    `EXPECTED`、README 的角色表是同一批事实的三个副本 —— 本项目已被漂移咬过两次（README 模型档写反、
    脚本里还藏着**第三处**角色名枚举）。所以两条纪律：①**改白名单必须同步改 `EXPECTED`**
    （漏了会立刻 FAIL，不会静默 —— 这是它可以接受手工同步的原因）；②**persona 的 Specialists 表只写
    路由事实（领域 / 何时委派 / 拓扑 / 只读或可写），绝不写工具名** —— 别再添第 4 份。

13. **`glob` / `grep` 的「发现」语义 —— 三条实测事实**（2026-09-14，本仓库内复现两轮；仓库目录与
    「软链部署目录」对照测）：
    - **① 模式基准是「会话 cwd」，不是 `path` —— 会产出「假空」。** `path` 只限制**遍历根**，
      **不重定匹配基准**：**无斜杠**的模式按 **basename** 匹配（任意深度），**有斜杠**的模式按
      **相对会话 cwd 的完整路径**匹配。实测（`path` = 仓库 `preset/ptc-roles`，该目录真值 9 个文件）：
      `'personas/*'` → **0 条（假空）**、`'personas/explorer.md'` → **0 条**；而 `'*.md'` → 6 条、
      `'**/personas/*'` → 6 条、`'preset/ptc-roles/personas/*'` → 6 条、`'**/*'` → 9 条。
      ⇒ **0 条 ≠ 「目录是空的」**。自然的「列子目录」写法必然假空 —— **别把 0 条当证据**去下
      「目录为空 / 文件缺失」的结论；要么写 `**/<子目录>/*`，要么把 `<子目录>` 当 `path` 再配 `**/*`。
    - **② symlink 是盲区（结构性，改配置改不出来）。** `glob` / `grep` 都是 ripgrep 直传
      （`packages/fs/tool-fs-search/src/glob.ts:78-91` 原文 "Build the fixed `rg --files` argv"），
      ripgrep **不列出、也不跟随遍历中遇到的 symlink**，而 `tool-fs-search` 的 **9 个 Config 字段里
      没有任何跟随开关**。实测：对一个「全是软链、0 个真文件」的目录，`'*'` / `'**/*'` / `'*.md'`
      与 `grep('persona')` **全部 0 条**；而**作为 `path` 传入的软链目录会被跟随**（`path=<软链目录>`
      + `'**/*'` → 6 条）⇒ 「**看得见真文件、看不见软链**」。
    - **③ `read` 不能列目录（官方契约，非配置）。** `tool-fs` 的 README「Known Limitations」原文：
      `read` 只处理 UTF-8 文本文件、**"A directory target is `FS_NOT_REGULAR_FILE`"**
      （实现 = `packages/fs/fs-local/src/fsio.ts:354-366` 的 `statRegularFile` 闸门；实测 8 种目录形态
      —— 含空目录、软链目录、相对路径、带尾斜杠 —— 全部同一条报错，而普通文件正常读出）。
      ⇒ 只有 `read` / `glob` / `grep` 时，对**目录条目 / symlink / 空目录 / 元数据 / hash**结构性不可见。

14. **探索类角色（`explorer` / `librarian`）的工具面边界 + 路由约定。** 这两个角色白名单里**没有 shell**，
    所以 `ls` / `stat` / `readlink` / `shasum` 一类**文件系统级侦察结构性做不到**。配合 #13③，
    它们对目录与元数据的盲区是**「无 shell 只读叶子」这个取舍的已知代价，不是待修的缺口**
    （官方 4 个 preset 都没挂目录列举工具，是因为**它们都有 shell**；本 preset 的 explorer 没有 shell
    是**刻意的设计选择**）。
    - **路由约定**：需要 **symlink / 元数据（类型、size、mtime、权限）/ hash** 的核查 ⇒
      **派 `implementer`（有 shell）或编排器自己做**；**不要**为这类需求扩 `explorer` 白名单。
    - **刻意不做**：不新增 `list` / `tree` 工具；**也不挂官方 `str_replace_editor`** —— 它的 `view`
      能列目录（非隐藏、**最多 2 层**、symlink 显示为 `?`），但它是**编辑器**
      （`view`/`create`/`str_replace`/`insert`）、Config **无只读开关**，而 `toolFilter` 按**工具名**
      遮蔽 ⇒ 给谁就**连带给写**。**先有失败记录再谈**（AGENTS.md 规则演进原则）。
    - **若将来真出现重复需求**（≥3 次实际受阻、且编排器代跑解决不了）：升级路径 = ①官方
      `str_replace_editor.view`（代价：连带写）或 ②经官方 seam `ctx.fs.listDir`
      （`packages/fs/fs/src/index.ts:236`）写**只读薄适配** —— 插件用 `ctx.get('fs')` 取服务，
      **无需 import `@deepseek-ai/*`**（不违反零 import 规则），也不绕过 fs 服务（含 lstat / containment）。
    - **附带**：`lsp` 在本项目**inert** —— `.mjs` / `.cjs` 都报 `no LSP provider handles`
      （本仓库没有 `.ts`/`.js`/`.py`/`.go`/`.rs`）；官方 `lsp` 另有**工作区包含性**约束
      （工作区外文件报 `source "…" resolves outside the workspace`）⇒ 它只在本工作区内的受支持语言上有效。

15. **会话库是滚动窗口，不是归档** —— 任何「历史上曾经 X 轮」的说法**只能在当场测**，测完就得落成证据文件。
    实测（2026-09-15）：`~/.dsh/sessions` 下 77 个会话文件里**没有任何 26/27 轮的会话**（轮数最多的是 28 轮，
    属于另一个项目）；本项目 `cireric-dsh-agent-lanes` 工作区目录 mtime = `2026-09-15 00:07`，**现仅存 1 个会话**；
    证据 ⑨ 引用的 `session-2982160d…` 及其 3 个子会话 `find` 不到；另有 **5 个工作区目录为空**。
    ⇒ 合规率这类历史性指标必须**做进脚本**（`verify-ptc-roles.cjs` 的「意图门合规率」），不能靠考古。
    **注意**：这里只记录事实，不判断清理是谁做的、依据什么策略。完整实测见证据 ⑪ 的 `reproducibility`。

16. **看门狗观测不到门行的「内容质量」** —— 它只对 `DEFAULT_MARKERS` 做**子串**匹配，于是两头都不设防：
    ①门行**写成内部记账**（turn 号 / 看门狗状态 / 证据文件名）它也沉默（实测：证据 ⑪ 的 G-5）
    ②仅仅**谈论**门行（「我按要求没有输出意图判定行」）会被算成「有门行」（实测：证据 ⑫ 的 H-5）。
    ⇒ 内容质量只能靠 **prompt 侧**（persona + REMINDER 写清「读者是用户」「是承诺不是标签」），
    **不做正则 linter**：判「这行是不是记账」没有可靠规则，误伤编排器合法用词的风险大于收益
    —— 同证据 ⑥ 否决 sandbox-strip 的理由。**先有失败记录再谈**。

17. **`bash` 一律算「会改变行为」是**保守判据**，不是缺陷 —— 而且它**不可能**被改准。**
    合规率与看门狗共用的 `BEHAVIOR_TOOLS` 把 `bash`/`pwsh` 无条件计入「该出门行的轮次」，
    于是**只读**的 bash（`ls` / `git status` / `zstd -dc`）也会进分母、也可能被提醒。
    - **为什么不是 bug**：判据必须能从**数据面**机械核查。`edit` / `write` 的 `tool/result` 里带
      「路径 + 前/后内容」，能事后判出到底改没改；`bash` 的 `tool/result` **只有 stdout 文本**，
      结构上**无法**判断那条命令是不是只读 ⇒ 按参数猜「只读」= 用正则解析 shell，脆且误判面更大。
    - **实测代价目前为零**：2026-09-15 对本项目全部 6 个装了门的会话（30 个 eligible 轮次）
      逐条回看派发参数，**read-only-bash-only 的轮次 = 0** —— 这条判据至今**没有**把任何一次
      只读轮次误算进分母。所以它是**保守**（bias-toward-reminding），不是**偏差**。
      ⚠️ **「实测为零」的基数已失效**：那次取证覆盖的 6 会话 / 30 轮**已随滚动窗口消失**
      （2026-09-15 复审复核时脚本只能看到 1 个装了门的主会话 / 13 轮，见 #15/#19）⇒ 这个数字
      **不可复现，只能当「取证当时」的记录读**。**判据结论不受影响** —— 它的论证是结构性的
      （`bash` 的 `tool/result` 只有 stdout ⇒ 判不出只读），不依赖计数。
    - **命名纪律**：写文档时说「保守判据 bias-toward-reminding」，不要说「偏差 / 待修」；
      真要收敛，唯一可行方向是**新增**一个能区分只读的传输（本仓库没有），不是解析参数。

18. **`?v=` 只能 bump `agent.cordis.yml` 里引用的 `.mjs` ⇒ 插件**不能**共享兄弟模块。**
    `dev_reload_preset` 的匹配式是 `/(name: \.\/[A-Za-z0-9._-]+\.mjs)(\?v=\d+)?/g`，它只改写
    **yml 里被引用**的那些文件。推论：若两个插件把公共代码放进 `preset/ptc-roles/depth.mjs`
    并互相 `import`，那个 specifier **永远不会带 `?v`**，宿主 ESM 缓存会一直发旧字节 ——
    修了**等于没修**，而且**静默**（同 #9 的家族：没有回读通道）。
    ⇒ 这就是 `resolveDepth()` 在 `role-presentation.mjs` 与 `intent-gate-watchdog.mjs` 里
    **各存一份**的真正原因（两处文件头都有注释）。代价是重复，收益是**每一处改动都骑在
    一次 `?v=N` bump 上**。**别"顺手"合并这两个函数。**
    [推断，未实测：本机没跑过「共享模块 + bump 入口文件」的对照实验；机制依据是匹配式本身。]

19. **「合规率」这一个词在本仓库有四个数（8% ~ 85%），差一个数量级的原因不是门在崩、也不是门很好
    —— 是口径与窗口都不同。引用这个数字时必须同时带上「口径 + 窗口 + 日期」。**

    | 数字 | 口径 | 窗口 | 取证日 | 出处 |
    |---|---|---|---|---|
    | 任意文本 3 / 可见回复 2 / **首行 0**（26 轮） | 三口径并列 | 26 轮（源会话已不在库中） | ≤ 2026-09-15 | `docs/evidence/README.md` §11 的 `quotedRecord`，标 **`QUOTED`**（该文件自己**没**重测出这四个数） |
    | **首行 11/13 (85%)** / 可见回复 11 / 任意文本 13 | 「首行」= 合规分子 | 1 个装了门的主 agent 会话 / 13 轮（会改变行为 13 轮） | 2026-09-15 复审复核（当场实测） | `node scripts/verify-ptc-roles.cjs --raw` |
    | read-only-bash-only = 0 | 同 #17 | 6 个装了门的会话 / 30 个 eligible 轮次 | 2026-09-15（**基数已随滚动窗口消失**，见 #17） | 本文 #17 |

    - **三个口径别混**：「首行」（该轮第一条有文本的 assistant 消息的首行）是**合规分子**；
      「可见回复」（该轮任何 assistant 文本含 marker）与「任意文本」（**含工具结果与工具参数**）
      只作**对照**——读过插件源码的轮次必然命中「任意文本」，那不是合规。
    - **读数纪律**：写「门在静默衰减」之前先问「哪个窗口」；写「门很健康」之前先问
      「被数进去的那些轮次真的是会改变行为的轮次吗」。
    - **2026-09-16 门行 token 迁移**：`意图判定` → `Intent:`（persona 模板与插件 `DEFAULT_MARKERS` 同步）。
      合规率脚本的 `INTENT_MARKERS` **同时**接受两个 token —— 插件看**当轮**（严），脚本扫**历史**（宽）；
      去掉旧 token 会把迁移前那批会话的读数改成 0、与上面的回归基线不再可比。**引用旧读数时按当时的 token 读。**
    - **2026-09-15 复审复核的当场发现**：13 轮里 **T1 / T12 漏了门行**（首行 11/13）——
      门**仍在漏**，只是不密。这类发现属**数据面观察**，**不接退出码**（模型行为不该让套件随机变红，
      同 `!` 的取舍）：要留就落证据文件，见 `docs/evidence/2026-09-15-review-v3-recheck.json`。
    - 看门狗的**全部正当性**都建立在这串数字上（「漏了没有代价 ⇒ 静默衰减」）⇒ 它一旦说不清，
      结论就跟着不可查。所以这里是**唯一**的口径登记处，别在别处复制第二份。

## C. 排障表（症状 → 原因 → 修法）

| 症状 | 原因 | 修法 |
|---|---|---|
| 选择器里没有 `ptc-roles` | 软链没建；或把**目录**做了软链（被静默跳过）；或缺 `agent.cordis.yml` | 确认 `~/.dsh/.agent-presets/ptc-roles/` 是**真目录**且内部 5 个软链在位 |
| mount 报错指向 `persona` 行 | `!!js` + `baseUrl` 在 preset 组合里未生效 | 把 persona 文本**内联**进 yml 的 `prefix` / `persona`（literal block），删掉 `!!js` |
| mount 报错指向 `role-*` 行 | `allow` 里有**未知名**：①工具改名 / MCP server 变更 ②**跨平台**（win32 上 `tool-bash` 被禁用，硬编码 `bash` 的角色行会直接派不出去） | 按 live 工具面核对后改白名单；带 shell 的角色行**必须**用平台表达式且**带引号**（#11）。未知名**响亮失败**是有意设计 |
| 子代理派出去就报错 | ①model 不在 provider 实时目录 ②模型**不支持**所声明的 `reasoningEffort`（explorer 曾栽在②） | **先读报错原文**：`does not support reasoning effort "X"` ⇒ 删掉该 effort 或换该模型支持的档；`route ... is not allowed for this Session` ⇒ 见 #8 |
| 脚本报 `✗ FAIL 子代理仍是 PTC` | 插件没生效 —— **本 preset 概率最高的失效模式**：插件行没挂上 / `.mjs` 软链失效 / ESM 缓存未 bump | ①核对 5 个软链在真目录里 ②`dev_reload_preset` 后开新会话 ③**别去查日志**（无落盘通道，#9）—— 脚本输出就是那条信号 |
| 脚本报 `✗ FAIL 主 agent 未载入 round-5 persona` | persona 在**挂载时**读取：软链断 / 改了但没开新会话 / 该会话早于 `PERSONA_V2_SINCE`（脚本扫全部历史，故有时间锚保护） | ①核对 `personas` 软链指向本仓库 ②**开新会话** ③若仍是新会话还报，说明挂的不是这份 —— 比对软链目标里 `orchestrator.md` 是否含 `Delegation contract`。⚠️ 该断言**只证文本被载入**，不证行为改变 |
| 子代理工具面比白名单**多**（恰是 `subagent` + `list_subagent_models`） | 自身层泄漏（#7） | **掩不掉**：`deny` 与插件式挂载**同样无效**，别花时间。脚本已容忍标注。要彻底消除**只能**置 `modelSelectionSettings: false`（代价＝编排器通用 `subagent` 失去模型侧选择参数） |
| 只读角色竟然派出了子代理 / 出现「depth-2 + 162 工具 + orchestrator persona」的孙代 | 通用 `subagent` 泄漏到子代理面，且该行**未**显式配 `maxDepth`（默认值是 **3**） | 已修：该行加 `maxDepth: 1`（#7）。若再现，先确认该行没被改回 |
| oracle 能看到 `implementer` | oracle 的 allow 被改过，或该角色行不在同一 preset | 核对 `role-oracle.config.toolFilter.allow` |
| 子代理 schema 里有 `sandbox_permissions` / `justification` | **不是缺口**（已结案，详见 `docs/evidence/2026-09-13-sandbox-escalation-closure.json`：子会话 `approval/policy = never` 在**任何 answerer 之前**就拒绝 ⇒ 提权构造上关闭；本机 91 个会话零证据） | **不做 sandbox-strip** —— 那会新增一个能误伤**编排器合法提权**的 pre-execute 监听。保持**检测**：脚本统计提权次数，只有角色子代理**持续非零**才值得做 |
| 改了 `.mjs` 没变化 | 未 bump `?v=`，ESM 按 URL 缓存 | `dev_reload_preset preset=ptc-roles` 后开新会话（A 节） |
| `dev_reload_preset` 回「**无相对 .mjs 引用（无需热更新）**」 | yml 里插件引用**被引号包住**，该工具只认裸 `./x.mjs` —— 它静默空转，旧代插件继续被新会话使用 | 去掉引号再跑；确认输出含 `x.mjs -> ?v=N`（A 节） |
| 插件单元校验有 FAIL | 深度判据被改坏：必须同时认 `Math.max(header, options.subagentDepth)` 与 `origin === 'subagent'`，且畸形深度要告警但**仍然**翻转 | 读 `scripts/verify-role-presentation.cjs` 的断言名（#10）；**改回插件而非改断言** |
| `glob` 对某目录返回 **0 条**，但目录里明明有文件 | 模式基准是**会话 cwd**、不是 `path`；或目标是**软链**（ripgrep 不列出软链） | 改写成 `**/<子目录>/*`，或把该目录当 `path` 再配 `**/*`；先确认它是不是软链（#13①②） |
| 角色子代理说「目录是空的 / 文件不存在」，但编排器 `ls` 看得见 | 探索类角色对目录条目与 symlink **结构性不可见**（#13③ / #14） | 这类核查派 `implementer` 或编排器自己做；**不要**为它扩 `explorer` 白名单（#14） |
| 想让 `explorer` 能列目录 / 查 hash | 只读叶子 = 无 shell，这是**刻意取舍**（#14） | 先确认是否真有重复受阻（≥3 次）；升级路径与代价见 #14 |
| 想问「上个月漏了多少轮门行」 | 会话库是**滚动窗口**，早期会话已被清掉（#15） | 不可考 —— 只能当场测；历史性指标一律做进脚本 |
| 合规率 0%、但模型明明很听话 | ①测试/剧本明令禁止输出门行 ②门行被写成了内部记账（插件看不出来）③门行只是被**谈论**过 | 先按证据 ⑪/⑫ 的口径读；**内容质量要人读那一行**（#16），别改判据去凑数 |
| 只读的 bash 轮次也被要求门行 / 进的合规率分母 | 这是**保守判据**（#17）：`bash` 一律算「会改变行为」，因为只读与否在数据面**不可判**（`tool/result` 只有 stdout） | **不改**。实测至今零误算（30 个 eligible 轮次里 read-only-bash-only = 0）；措辞用「保守判据」，别叫「偏差」 |
| 想把两个插件里重复的 `resolveDepth()` 合并成一个共享模块 | **不能**：`dev_reload_preset` 只 bump `agent.cordis.yml` 里引用的 `.mjs`，共享兄弟模块的 specifier 恒定 ⇒ 改了**静默不生效**（#18） | 保持两份副本；改一份必改另一份（漂移会让**其中一个**校验脚本的深度断言失败） |
| `verify-intent-gate-watchdog.cjs --control` 报「不符合预期」但 `$?` 是 0 | 退出码契约是「**0 = 本次运行符合预期**」，不是「零失败」 | 看脚本打印的那行判定（`阴性对照符合预期…`）；`$?` 只在「不符合预期」时才非 0 |
| 两个文档里的「合规率」差一个数量级（8% vs 85%） | **口径与窗口都不同**，不是门在崩也不是门很好（#19） | 引用时必须带「口径 + 窗口 + 日期」；唯一登记处是 #19，别在别处复制第二份 |
| 升级 dsh 本体后 preset 行为变了 / 挂载失败 | 框架契约漂移（深度公式、`presentAs` 语义、`agent/created` / `agent/pre-step` 载荷、包改名）—— 上游 issues 已关闭，只能自兜 | 升级**前后各**跑 `node scripts/verify-harness-contract.cjs --harness <checkout>`：变红的那条直接指出 preset 侧要改哪一处；包改名会给出疑似新名 |
| `verify-ptc-roles.cjs` 报 `✗ FAIL 不可归属的 tool/ptc-dispatch` | 归因失明 = 行为判据看不见东西（`tool/ptc-dispatch` 回指不到任何 `tool/call`）⇒ 是**未知异常**，不是可容忍的已知现象（#7 那种才是） | 先查 `tool/call` 的 `callId` 与派发的 `rootCallId` 是否还同名同源；**别**把这个数字降回提示。阳性路径的断言在 `scripts/fixtures/attribution-cases.json` |
