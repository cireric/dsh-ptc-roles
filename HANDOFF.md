# HANDOFF — agent-lanes（角色化子代理 preset）

> 面向下一个**全新**会话。假设你没有任何上下文，读完这份即可接手：
> 知道这是什么、**怎么测**、**怎么修**。
> 配套文件：`AGENTS.md`（硬约束 + 常跑命令，自动加载）、`README.md`（面向人）。
> 生成时间：2026-09-13 ｜ 项目目录：`/Users/eric/Project/tests/dsh-plugins/cireric-dsh-agent-lanes`

---

## 0. 先确认你在哪个 preset 下

**你应该运行在 `agent-lanes` preset 下。** 快速自检：你的工具面里应当有
`explorer` / `librarian` / `oracle` / `fixer` 四个**命名委派工具**（PTC 模式下它们在
`run_code` 的 SDK 里）。看不到这四个 → 你跑的不是本 preset，先让人在新会话里选
`agent-lanes`（见 §5 排障第 1 条）。

## 1. 一句话状态

一个 **DSH agent preset**（不是插件、不是 bundle）：orchestrator 主 agent + 四个命名角色
子代理，**主 agent 保持 PTC（省 token），子代理切 native（拿硬边界）**。

- **装配冒烟已过**（2026-09-13）：preset 挂载无报错；主 agent 仍是 PTC；四个角色工具在 PTC 的
  SDK 里齐全。
- **行为冒烟 + 复验全绿**（2026-09-13，脚本汇总 `✓6 ✗0 !0`）：核心机制实测成立 —— native 翻转
  **真的生效**（子代理 `ptc=no`、`run_code` 消失，逃逸通道关闭）、`toolFilter.allow` 对**继承面**
  精确遮蔽（oracle 看不到 `fixer`）、四个角色工具面与白名单精确匹配。首轮逮到的三处问题
  （explorer / librarian 派不出去；工具面泄漏 + 孙代升级已被利用）已修并复验通过 —— **v1 成立**。
  证据：`docs/evidence/2026-09-13-v1-reverify.json`。
- **复验后追加的加固**（2026-09-13）：翻转插件的深度判据对齐框架口径并加 `origin` 兜底（§7.10），
  顺带修掉「preset 的 `.mjs` 引用被引号包住 ⇒ `dev_reload_preset` 静默空转」这个坑（§4）。
  ⚠️ 这两项**要新会话才生效 / 才可验**（本会话仍是旧代）。

## 2. 你接手后要做什么（按顺序）

> 步骤 0–3 已于 2026-09-13 **全部通过**（v1 成立），步骤 1b 是复验后新增的加固。
> 以下保留为**可重跑的冒烟流程** —— 改过 preset 就按同样顺序复验。

### 步骤 0 · 装配冒烟（3 项，肉眼可判）— **2026-09-13 已通过**
1. 新会话选 `agent-lanes` → **不应有 mount 报错**（失败会 fail-fast 并指名 preset 内行的 id）。
2. 主 agent 仍是 PTC：直接可调的只有 `run_code`。
3. 工具面出现 `explorer / librarian / oracle / fixer`。

### 步骤 1 · 复验三处改动 — **2026-09-13 已通过**（原先**必须新会话**）
1. **explorer / librarian 能派出去**。原因：`explorer` 原声明 `reasoningEffort: low`，但
   `meituan/LongCat-2.0:free` 属 provider 的 `KNOWN_THINKING_MODELS` —— 会思考、**无任何可选
   `reasoning_effort` 档** —— 派发时直接报 `does not support reasoning effort "low"`；
   `librarian` 的 `medium` 同理不被 `z-ai/glm-5.3-flash` 支持（该模型只有 `low|high|max`）。
   现为：explorer **不声明** effort、librarian 用 `low`。
2. **孙代升级被堵死**。`tool-subagent` 行新增 `maxDepth: 1`：让 oracle 试调一次通用 `subagent`，
   工具面回传的是朴素文本 `Error: subagent depth 2 exceeds maxDepth 1`（真正的类名确实是
   `SubagentDepthError`，但**不会**出现在工具结果里 —— 引用时别把两者混为一谈），
   且不再出现「depth-2 + 162 工具」的孙代会话。
3. **跑脚本核对行数**（见步骤 2）。

### 步骤 1b · 复验深度判据加固（2026-09-13 复验后新增）
零成本、零联网，直接在 agent-lanes 会话里跑：

