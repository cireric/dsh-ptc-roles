# 踩坑与排障 —— 本 preset 的机制事实（唯一知识源）

> **「机制 / 坑 / 怎么办」只写在这里。** `AGENTS.md` 只放规则、`HANDOFF.md` 只放交接，
> 两者都**引用**本文件而**不复制**内容；加新坑请加在这里。
> 编号是**稳定锚点**：只往后新增、不重排，正文可追加（标日期）；外部统一按 `docs/pitfalls.md` #N 引用。

## A. 生效路径（改完怎么才算生效）

DSH 从 `~/.dsh/.agent-presets/ptc-roles/` 读，那里必须是**真目录 + 内部软链**指向本仓库
（部署清单 = `preset/ptc-roles/` 的全部顶层条目，当前 5 项：`agent.cordis.yml` / `role-presentation.mjs` /
`intent-gate-watchdog.mjs` / `preset.yml` / `personas`）。**别手工 `ln -s`，用 `make deploy`** ——
清单由 `scripts/deploy-preset.cjs` 自动发现，`make check` 负责对账（缺项 / 断链 / 指错 / 多余，漂移退 2）。

- **内部条目用软链（本仓库的既定形态）**：`dev_reload_preset` 改写的是部署目录里那份 `agent.cordis.yml`，
  软链会**透过链接写回本仓库** —— 所以跑完它，`preset/ptc-roles/agent.cordis.yml` 会多出一份 `?v=N` 的 diff，
  **那是正常的**，别当误改 revert 掉。副本形态**同样能跑**（与官方内置 preset 同形：真目录 + 真文件），
  但 bump 会落在拷贝上、仓库源**静默**不更新 ⇒ 本仓库统一用软链，别手工改成副本。
- **整目录做软链会被静默跳过**：发现逻辑按 Dirent 判 `isDirectory()`、不跟随软链（`discovery.ts:303`）⇒
  部署目录本身是软链时 `make check` 退 2 并点名。
- 改 `agent.cordis.yml` / `personas/*.md` → **开新会话即生效**（每次新会话重读）。
- 改 `role-presentation.mjs` → 先 `dev_reload_preset preset=ptc-roles`（bump `?v=N` 绕 ESM 缓存），
  **再开新会话**。⚠️ 该工具只认**不带引号**的 `.mjs` 引用：写成 `'./x.mjs'` 时它回「无相对 .mjs 引用」
  然后**什么都不做**，主机的 ESM 缓存继续把**旧代**插件发给每个新会话，而你以为热更新过了（已实测）。
  改完**确认输出含 `x.mjs -> ?v=N`**。
- **改完不重挂就不生效** —— 配置在**挂载时**读取：新会话是一次挂载，**重开 / resume 也是**（[实测] 2026-09-18：一个创建于改配置**之前** 31 分钟的会话，在一次 resume 后就已载入新配置）。⇒ 判据是「有没有发生过一次重新挂载」，不是「会话 id 新不新」。

