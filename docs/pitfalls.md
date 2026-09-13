# 踩坑与排障 —— 本 preset 的机制事实（唯一知识源）

> **「机制 / 坑 / 怎么办」只写在这里。** `AGENTS.md` 只放规则、`HANDOFF.md` 只放交接，
> 两者都**引用**本文件而**不复制**内容；加新坑请加在这里。
> 编号 **1–12 是稳定锚点**，外部统一按 `docs/pitfalls.md` #N 引用。

## A. 生效路径（改完怎么才算生效）

DSH 从 `~/.dsh/.agent-presets/agent-lanes/` 读，那里是**真目录 + 内部 4 个软链**指向本仓库
（`agent.cordis.yml` / `lane-role-presentation.mjs` / `preset.yml` / `personas`）。

- 改 `agent.cordis.yml` / `personas/*.md` → **开新会话即生效**（每次新会话重读）。
- 改 `lane-role-presentation.mjs` → 先 `dev_reload_preset preset=agent-lanes`（bump `?v=N` 绕 ESM 缓存），
  **再开新会话**。⚠️ 该工具只认**不带引号**的 `.mjs` 引用：写成 `'./x.mjs'` 时它回「无相对 .mjs 引用」
  然后**什么都不做**，主机的 ESM 缓存继续把**旧代**插件发给每个新会话，而你以为热更新过了（已实测）。
  改完**确认输出含 `x.mjs -> ?v=N`**。
- **本会话改的不生效** —— 配置在挂载时已读取，要验证必须开新会话。

## B. 机制与坑（1–12）

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
    断言见 `scripts/verify-lane-role-presentation.cjs`（11 条；旧版作阴性对照必须恰 5 项失败，否则断言空转）。
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

## C. 排障表（症状 → 原因 → 修法）

| 症状 | 原因 | 修法 |
|---|---|---|
| 选择器里没有 `agent-lanes` | 软链没建；或把**目录**做了软链（被静默跳过）；或缺 `agent.cordis.yml` | 确认 `~/.dsh/.agent-presets/agent-lanes/` 是**真目录**且内部 4 个软链在位 |
| mount 报错指向 `persona` 行 | `!!js` + `baseUrl` 在 preset 组合里未生效 | 把 persona 文本**内联**进 yml 的 `prefix` / `persona`（literal block），删掉 `!!js` |
| mount 报错指向 `role-*` 行 | `allow` 里有**未知名**：①工具改名 / MCP server 变更 ②**跨平台**（win32 上 `tool-bash` 被禁用，硬编码 `bash` 的角色行会直接派不出去） | 按 live 工具面核对后改白名单；带 shell 的角色行**必须**用平台表达式且**带引号**（#11）。未知名**响亮失败**是有意设计 |
| 子代理派出去就报错 | ①model 不在 provider 实时目录 ②模型**不支持**所声明的 `reasoningEffort`（explorer 曾栽在②） | **先读报错原文**：`does not support reasoning effort "X"` ⇒ 删掉该 effort 或换该模型支持的档；`route ... is not allowed for this Session` ⇒ 见 #8 |
| 脚本报 `✗ FAIL 子代理仍是 PTC` | 插件没生效 —— **本 preset 概率最高的失效模式**：插件行没挂上 / `.mjs` 软链失效 / ESM 缓存未 bump | ①核对 4 个软链在真目录里 ②`dev_reload_preset` 后开新会话 ③**别去查日志**（无落盘通道，#9）—— 脚本输出就是那条信号 |
| 脚本报 `✗ FAIL 主 agent 未载入 round-5 persona` | persona 在**挂载时**读取：软链断 / 改了但没开新会话 / 该会话早于 `PERSONA_V2_SINCE`（脚本扫全部历史，故有时间锚保护） | ①核对 `personas` 软链指向本仓库 ②**开新会话** ③若仍是新会话还报，说明挂的不是这份 —— 比对软链目标里 `orchestrator.md` 是否含 `Delegation contract`。⚠️ 该断言**只证文本被载入**，不证行为改变 |
| 子代理工具面比白名单**多**（恰是 `subagent` + `list_subagent_models`） | 自身层泄漏（#7） | **掩不掉**：`deny` 与插件式挂载**同样无效**，别花时间。脚本已容忍标注。要彻底消除**只能**置 `modelSelectionSettings: false`（代价＝编排器通用 `subagent` 失去模型侧选择参数） |
| 只读角色竟然派出了子代理 / 出现「depth-2 + 162 工具 + orchestrator persona」的孙代 | 通用 `subagent` 泄漏到子代理面，且该行**未**显式配 `maxDepth`（默认值是 **3**） | 已修：该行加 `maxDepth: 1`（#7）。若再现，先确认该行没被改回 |
| oracle 能看到 `implementer` | oracle 的 allow 被改过，或该角色行不在同一 preset | 核对 `role-oracle.config.toolFilter.allow` |
| 子代理 schema 里有 `sandbox_permissions` / `justification` | **不是缺口**（已结案，详见 `docs/evidence/2026-09-13-sandbox-escalation-closure.json`：子会话 `approval/policy = never` 在**任何 answerer 之前**就拒绝 ⇒ 提权构造上关闭；本机 91 个会话零证据） | **不做 sandbox-strip** —— 那会新增一个能误伤**编排器合法提权**的 pre-execute 监听。保持**检测**：脚本统计提权次数，只有角色子代理**持续非零**才值得做 |
| 改了 `.mjs` 没变化 | 未 bump `?v=`，ESM 按 URL 缓存 | `dev_reload_preset preset=agent-lanes` 后开新会话（A 节） |
| `dev_reload_preset` 回「**无相对 .mjs 引用（无需热更新）**」 | yml 里插件引用**被引号包住**，该工具只认裸 `./x.mjs` —— 它静默空转，旧代插件继续被新会话使用 | 去掉引号再跑；确认输出含 `x.mjs -> ?v=N`（A 节） |
| 插件单元校验有 FAIL | 深度判据被改坏：必须同时认 `Math.max(header, options.subagentDepth)` 与 `origin === 'subagent'`，且畸形深度要告警但**仍然**翻转 | 读 `scripts/verify-lane-role-presentation.cjs` 的断言名（#10）；**改回插件而非改断言** |