```bash
node scripts/verify-lane-role-presentation.cjs      # 期望 11/11 通过
```

它直接断言插件在**失败路径**上的行为（只记了 runtime 深度没记 header 的子代理、畸形深度、
缺 `ctx.tools`、`presentAs` 抛错）—— 那些路径会话日志**驱动不了**，却正是「子代理静默留在 PTC」
的入口。阴性对照（必须失败 5 项，否则断言是空转）：

```bash
LANE_PLUGIN_PATH=/tmp/lane-role-presentation.PREV.mjs node scripts/verify-lane-role-presentation.cjs
```

### 步骤 2 · 行为冒烟（跑脚本，零模型成本）
在 agent-lanes 会话里派 1~2 个角色子代理（例如一个 `explorer`、一个 `oracle`），然后：

```bash
cd /Users/eric/Project/tests/dsh-plugins/cireric-dsh-agent-lanes
node scripts/verify-agent-lanes.cjs          # 只看本项目会话；--all 扫全部；--raw 打全工具名
```

脚本只读 `~/.dsh/sessions`（解压 JSONL），对每个会话报告 **角色 / 模型 / 模型可见工具面 / 是否仍是 PTC**，
并与脚本内的 `EXPECTED` 期望白名单比对，给 PASS / FAIL / WARN。判定依据是
`request/header` 事件里的 `header.tools` —— 那是**真正发给模型的**工具面：
native 子代理 = 白名单本身；PTC 子代理 = 只有 `run_code`。

期望结果（2026-09-13 实跑基准：主 agent + oracle + fixer 三行）：
- 主 agent → `✓ 主 agent 保持 PTC（预期）`
- 每个角色子代理 → `✓ PASS native + 白名单精确匹配（N 项）`，**并带一行
  `⊘ 已知自身层泄漏（非白名单问题）: list_subagent_models, subagent`**
  —— 这是**已知且已定位**的现象（§7.7），**不是**白名单写错，也**不是**能用 `deny` 或插件式挂载修掉的。
- 边界感：`oracle` 工具面含 `explorer, librarian`、**不含 `fixer`**；`fixer` 工具面不含任何角色工具。

### 步骤 3 · 只有全绿才算 v1 成立 — **2026-09-13 已全绿**
任何 FAIL 都按 §5 排障表处理。**改完 preset 要开新会话才生效**（见 §4）。

## 3. 产物清单

| 路径 | 作用 |
|---|---|
| `preset/agent-lanes/agent.cordis.yml` | 组合：官方 `ptc` preset **逐字复制**作底座 + `persona.prefix` 补丁 + 末尾 `agent-lanes additions` 段（4 个角色行 + 插件行）。**偏离逐字复制处共两处**：①`tool-subagent` 行加 `maxDepth: 1`（理由见该行注释与 §7.7）②插件行 `name:` **不带引号**（带引号会让 `dev_reload_preset` 静默空转，见 §4），故该行会带 `?v=N` |
| `preset/agent-lanes/lane-role-presentation.mjs` | **零 import** 插件：`agent/created` 时把「`delegationDepth >= 1`（按框架口径 `Math.max(header, options.subagentDepth)` 解析）**或** `origin === 'subagent'`」的 agent 切 `native`；畸形深度、缺 `ctx.tools`、`presentAs` 抛错都**响亮告警**（§7.10） |
| `scripts/verify-lane-role-presentation.cjs` | 插件的**单元校验**（零成本 / 零联网 / 零模型）：11 条断言覆盖编排器不翻转、子代理翻转、以及四条失败路径。带阴性对照开关 `LANE_PLUGIN_PATH`（指旧版必须失败 5 项） |
| `preset/agent-lanes/personas/*.md` | orchestrator + explorer/librarian/oracle/fixer 的 persona（由 `!!js` 相对组合目录读取） |
| `preset/agent-lanes/preset.yml` | 选择器显示名/描述 |
| `scripts/verify-agent-lanes.cjs` | 行为冒烟脚本（§2 步骤 2）。对两个**已知自身层泄漏**工具容忍并**显式标注**（`KNOWN_SELF_LAYER`），不并进 `EXPECTED` —— 并进去等于把泄漏定义成期望，将来第三个泄漏会被当成正常 |
| `docs/evidence/` | 三份原始输出 + 复现方法：两份一次性探针（restrict 作用域语义、provider 注册表）+ 一份冒烟证据（自身层泄漏与孙代升级，含 5 个真实会话的 header / 工具面） |
| `README.md` | 面向人的说明：角色表 / 安装（软链）/ 使用 / 验证 / 约束 |
| `AGENTS.md` | 面向 agent 的项目约定（**会自动加载**）：硬约束、常跑命令、四个必踩的坑 |
| `docs/decisions/0001-role-preset-over-orchestration-bundle.md` | ADR：为什么从「编排 bundle」转向「角色 preset」、为什么子代理必须 native、被否决的替代方案。**旧的 bundle 设计正文已删除，依据保留在这份 ADR 里** |