## B. 机制与坑

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
    - **2026-09-17 追加：v2 之后多了一笔 #17 没覆盖的成本 —— 载体耦合。** #17 测的是**分母**代价
      （只读 bash 不会被误算进「该出门行的轮次」），那条结论仍然成立；但 v2 的合规分子判的是「门行
      所在消息是否早于首个行为动作的**载体消息**」，于是编排器在**开轮消息**里跑 shell 侦察
      （git status / make verify）会让该 run_code 成为首个行为动作的载体 ⇒ 门行与它同处一条消息
      ⇒ **该轮判未前置**。实测（本项目主会话 session-4c08f5dd，2026-09-17）：T1 declSeq=1 /
      firstActCarrier=1 ⇒ ✗；同一判据下 T4 开轮只做 read、动作留到下一条消息 ⇒ declSeq=27 /
      firstActCarrier=28 ⇒ ✓。⇒「只读侦察不算动手」在 PTC 下不成立（C 节排障表已按此改）。
      **2026-09-17 已解**：v3 把合规分子换成「存在」（#19），这条载体耦合从「扣分子」降为「只影响
      ② 对照读数」—— 载体耦合本身仍然存在，只是不再把照章办事判成失败。

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
    | **v2 前置 2/32 (6%)** / 行为动作覆盖 495/1064 (47%) | **v2**（门行早于首个行为动作；**2026-09-17 起降为对照口径**） | 3 个主 agent 会话 / 32 个会改变行为的轮次 | 2026-09-16（当场实测） | `node scripts/verify-ptc-roles.cjs` |
    | **① 存在 22/42 (52%)** / ② 前置 6/42 (14%) / 可见回复 39 / 任意文本 47 | **①（现行合规分子）**：门行所在消息的序号 ≤ 承载首个行为动作的载体消息序号（**同一条消息算数**，首行要求不变）；② 前置（`<`）只作对照 | 5 个装了门的主 agent 会话 / 42 个会改变行为的轮次 | 2026-09-17（当场实测） | `node scripts/verify-ptc-roles.cjs`；证据 ⑯ |

    - **口径别混**：**① 存在**（门行落在承载首个行为动作的那条消息里，且是该消息首行）是**合规分子**；
      **② 前置**（门行所在消息更早，`<`）、「可见回复」（该轮任何 assistant 文本含 marker）与
      「任意文本」（**含工具结果与工具参数**）只作**对照**——读过插件源码的轮次必然命中「任意文本」，
      那不是合规；② 只回答「有没有更早声明」，不回答「该不该扣分」。
    - **读数纪律**：写「门在静默衰减」之前先问「哪个窗口」；写「门很健康」之前先问
      「被数进去的那些轮次真的是会改变行为的轮次吗」。
    - **2026-09-16 判据对齐（插件 ↔ 合规分子）**：看门狗此前按「任意位置命中」判「上一轮有没有门行」，
      而合规分子是「**首行**」⇒ 「写在第二行」的轮次**指标扣分、看门狗却不提醒**（同一契约两处判据，
      正是 #12 那类漂移）。现已把插件收到**同一口径**（该轮首条有文本消息的首行；空文本不占「首条」）；
      单测为此加两条断言（marker 在第二行 / 在第二条消息都必须提醒），阴性对照清单相应扩大（判据仍是**集合相等**；
      **具体条数以脚本内的 `REQUIRED_CONTROL_FAILURES` 为准**，本文件不登记数字 —— 数字必漂）。
    - **2026-09-16 判据再改：v2（前置口径）—— 「同一次生成」被识破。** 上面那条「首行」口径把
      **与动作写在同一条消息里**的门行也算合规，而实测**那正是模型最常写的形态**（本会话 4/4 如此）。
      文本与工具调用在同一条 assistant 消息里是**同一次生成**（`agent-loop/src/agent.ts:466-489`）
      ⇒ 与动作同消息的门行锚不住它旁边的动作。**v2 定义**：门行所在消息必须**早于**首个行为动作的
      **载体消息**（载体 = 产生该 `tool/call` 的那条 assistant 消息；PTC 下经 `rootCallId` 归回）。
      合规分子换成它，插件判据同步（一处漂移单测即红）。**v1（首行 / 可见回复 / 任意文本）降为对照
      口径，不再接合规分子。**
    - **2026-09-16 v2 基线（当场实测：3 个主 agent 会话 / 32 个会改变行为的轮次）**：
      **v2 前置 2/32（6%）**、行为动作覆盖 **495/1064（47%）**；对照口径：首行 26/32、可见回复 28、
      任意文本 33；其中**两个会话整场 0%**。⇒ 直读结论：**门行目前基本不是前置，是事后报告**；
      47% 的覆盖说明「声明之后发生的动作」确实在上下文里，但那是同一条消息**之后**的消息。
      这是 v2 的**第一份**基线，别与上面的「首行」读数混引。
    - **2026-09-16 门行 token 迁移**：`意图判定` → `Intent:`（persona 模板与插件 `DEFAULT_MARKERS` 同步）。
      合规率脚本的 `INTENT_MARKERS` **同时**接受两个 token —— 插件看**当轮**（严），脚本扫**历史**（宽）；
      去掉旧 token 会把迁移前那批会话的读数改成 0、与上面的回归基线不再可比。**引用旧读数时按当时的 token 读。**
    - **2026-09-17 判据再改：v3（① 存在档，现役）—— 义务从「前置」收窄到「存在」。** 触发事实：v2 下
      40 个行为轮次里 35 个判未前置，而脚本自己把「同消息」那类注解为口径产物；v3 落地后当场读数
      **① 22/42 (52%)** vs **② 6/42 (14%)**，差额 16 轮**首发全部是 shell 侦察**（shell 16 / 非 shell 0）
      ⇒ 旧口径测的主要是「这一轮第一步恰好不是 shell」，不是模型漏行。真正的缺口只剩 19 轮
      （整轮无门行 6 + 动后补 13）。**理由**：门要先有一个 100% 可达、可强制的形态 —— 闸门
      （`tools/pre-execute`）只能挂在「存在」上，「前置」在本 harness 里**没有**能强制的点（#20）。
      **代价登记**：覆盖率（诊断读数）的窗口随之下移一格（同消息的动作也算被声明覆盖），
      聚合 47% → 58%，**新旧覆盖率不可直接比**。「同消息」不再算失败，但仍逐轮打印（`✓[同消息]`）——
      它是载体耦合的证据面，不是分数。
    - **2026-09-17 闸门：先观察、后开闸。** 插件默认 `observe`：只记账；若「闸门在动作到达时没看到
      门行」而该轮最终判合规，则在下一次 pre-step 注入一条诊断行（`RACE_REPORT`）—— 那是**假拒候选**，
      也是这条时序假设唯一可证伪的证据（logger 无落盘通道，#9）。`config.gate: enforce` 才真的拒绝，
      且**每轮最多一次**，拒绝理由自带补救话术（不会把模型围死）。
    - **2026-09-17 提醒降级（7 行 → 3 行）。** 理由不只是 token：提醒经 `agent/pre-step` 注入的消息会
      **永久落进会话**（`agent-loop/src/agent.ts:373-377`），旧口径下约 87% 的行为轮次各留一条逐字
      相同的常驻消息 —— 那是重复，不是信息。闸门接管「当轮纠正」之后，提醒的职责降为替补。
    - **2026-09-15 复审复核的当场发现**：13 轮里 **T1 / T12 漏了门行**（首行 11/13）——
      门**仍在漏**，只是不密。这类发现属**数据面观察**，**不接退出码**（模型行为不该让套件随机变红，
      同 `!` 的取舍）：要留就落证据文件，见 `docs/evidence/2026-09-15-review-v3-recheck.json`。
    - 看门狗的**全部正当性**都建立在这串数字上（「漏了没有代价 ⇒ 静默衰减」）⇒ 它一旦说不清，
      结论就跟着不可查。所以这里是**唯一**的口径登记处，别在别处复制第二份。