## 4. 开发循环（改 preset 怎么生效）

preset 源码在本仓库；DSH 通过 `~/.dsh/.agent-presets/agent-lanes/` 读取，而那里是
**真目录 + 内部软链**指向本仓库：

```bash
mkdir -p ~/.dsh/.agent-presets/agent-lanes && cd ~/.dsh/.agent-presets/agent-lanes
R=~/Project/tests/dsh-plugins/cireric-dsh-agent-lanes/preset/agent-lanes
ln -s "$R/agent.cordis.yml" agent.cordis.yml
ln -s "$R/lane-role-presentation.mjs" lane-role-presentation.mjs
ln -s "$R/preset.yml" preset.yml
ln -s "$R/personas" personas
```

- 改 `agent.cordis.yml` / `personas/*.md` → **新会话自动生效**（yml 每次新会话重读）。
- 改 `lane-role-presentation.mjs` → 先 `dev_reload_preset preset=agent-lanes`（给 `.mjs` 引用 bump `?v=N` 绕 ESM 缓存），**再开新会话**。
  - ⚠️ **该工具的匹配规则要求引用不带引号**：它按
    `/(name: \.\/[A-Za-z0-9._-]+\.mjs)(\?v=\d+)?/g` 匹配 `~/.dsh/.agent-presets/<preset>/agent.cordis.yml`，
    写成 `name: './lane-role-presentation.mjs'` 时**永远匹配不到**，工具会回「无相对 .mjs 引用（无需热更新）」
    然后**什么都不做** —— 主机的 ESM 缓存继续把**旧代**插件发给每个新会话，而你以为已经热更新了
    （2026-09-13 实测踩中）。改完请确认输出里有 `lane-role-presentation.mjs -> ?v=N`。
  - 期望输出形如：`[agent-lanes] lane-role-presentation.mjs -> ?v=1`。
- ⚠️ **不要**把整个 preset 目录做成软链：发现逻辑用 `readdir(withFileTypes)` + `isDirectory()`，
  目录软链会被**静默跳过**（不报错，只是找不到）。

## 5. 排障表（症状 → 原因 → 修法）

| 症状 | 原因 | 修法 |
|---|---|---|
| 选择器里没有 `agent-lanes` | 软链没建；或把**目录**做了软链（被静默跳过）；或缺 `agent.cordis.yml` | 确认 `~/.dsh/.agent-presets/agent-lanes/` 是**真目录**且内部 4 个软链在位 |
| mount 报错指向 `persona` 行 | `!!js` + `baseUrl` 在 preset 组合里未生效（本方案唯一未实测的机制点） | 把 5 份 persona 文本**内联**进 yml 的 `prefix` / `persona`（literal block），删掉 `!!js` |
| mount 报错指向 `role-*` 行 | `toolFilter.allow` 里有**未知名**（工具改名 / MCP server 变更） | 按 live 工具面核对后改白名单；未知名**响亮失败**是有意设计 |
| 子代理派出去就报错 | 两种：①model 不在 provider 实时目录 ②模型**不支持**所声明的 `reasoningEffort`（实测 explorer 栽在②） | **先看报错原文**：`does not support reasoning effort "X"` ⇒ 删掉该 effort 或改用该模型支持的档（支持表＝provider `lib/index.js` 的 `KNOWN_EFFORTS` / `KNOWN_THINKING_MODELS`）；`route ... is not allowed for this Session` ⇒ 是**模型侧显式选择**撞了 Session 白名单，见 §7.8。⚠️ 真正生效的模型目录**不是** `llm-commandcode.visibleModels` —— 按旧写法改那里不会有任何效果 |
| 脚本报 `✗ FAIL 子代理仍是 PTC` | 插件没生效 —— **本 preset 概率最高的失效模式**：`lane-role-presentation` 行没挂上 / `.mjs` 软链失效 / ESM 缓存未 bump | ①按本表首行核对 4 个软链在位且父目录是**真目录** ②`dev_reload_preset preset=agent-lanes` 后开新会话 ③**别去查日志**：实测 `ctx.logger.warn` 在本部署**没有落盘通道**（见 §7.9）——**本脚本的输出就是那条数据面信号** |
| 子代理工具面比白名单**多**（实测恰好是 `subagent` + `list_subagent_models`） | 这两个工具被注册进了**该 agent 自己的 scope 层**（根源＝preset 的 `tool-subagent` 行设了 `modelSelectionSettings: true`），而自身层注册插在掩码循环之后 | **掩不掉**：实测 `deny` 与插件式挂载**同样无效**，别在这上面花时间。脚本已容忍并显式标注（`KNOWN_SELF_LAYER`）。要彻底消除**只能**把该行改成 `modelSelectionSettings: false`（代价＝编排器通用 `subagent` 失去模型侧选择参数） |
| 只读角色竟然派出了子代理 / 出现「depth-2 + 162 工具 + orchestrator persona」的孙代会话 | 通用 `subagent` 工具泄漏到子代理面，且该行**未**显式配 `maxDepth` —— 其默认值是 **3**（源码 `packages/subagent/tool-subagent/src/index.ts:129` `.default(3)`），故 depth-1 角色最远能派到 depth **3**（见 §7.7） | 已修（2026-09-13）：`tool-subagent` 行加 `maxDepth: 1`（3 → 1）。若再现，先确认该行是否被改回、或 `maxDepth` 被删 |
| oracle 能看到 `fixer` | oracle 的 allow 被改过，或 fixer 行不在同一 preset | 核对 `role-oracle.config.toolFilter.allow` |
| 子代理 schema 里能看到 `sandbox_permissions` / `justification` | **不是缺口**（2026-09-13 查明，原先这行写的「fixer 反复报参数校验错误」在本机 **91 个会话里零证据**）。事实链：①子会话带持久事件 `approval/policy {"policy":"never","source":"delegation"}` ②`never` 在 `decide()` 里**先于任何 answerer** 就返回 `rejected`（`user-approval/src/index.ts:268`）⇒ 既不可能弹给用户、也不可能提权成功 ③子会话 runtime context 明说「do not set `sandbox_permissions`」，实测派 fixer 去提权，它**引用这句话拒绝发起**（原文见证据 §6）④该字段按 **composition** 决定是否 advertise（`tool-bash/src/index.ts:192` `escalationModes`），**没有 per-agent 隐藏属性的钩子**（`tools/*` 只有 pre-execute / execute / post-execute / ptc-dispatch-log / result / change） | **不做 sandbox-strip** —— 那会为一个从未发生过的失败新增一个**能误伤编排器合法提权**的 pre-execute 监听。改为**检测**：`verify-agent-lanes.cjs` 统计真实提权请求数；只有角色子代理**持续非零**时才值得实现（当前 0） |
| 改了 `.mjs` 没变化 | 未 bump `?v=`，ESM 按 URL 缓存 | `dev_reload_preset preset=agent-lanes` 后开新会话 |
| `dev_reload_preset` 回「**无相对 .mjs 引用（无需热更新）**」 | yml 里插件引用**被引号包住**（`name: './x.mjs'`），该工具的匹配规则只认**裸** `./x.mjs` —— 于是它静默空转，旧代插件继续被新会话使用 | 去掉引号（`name: ./x.mjs`）再跑；确认输出含 `x.mjs -> ?v=N`（§4） |
| 插件单元校验有 FAIL | 深度判据被改坏：它必须同时认 `Math.max(header, options.subagentDepth)` 与 `origin === 'subagent'`，且畸形深度要告警但**仍然**翻转 | 读 `scripts/verify-lane-role-presentation.cjs` 的断言名（§7.10）；改回插件而非改断言 |

## 6. 不能违反的约束（用户价值观，违反要返工）