20. **纯文本的 assistant 消息会**结束本轮** —— 所以「先单独发一条声明、再动手」在本框架里做不到。**
    `agent.ts:486-488`：`const toolCalls = message.content.filter(block => block.type === 'tool-call');
    if (toolCalls.length === 0) return { kind: 'completed' }` ⇒ 一条**没有工具调用**的助手消息＝本轮到此
    为止，控制权交回用户。写下这条是因为照着「先发一条独立消息」设计过一版判据，直到读 agent loop
    才发现它不可能。推论：
    - 「先声明、再动手」只能靠**消息先后**实现，而声明所在那条消息**必须带工具调用**才活得下去 ⇒
      那些调用只能是**只读**的（否则声明与动作又同处一代）。这就是 v2 判据的形状（#19）。
    - 想**强制**它，唯一可用的点是 `tools/pre-execute`（执行前的 `allow`/`deny`/`ask`；PTC 内层派发
      同样过这道闸，见 `packages/core/tools/src/ptc.ts:541-545`）。那是**闸门**；门行本身没有任何强制力。
    - 闸门的上限：只能强制**顺序**，强制不了**诚意**（#16：门行的内容质量没有可靠判据）。
    - **2026-09-17 追加（本条推论的一处更正）**：#20 曾推出「可强制的只剩消息先后」，并据此写了 v2。
      v3 改判：可强制的真正形态是**存在**（门行在载体消息里、且为首行）—— 它不需要一条独立消息，
      因而不需要那个「声明消息必须带一个只读调用」的伪步骤。详见 #19 的 v3 段。