- **不修改官方框架**：`/Users/eric/Project/tests/deepseek-harness` 只读；修复一律在 preset/插件侧。
- **不 vendor 宿主内部代码**：不复制 `tool-subagent` 之类实现（第三方为此维护了 572 行副本，我们明确不跟）。
- **插件零 import**：preset 目录在用户 home 下，Node **无法**解析 `@deepseek-ai/*`；第三方用
  `npm root -g` + createRequire 绕开，我们不引入这种脆弱性。新插件只依赖 `ctx` / `agent` / Node 内置。
- **只用公开 API**，失败要**可见**（`logger.warn`，禁止空 catch / 禁止静默跳过）。
- **装新依赖前**跑 `plugin_check`，装后 `security_audit` 并与基线 diff。
- 本目录**不是 git 仓库**；删除不可逆，动手前先确认。

## 7. 关键机制（改之前必须知道，都是踩过的坑）

1. **`maxDepth` 是子代理绝对深度上限**：`childDepth = parentDepth + 1`，超过就抛 `SubagentDepthError`。
   主 agent 深度 0 ⇒ **`maxDepth: 0` 会让它一个子代理都派不出去**。当前取值：
   explorer/librarian = `2`（oracle 在深度 1 也要能派它们），oracle/fixer = `1`。
2. **叶子性不能靠 `maxDepth` 表达**（一个工具实例服务所有调用深度）——靠 **allow 白名单不含任何角色工具名**。
3. **`@deepseek-ai/dsh-persona` 的字段是 `prefix`（必填），没有 `text`**（0.1.3-alpha.2 改名）。
4. **表现模式翻转必须在 `agent/created`**：一步的 prompt/工具装配发生在 `agent/pre-step` **之前**
   （`agent-loop/src/agent.ts:245` 早于 `:249`），在 pre-step 里改 mode 要下一轮才生效。
5. **子代理继承父的 preset 组合**（`composeFrom` → `bindScopeParent`），所以 preset 声明 PTC 时
   子代理默认也是 PTC —— 这正是插件要修的东西。
6. **`run_code` 是保留传输**：`tools.restrict()` 拒绝命名它，任何白名单都删不掉；它跑在宿主进程的
   worker 里、有 `fs`/`child_process`，**绕过 DSH 文件沙箱**。所以 PTC 下「只读角色」不成立——
   这就是整个 native 翻转的动机。

7. **自身层泄漏：`toolFilter` 掩不掉「本 scope 自己注册的」工具。** `view()` 先对**继承面**套限制，
   再把该 scope 自身层的注册**原样插入**（`core/tools/src/index.ts:1166-1172`，注释原文
   "The scope's own registrations last … outside the filter above"）—— 所以 `allow` 白名单只能遮蔽
   继承来的工具，`deny` 也一样。这个坑的来源很具体：preset 的 `tool-subagent` 行设了
   `modelSelectionSettings: true` ⇒ tool-subagent 走 standing scoped install
   （`packages/subagent/tool-subagent/src/index.ts:663-680`），对组合内**每个 agent**（编排器与每个
   角色子代理）把 `subagent` 与 `list_subagent_models`（同文件 `:362`）注册进**各自的 scope 层**。
   同组的 `subagent_fork` 不走这条路径，只作为继承面存在，因此被**正确遮蔽** —— 这也解释了
   「为什么恰好只有这两个工具多出来」。**危害**：泄漏的通用 `subagent` 既无 `toolFilter`、当时也无
   `maxDepth`，于是深度 1 的 oracle 派出了 3 个 depth-2 孙代，各 **162 工具 + orchestrator persona**
   （原始证据：`docs/evidence/2026-09-13-subagent-boundary-leak.json`）。**现缓解**：该行 `maxDepth: 1`（2026-09-13 复验实测：depth-1 的 oracle 再派 → 工具面回传朴素文本
`Error: subagent depth 2 exceeds maxDepth 1`；`SubagentDepthError` 是真实类名（`child-agent.ts:32`），
但**不穿过工具面**）。

8. **角色行的模型路由不受 Session 白名单约束。** `~/.dsh/settings.yaml` 的
   `subagent-model-selection.allowedModels`（默认 `enabled: false`、`allowedModels: []`）只校验
   **模型侧显式选择** —— `assertAllowedModelSelection` 在 `hasDelegationModelRequest(request)` 为假时
   直接 return；角色行写在 `agentOptions` 里的 provider/model 走 `llm.resolveCallConfig` 的
   **真实目录 + effort 校验**。排障顺序因此是：provider 实时目录
   （`~/.commandcode/models-cache.json`）→ effort 支持表（provider `lib/index.js` 的
   `KNOWN_EFFORTS` / `KNOWN_THINKING_MODELS`）→ 最后才考虑 Session 白名单。

9. **`ctx.logger.warn` 在本部署没有落盘通道。** 实测三证：`~/.dsh/logs` 不存在；穷举 30 种
   session 事件类型，**没有任何 log / warn / error 事件**；harness `apps/cli/src` 无日志文件 sink。
   所以「失败必须可见」（AGENTS.md 硬约束 #4）**不能靠日志兑现** —— 要可见，失败就得进入
   **数据面**（会话事件 → 脚本判定）。`verify-agent-lanes.cjs` 的 `✗ FAIL 子代理仍是 PTC` 就是这条
   链路可用的信号；插件里的 `logger.warn` 只在前台终端的 stderr 上可见，事后不可回溯。
   **含义**：「插件整代缺席」这一最高概率失效模式，在数据面上**可查**（脚本会 FAIL），
   在日志上**不可查** —— 排障请走脚本，别走日志。

10. **翻转插件的深度判据：对齐框架口径，再叠一层 `origin` 兜底。** 框架的权威口径是
    `Math.max(session.header.delegationDepth ?? 0, options.subagentDepth ?? 0)`
    （`packages/subagent/subagent/src/depth.ts:28-36`；header 是**单调下界**，runtime 只能加深）——
    首版插件只读了 header。今天两者同源自 `resolveChildDepth`（`child-agent.ts:49`）故**等价**，
    但任何「只记 options、不记 header」的创建路径都会让真子代**零告警地留在 PTC** = `run_code` 逃逸。
    现插件四层：①按上面的 `Math.max` 解析 ②再认 `origin === 'subagent'` 兜底（`childSessionMeta`
    把 origin 与深度写在同处，`child-agent.ts:138-156`）③`options.subagentDepth` 畸形时告警并退回
    header（框架在此抛 TypeError；插件选「响亮告警 + 仍翻转」而非静默）④深度 0 但 origin 是子代理时
    告警。断言：`scripts/verify-lane-role-presentation.cjs`（11 条；旧版作阴性对照必须失败 5 项）。
    钉住这条是因为**翻转本身就是安全边界** —— 判据写窄了插件就悄悄失效，而日志在本部署不可回溯（§7.9）。

## 8. 决议记录（2026-09-13 复验通过后落定）

原先「等 §2 步骤 1 复验通过再定」的三项已全部决出：

1. **D · ADR 口径** — **已改**。`docs/decisions/0001` 状态行 →「已实现并**复验通过**」并挂证据指针；
   待办行删掉已完成的装配冒烟。
2. **F · librarian 的 effort** — **保持 `low`**。依据是复验时的实际检索质量：它给出的答案正确且有
   权威来源（`process.getBuiltinModule` 见 Node v22.3.0 / 回移 v20.16.0，Stable(1)），未见掉档；
   `low` 又是该模型（`z-ai/glm-5.3-flash`，仅支持 `low|high|max`）的便宜档。要更强再改 `high`（yml 一行）。
3. **G2 · 翻转插件的深度判据** — **已加固**（§7.10）并补了单元校验脚本；顺带修掉了 §4 里
   「`.mjs` 引用带引号 ⇒ `dev_reload_preset` 静默空转」的坑。⚠️ 这两项**要新会话才算生效 / 才可验**：
   `?v=` 已 bump 到 `?v=1`，新会话挂新一代。

仍未做（与复验无关，另起一轮）：

- ~~**sandbox-strip**~~ — **2026-09-13 结案：不做**。原判断（「已知缺口，子代理乱填会烧 turn」）经取证推翻：
  子会话的 `approval/policy` 是 `never` 且**先于任何 answerer** 拒绝，提权通道构造上关闭；91 个会话零证据；
  且没有 per-agent 隐藏 schema 属性的钩子。改为在 `verify-agent-lanes.cjs` 里**持续检测**（当前角色子代理 0 次）。
  完整证据与反例边界见 §5 表该行 + `docs/evidence/2026-09-13-sandbox-escalation-closure.json`。
- **skills 细粒度分发**：推迟到 v1.1。

> 原先的 E 项（3 处 preset 改动的运行时验证）就是 §2 步骤 1，已完成，不重复登记。