21. **评审与实验纪律 —— 四条，全部来自 2026-09-17 那次代码评审的真实翻车**（记在这里是因为它们各自
    造成过实际的错误结论，不是为了好看）：

    - **阴性结论必须先有阳性对照。** 「我改了 X，门禁没报」只有在**同一套门禁对已知必被抓的改动确实报了**
      之后才算证据。那次先跑了必被抓的变异（改插件门行 token ⇒ 24/27 ✗ 3、exit 1），才敢相信「给
      BEHAVIOR_TOOLS 加一个假工具名而三支门禁全绿」这个结论 —— 没有前者，后者可能只是脚本没跑起来。
    - **阴性对照自己也要能被验伪。** 一次「对照没打中」长得和「对照通过」一模一样：M7 的对照第一次
      静默通过，真因是拷贝的默认工作区不同、主循环根本没跑（✓23 而非 ✓41）。⇒ 对照自身必须有「变异没
      生效 ⇒ 这条对照自己 FAIL」的判据（roleFacts 与 behaviorToolsSelfTest 都是这么写的）。
    - **实验一律隔离：绝对路径 + 一实验一目录 + 收尾污染自检。** 同一条 shell 里 cd 进副本后再用相对
      路径 cp，第二个副本的源变成了第一个副本 ⇒ 日志里出现上一轮的变异症状，差点误判「真仓库被污染」。
      收尾自检 = 变异标记 grep 无命中 + git diff --stat 与实验前逐字一致。
    - **子代理的结论不是证据，静态读码尤其不是。** 那次两份评审报告里 4 条 Required 有 2 条被夸大、1 条
      被框架源码直接反证；同一份报告还把一处**已被符号链接击穿**的安全闸静态判成 ✅，动态一测就现形。
      ⇒ 结论逐条复核、动态 > 静态，并在报告里标「已复核 / 未复核」。

22. **token / 成本读数的口径 —— 数据早在盘上，但「求和」必须照抄框架口径，自造 `sum()` 会算错。**
    `assistant/message.data.usage` 逐 step 带 `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    reasoningTokens?, totalTokens?}`（[实测] 2026-09-18：ptc-roles 工作区 38 个会话里 35 个有值）。
    ⇒ ADR 0002 的 B 项（每角色成本归因）**是读盘，不是建插件**。但写任何读数之前，下面四条口径必须先定：

    | # | 口径 | 依据 |
    |---|---|---|
    | ① | **别自造桶**：桶 = `{uncachedInput, output, cacheRead, cacheWrite}`；`inputTokens` **只是未缓存输入**，计费输入 = 三桶相加；`totalTokens` 可选、不当分母 | `packages/llm/llm/src/types.ts:144-146`（"Counts are DISJOINT"）+ `token-meter/src/usage-projection.ts:21` |
    | ② | **折叠语义照抄 `tokenUsage` 投影**：计入 `assistant/message` **与** `assistant/attempt`；同一 `(turn, step)` 是**替换**不是累加（`addReplacing`）；`llm/retry-started` 关闭替换槽 ⇒ 重试的那次要**加** | `usage-projection.ts:114-145`（[读源码]，未跑对照实验） |
    | ③ | **seeded（fork）会话按 `parentSession` 归并成「一场」**，父只在根文件计一次 —— 子文件里是父事件的**深拷贝**，逐文件求和会把父的用量算第二遍 | [实测] 2026-09-18：`6d4dbcbc-…`（`isSeeded:true`、`parentSession=session-54bad2dc-…`）与父读数**完全相同**（102 步 / 15,389,114） |
    | ④ | **arm 取 `agent-preset/selected` 事件**（会话头 `agentPreset` 是创建时快照、已知滞后不可信）；且**人口要单列规则** —— `verify-ptc-roles.cjs:863` 的 `depth===0 && !isPresetRoot → continue` 会把同工作区的 ptc / standard 主会话整批挡掉，照抄就**看不见对照臂** | `verify-ptc-roles.cjs:830-832,863`；事件由 `agent-presets/src/index.ts:748` 写入 |

    - **会话头字段在 event 顶层、不在 `data` 里**（`id` / `createdAt` / `cwd` / `parentSession` / `isSeeded` /
      `origin` / `delegationDepth` / `agentPreset` / `version`）—— 读 `event.data.*` 会全取到 `undefined`。
    - **已在别处解决的别重写**：按 `header.id` 去重**已实现**（`verify-ptc-roles.cjs:830-832`，同 id 保留最长 raw）；
      seeded 会话也已识别并打印注解（`:860`）。要补的只是「本次合并 / 跳过了几条」的可审计计数。
    - **框架里没有货币价目表**（`token-meter/src/route-pricing.ts` 是**附件**（图 / 文件）表面 token 定价，全包搜不到 USD）
      ⇒ 只能说 **token 份额**，不能说「花费份额」；且 cacheRead 是折扣价，token 份额 ≠ 成本份额。
    - **预登记判定线**（先登记、后读数，防事后归因；命中即写一条 failure record，**不接退出码** —— 同 #19 的取舍）：
      1. `cacheRead == 0 && steps ≥ 10` —— ⚠️ 前提必须带「**该路由支持前缀缓存**」，否则每条无缓存路由都假阳性；
         2026-09-15 那场（40 步 / 未缓存输入 5.08M / cacheRead 0）也可能是对照臂读数，**先当观察、不当缺陷**（该路由是否支持缓存**未验证**）。
      2. 单角色 token 份额 > 50%（分组单位待定：一场 = root + 其后代，还是逐文件 —— 它决定分母）。
      3. 同一委派被退回 / 重投 ≥ 2 次。
      4. 连续两场 `0/N` 门行合规 —— **不新定阈值**：脚本已打印「整场静默的会话」，再定一条就是同一个数字的第二份定义（#12）。
    - **持久化只在窗口开启时做**（2026-09-18 用户裁决）：今天按 ③ 读，口径才是对的；而 `docs/evidence/` 在本仓是**权威引用**
      ⇒ **错口径 + 日期戳比没有数字更坏**。等 `0.1.6-rc` 落地、第一个**非自身仓库**任务开始前，再把快照能力建进
      `verify-ptc-roles.cjs`（**唯一**持有会话 reader 的文件 —— 别开第二份 reader，同 #12 的副本病）。在那之前读数只作
      一次性探针、**不进证据文件**。
    - **这套读数答不了窗口那个问题**：arm 只够做**跨任务病例对照**（不同任务、不同日期），而 ADR 0002 问的是**同一任务**下
      有无可测改善 ⇒ 要么把窗口问题收窄为「有没有明显的成本崩塌 / 异常」，要么接受末支（「不测 ⇒ 视为没必要」）。**待决。**

23. **读「某机制到底注入过没有」必须用注入前缀 + 阳性对照 —— 子串扫会话日志是**假阳性制造机**。**
    [实测] 2026-09-18：按 HANDOFF §2.3 的字面写法扫 `RACE_REPORT`，39 份会话里 **6 份命中**，逐条核对
    **无一条**是插件注入 —— 全部是引用：插件源码（`const RACE_REPORT = [`）、#19 的正文、模型自己的
    grep 参数与复述。这与 #19 记的「任意文本含工具结果与工具参数 ⇒ 读过源码的轮次必然命中」是同一类病，
    只是换了一个词；照原写法会得出**反向结论**（以为时序竞态成立，把该开的闸门关着）。

    - **判别读法**：扫**注入前缀**并按**事件类型分组** —— 注入只可能落在 `agent/inbox/spliced` 或
      `user/message`（插件经 `agent/pre-step` 注入；插件自陈「注入即写进会话日志」，见
      `intent-gate-watchdog.mjs:129-131`）。命中落在 `assistant/message` / `tool/call` / `tool/result`
      里，就是**谈论**它，不是**发生**它。
    - **阴性结论必须先有阳性对照**（#21 第一条）：本次的对照是 REMINDER —— 同一前缀在注入通道里**有**命中，
      所以「RACE_REPORT 0 次」是「真没有」，不是「测不到」。没有这条对照，0 与「工具没跑」无法区分。
    - **推广**：任何「这机制历史上触发过吗」的问题，先问三件事 —— 它的触发形态是什么字面、走哪条通道、
      阳性对照是什么 —— 再扫描。

## C. 排障表（症状 → 原因 → 修法）

| 症状 | 原因 | 修法 |
|---|---|---|
| 选择器里没有 `ptc-roles` | 软链没建；或把**目录**做了软链（被静默跳过）；或缺 `agent.cordis.yml` | 跑 `make check`（退 2 会点名是哪一类）→ `make deploy` |
| `make check` 退 2 | 部署与仓库漂移：缺项 / 断链 / 指错 / 目标目录本身是软链 / 多余项 | `make deploy` 重新部署（目标已存在时它会先列差异再问 y/N） |
| 合规率（v2）几乎全 ✗，但模型每轮都写了门行 | 门行与动作写在**同一条消息**里（同一次生成）⇒ v2 判为未前置；旧「首行」口径会把它记成合规（所以旧读数看着很好）。⚠️ **PTC 下「只读侦察」若走 bash 也算动手** —— bash/pwsh 无条件计入 BEHAVIOR_TOOLS（#17），所以「门行 + shell 侦察」同处一条消息**必然**未前置 | 门行放**开轮那条消息**里，且开轮消息只跑**不改变世界**的工具（read / grep / glob / lsp）；要 shell 侦察就挪到**下一条**消息：#19 / #20 / #17 |
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
