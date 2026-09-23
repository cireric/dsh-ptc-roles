# 证据归档（ptc-roles）

> 各探针的原始输出与复现方法在下方分节；**逐轮验证记录 / 结清状态**见文末「附 · 轮次与结清状态」。
>
> ⚠️ 部分 2026-09-13 的记录里引用了 `HANDOFF §x` —— 那是**文档重构前**的旧引用。那些内容今天在
> `docs/pitfalls.md`（机制 / 坑 / 排障）与 `docs/decisions/0001`（决策）里。**记录本身不改**（历史原样）。
>
> 另外：**2026-09-13 第 6 轮**把角色 `fixer` 改名为 `implementer`，所以旧记录里的 `fixer` 即今日的 `implementer`。
>
> **2026-09-14 改名**：preset 由 `agent-lanes` 更名为 `ptc-roles`（项目目录 `cireric-dsh-agent-lanes` → `cireric-dsh-ptc-roles`）——
> 下列记录里的旧名与旧路径（`preset/agent-lanes/…`、`scripts/verify-agent-lanes.cjs` 等）是**改名前的原件名**，不改写、保持原样。

本目录的 JSON 都是原始输出（①–⑥ 是 2026-09-13 的探针与冒烟证据，⑦⑧ 是第 4/5 轮的改动记录，⑨ 是 2026-09-14 的**宿主内**结清验证，⑩ 是 2026-09-15 的**新 id + 看门狗**宿主内验证，⑪ 是同日**意图门失败记录与可复现性**，⑫ 是同日**第二代（`?v=4`）宿主内验证**，⑬ 是同日**角色派发补全**（`librarian` / `oracle`），⑭ 是同日**对复审报告 v3 的复核**；**⑯** 是 2026-09-17 的**意图门口径改造（① 存在档）落地实测**，**⑰** 是 2026-09-21 的闸门拒绝读数与模式标记，**⑱** 是 2026-09-23 的**闸门账**），**只读证据**，不需要重跑就能复用结论。**⑮ 例外**：`2026-09-17-review-v4.md` 是代码评审快照
（Markdown，非探针 JSON），结论附可复跑命令。

## 1. `2026-09-13-restrict-scope-and-presentAs.json`

**它证明了什么**：`toolFilter`（即 `ctx.tools.restrict()`）在 **agent 作用域** 上按 allow 语义精确生效；未知名会响亮抛错；disposer 能还原。

| 字段 | 值 | 含义 |
|---|---|---|
| `agentScopedTotal` | 157 | agent 作用域可见工具数（宿主平面是 131；多出的是 preset 作用域工具如 read/bash） |
| `agentScopedMcpCount` | 81 | 其中 MCP 工具数 → 角色的 MCP 白名单可命名 |
| `bogusErrorHead` | `names unknown global tool ...` | 反例控制：未知名**在施加前抛错**（零副作用）——这也是「白名单写错会让子代理启动/挂载失败」的原因 |
| `allowNames` | 5 个白名单项 + `run_code` | **正例**：allow 语义精确，但 `run_code` 是保留传输、删不掉（PTC 逃逸的根源） |
| `denyMcpRemoved` / `restoredOk` | true / true | deny 语义与还原都正常 |

**怎么得到的**（复现方法）：注入一个零依赖探针插件，在 `tools/result` 事件里取 `exec.agent`，然后对 `agent.ctx.tools` 依次执行 `schemas(agent)` → `restrict({allow: bogus})`（捕获报错）→ `restrict({allow: [...]})` → `schemas(agent)` → `dispose()`。关键点：`schemas()` **不带 scope 参数返回的是全局视图（131）而不是该 agent 的视图（157）**，必须传 `agent`。

## 2. `2026-09-13-subagent-provider-registry.json`

**它证明了什么**：宿主里 `spawn` 与 `fork` provider 都已注册且能力全开，所以角色工具行（`provider: spawn`）可以挂载。

`spawn` / `fork` 的 `capabilities` 全部为 `true`（agentOptions / outputSchema / depthLimit / toolFilter / persona）；`acp` / `codex` / `claude-code` / `dsh-sdk` 均未注册——因此「用进程外 provider 承载只读角色」这条路在本机不可走，且 `dsh-sdk` 也只支持 agentOptions（带不过 persona/toolFilter）。

**怎么得到的**：注入一个只做 `ctx.inject(['subagents'], c => ...)` 的探针插件，遍历 `c.subagents.getProvider(name)`。

## 3. `2026-09-13-subagent-boundary-leak.json`

**它证明了什么**：子代理可见工具面比 `toolFilter` 白名单**多两个工具**（`subagent` + `list_subagent_models`），
且该泄漏已被**实际利用** —— 深度 1 的 oracle 用泄漏的 `subagent` 派出了 **3 个深度 2 的孙代**。

| 字段 | 值 | 含义 |
|---|---|---|
| `sessions[].toolCount`（oracle / fixer） | 8 / 10 | 白名单 6 / 8 项 **+ 2 项泄漏** |
| `sessions[].toolCount`（3 个孙代） | **162** | 无角色 persona、无白名单，拿到全量工具面 |
| `sessions[].hasOrchestratorPersona`（孙代） | true | 孙代继承的是 **orchestrator** persona，不是角色 persona |
| `sessions[].parentSession`（孙代） | `5c6ca372…`（oracle） | 升级链：orchestrator → oracle → 孙代 |

**根因**：preset 的 `tool-subagent` 行设了 `modelSelectionSettings: true` ⇒ tool-subagent 走 standing
scoped install（`packages/subagent/tool-subagent/src/index.ts:663-680`），把这两个工具注册进**组合内每个
agent 自己的 scope 层**；而自身层注册插在掩码循环之后（`core/tools/src/index.ts:1166-1172`），故
`toolFilter.allow` **掩不掉**（`deny` 与插件式挂载同样无效）。同组的 `subagent_fork` 不走这条路径
→ 被正确遮蔽（本文件可验证：子代理工具面里没有它，这也解释了「为什么恰好只有这两个多出来」）。

**怎么得到的**（复现方法）：在 agent-lanes 会话里派一个 oracle，让它调用一次通用 `subagent`；然后跑
`node scripts/verify-agent-lanes.cjs --all`（孙代会出现在「跳过（非 agent-lanes 子代理）」里）。
本 JSON 由脚本读会话日志生成（`zstd -dc` + 解析 `session` / `request/header` / `system/message` 事件），
所以里面的数字是**实测**而非手抄。

**缓解**：`agent.cordis.yml` 的 `tool-subagent` 行加 `maxDepth: 1` —— depth-1 角色再派即 `2 > 1` 抛
`SubagentDepthError`。

## 4. `2026-09-13-v1-reverify.json`

**它证明了什么**：第 1 轮那三处修复（explorer / librarian 派不出去、工具面泄漏、孙代升级）**复验通过，v1 成立**。同一会话内并行派出 4 个角色子代理（explorer / librarian / oracle / fixer），全部 native 且工具面与白名单**精确匹配**。

| 字段 | 值 | 含义 |
|---|---|---|
| `fixesUnderTest[0].observed`（1a） | explorer 派发成功 | 不声明 `reasoningEffort` 后，LongCat-2.0:free 的 route preflight 通过（旧写法报 `does not support reasoning effort "low"`） |
| `fixesUnderTest[1].observed`（1b） | librarian 派发成功 | `reasoningEffort: low` 被 glm-5.3-flash 接受；且其回答**正确且有来源**（process.getBuiltinModule 见 Node v22.3.0 / 回移 v20.16.0，Stable(1)） |
| `fixesUnderTest[2].observed`（2） | `Error: subagent depth 2 exceeds maxDepth 1` | depth-1 的 oracle 真调了一次泄漏的 `subagent` → 被 maxDepth 挡住；**未产生孙代** |
| `snapshot.mainAgent` | `ptc=YES, tools=[run_code]` | 主 agent 保持 PTC |
| `snapshot.roleSurfaces` | 4/4 精确匹配白名单 + 2 项已知泄漏 | 角色边界成立：oracle 见 explorer/librarian、**不见 fixer**；fixer 不含任何角色工具；四者均无 `run_code` |
| `rawScriptOutput` 末行 | `汇总: ✓6 ✗0 !0` | 扫描 18 个会话的判定汇总 |

**孙代交叉核验**（`fixesUnderTest[2].sessionTimelineCrossCheck`）：3 个 depth=2 会话全部创建于 `09:01–09:02Z`，**早于** `BOUND_ADDED_AT = 09:10:48Z`（修复点），特征仍是 162 工具、无角色 persona —— 全部是修复前遗留；修复后（本会话 `09:31–09:32Z`）只新增 1 个 depth-0 主会话 + 4 个 depth-1 角色会话，**零新增 depth≥2**。

**一处口径更正**：工具面回传给子代理的报错是**朴素文本** `Error: subagent depth 2 exceeds maxDepth 1` —— 字符串 `SubagentDepthError` **没有**穿过工具面。数值语义（childDepth 1+1=2 > maxDepth 1）与文档一致，但引用时不要声称「子代理看到了 SubagentDepthError 这个类名」。

**怎么得到的**（复现方法）：在 agent-lanes 会话里并行派 explorer / librarian / oracle / fixer（oracle 的任务是**真实调用一次**通用 `subagent`），然后跑 `node scripts/verify-agent-lanes.cjs --raw`。原始输出逐字存于本 JSON 的 `rawScriptOutput`。

## 5. `2026-09-13-lane-role-presentation-hardening.json`

**它证明了什么**：G2 那次加固（决策见 `docs/decisions/0001-*.md`）**有效且非空转** —— 插件改用框架统一的深度口径后 **11/11 通过**，
而**旧版作阴性对照只有 6/11**（失败的 5 条恰好就是这次堵上的路径）。

| 字段 | 值 | 含义 |
|---|---|---|
| `sha256.current` | `408a8ca0…` | 加固后的插件；`assertions` 11 条全过 |
| `sha256.previousRevisionControl` | `eb123c76…` | 旧版：失败项里 `presentAs=0` 的正是「只记 runtime 深度 / 只记 `origin`」的子代理**静默留在 PTC** 的路径 |
| `findings[0]`（G2-a） | 判据 = `Math.max(header, options.subagentDepth)` + `origin === 'subagent'` 兜底 | 框架口径见 `subagent/src/depth.ts:28-36`；今天两字段同源自 `resolveChildDepth` 故**等价**，但只读 header 的写法在「只记 options」的创建路径上会**零告警**漏掉翻转 |
| `findings[1]`（G2-b） | `dev_reload_preset` 对**带引号**的 `.mjs` 引用静默空转 | 修前输出 `无相对 .mjs 引用（无需热更新）`；去引号后 `lane-role-presentation.mjs -> ?v=1` |
| `rawNegativeControlOutput` | `汇总: 6/11 … [exit 1]` | 阴性对照**必须失败** —— 否则说明断言是空转 |
| `sessionLogRegression` | `✓6 ✗0 !0` | 改插件后会话日志判定不变 |

**怎么得到的**（复现方法）：

```bash
node scripts/verify-lane-role-presentation.cjs            # 11/11（当前插件）
node scripts/verify-lane-role-presentation.cjs --control  # 6/11（冻结旧版对照，期望恰好 5 项失败）
dev_reload_preset preset=agent-lanes                      # 输出里必须出现 -> ?v=N
```

冻结旧版 = `scripts/fixtures/lane-role-presentation.prev.mjs`，sha256 `eb123c76…`（与本 JSON 的
`sha256.previousRevisionControl` 一致）。它**已入库**，所以阴性对照不再依赖 `/tmp`。


**⚠️ 关联已变动（2026-09-13 文档重构 + 2026-09-15 改名）**：本节的 `sha256.current`（`408a8ca0…`）记录的是**取证当时**的字节。
同日的文档重构为消除「外部文档引用 HANDOFF」而改了插件里的**一行注释**（`HANDOFF §8 G2` → 指向 ADR），
所以**取证当日的当前工作树 sha256 是** `cab14ad812715753860128b9881b533f832c65bf5888f9ef50737530bc1902f8` —— **行为完全不变**（纯注释）。
（`cab14ad8…` 是**取证当时**的字节，不是今天：`80b4f7d` 后来又重写了该文件的头部注释，
**2026-09-15 复审复核时实测为** `71cc58b4cf85a5ddd68562c1a5bddd906be14c9653bb13396b9419d5af673080`。
⇒ 本节所有 sha 一律读作「**取证当时**」，要今天的值就自己 `shasum -a 256 preset/ptc-roles/role-presentation.mjs`。）
含义：①这条关联的**时间点**是取证时，不是今天；②宿主仍按 `?v=1` 缓存着旧字节，
要让它吃到新注释需 `dev_reload_preset` + 新会话（HANDOFF 接手清单里那一步本来就会做）。

**⚠️ 冻结副本已改名（2026-09-15，`4b56202`）**：本节的 `negativeControlFixture`
（`scripts/fixtures/lane-role-presentation.prev.mjs`）随 preset 改名迁移为
`scripts/fixtures/role-presentation.prev.mjs` —— `git show --stat 4b56202 -- scripts/fixtures` 显示 **0 行变化**，
**sha256 仍是 `eb123c76…`**，与本 JSON 的 `sha256.previousRevisionControl` 一致 ⇒ 对照关系仍然成立（只是路径变了）。
本 JSON 的 `negativeControlFixture` / `howToReproduce` 字段按「冻结证据不改写」保留旧路径；上面这条是唯一的路径更正。
同理，`scripts/verify-lane-role-presentation.cjs` → `scripts/verify-role-presentation.cjs`、`preset/agent-lanes/` → `preset/ptc-roles/`。

**边界（别误读）**：这个单元校验不依赖宿主，所以**在本会话就能下结论**；但插件**在宿主里真正生效**
仍需**新会话**（`?v=1` 已 bump，已运行会话保持旧代）。要确认生效，新会话里派一个角色子代理，
再跑 `node scripts/verify-agent-lanes.cjs` 看它是否仍是 `ptc=no` + 白名单精确匹配。

## 6. `2026-09-13-sandbox-escalation-closure.json`

**它证明了什么**：排障表原先那条「sandbox-strip 缺口」**不成立** —— 子代理 schema 确实暴露
`sandbox_permissions`/`justification`（**暴露是真的**），但提权通道**构造上关闭**，原症状在本机**零证据**。
结论：**不做**这个守卫，改为**检测**。

| 字段 | 值 | 含义 |
|---|---|---|
| `findings[0]`（E1） | 暴露为真 | 字段按 **composition** advertise：`tool-bash/src/index.ts:192` `escalationModes`，所以子代理也能看到 |
| `findings[1]`（E2） | 子会话 `approval/policy {policy:'never',source:'delegation'}` | 持久事件可查；`decide()`（`user-approval/src/index.ts:268`）在**任何 answerer 之前**返回 `rejected` ⇒ 不可能弹给用户、不可能提权成功 |
| `findings[2]`（E3） | 无 per-agent schema 钩子 | `tools/*` 只有 pre-execute / execute / post-execute / ptc-dispatch-log / result / change —— 没有按 agent 改参数 schema 的事件；`restrict()` 只掩**整个工具** |
| `findings[3]`（E4） | 91 个会话、0 次子代理提权、0 条相关报错 | 原症状「fixer 反复报参数校验错误」**不可复现**；真实用例全是**编排器**的合法提权（如 492fe499 带 justification 改 `~/.dsh/AGENTS.md`） |
| `findings[4]`（E5） | 派 fixer 去提权 → 它**拒绝发起** | 逐字引用 NEVER_SENTENCE 与委派声明（原文在 `rawOutputs.refusalProbeReply`） |
| `decision.action` | `detection, not enforcement` | 见下 |

**为什么不做守卫（而不是「没时间做」）**：`tools/pre-execute` 里加一个「子代理带提权参数就 deny」的监听，
会引入**新的**失效模式 —— 匹配写错就可能 deny **编排器**的合法提权，而那种提权是**真实且被观测到的**
（证据里就有）；代价是真实的，收益是防一个**从未发生过**的失败（AGENTS.md：无失败记录则不设规则）。

**改为检测**：`scripts/verify-agent-lanes.cjs` 现在统计每个会话真实的提权请求数（只对 `bash/pwsh/edit/write`
**解析参数键**，不扫文本；seeded 子会话标 `(seeded)` 因为其计数含继承的父日志）。
**阳性路径已被证明**：`--all` 下其他工作区报 `esc=1..6`，不是空转。

**怎么得到的**（复现方法）：

```bash
node scripts/verify-agent-lanes.cjs            # 末尾两行：提权请求计数
node scripts/verify-agent-lanes.cjs --all      # 阳性对照：其他工作区应有非零 esc
zstd -dc ~/.dsh/sessions/<slug>/<id>/session.v3.jsonl.zstd | grep approval/policy   # never + source:delegation
```

**重开条件**：角色子代理的提权计数**持续非零** ⇒ 此时 pre-execute 守卫才成立（钩子与字段名已在
`findings` 里定位好）。

## 7. `2026-09-13-designer-and-platform-compat.json`

**它证明了什么**：①上游 `oh-my-dsh-slim` 确有的 `designer` 角色被本方案**静默丢掉**（无文档记录原因），
现按本方案 idiom **补全为第 5 个命名角色**；②`fixer`/`designer` 的 shell 由硬编码 `bash` 改为
**平台择一**（win32=`pwsh`）。**根因与依据**都记在 `why` / `upstreamDesigner` 两节（含上游 6 角色清单、
A 版 70 行 design 宣言 vs B 版 5 行规划 persona 的取舍理由）。

| 字段 | 值 | 含义 |
|---|---|---|
| `mechanism.answer` | `YES` | `!!js` **可以**做**序列元素**（`toolFilter.allow` 的一项），不只是标量行字段 |
| `mechanism.loaderSource` | 3 条 | `vendor/include/src/index.ts:9`（tag 定义）+ `cordis-plugin-loader/lib/index.js` 的 `interpolate()` —— 其中 `Array.isArray(value) → value.map(interpolate)` 就是数组元素被求值的证据 |
| `mechanism.quotingTrap.unquotedResult` | `{'[object Object]':'bash'}` | **陷阱**：不带引号的 `? … : …` 是**合法 YAML**，但解析成**复合 mapping key**，静默产出**非字符串** allow 项 |
| `mechanism.quotingTrap.quotedResult` | `['read','bash','lsp']` | **正解**：带引号才得到表达式节点；写法同 `presets/cordis/agent.cordis.yml:260` |
| `verifiedThisRound` | 6 条 | 真 yml **过软链**解析 + **全部 `!!js` 求值成功**、25 行、五个角色 allow 实测值、`node --check` 通过、全仓库平台点审计 |
| `notVerifiableThisRound` | 3 条 | 宿主是否挂载新角色行 / win32 分支 / 未知名拒绝的前提 —— **本轮都没测**，别当成已验证 |

**怎么得到的**（复现方法）：用 loader 自己的 js-yaml dialect（`vendor/include/src/index.ts:9` 的 `JsExpr` Type）
+ `interpolate()` 的复刻，读**软链后的真文件** `~/.dsh/.agent-presets/agent-lanes/agent.cordis.yml`，
打印每一行 `role-*` 的 `toolFilter.allow`。**宿主挂载**必须在**新会话**里验证：
工具面出现 `designer` → 派一个 → `node scripts/verify-agent-lanes.cjs` 应显示
`role=designer ptc=no` 且白名单精确匹配（6 项 + 2 项已知泄漏）。

**边界（别误读）**：本记录证明的是**机制与解析**；`designer` 这一行**从未在任何宿主里挂载过**，
所以它**尚未**出现在 §4/§5 那两份「实跑基准」里。macOS 上这次改动对 `fixer` 是**行为等价**的
（表达式求值仍是 `bash`），真正变化的只有 win32 分支。

## 8. `2026-09-13-orchestrator-discipline-port.json`

**它证明了什么**：核实「orchestrator 有没有 Sisyphus 纪律大脑」这个问题，并把**缺的那一层补上**。
①按 `cireric-oh-my-dsh-slim` spec §2.1 自列的「大脑四项」，本 preset 的 persona **4/4 全有**；
②按上游 `oh-my-openagent` **v4.19.4** 的**实际**提示词，还缺一层**操作性纪律** —— 本轮已移植 9 项
（见 `ported`），并**刻意不移植** 5 项（见 `notPorted`，含上游的 `Default Bias: DELEGATE` —— 本方案有意反向）。

| 字段 | 值 | 含义 |
|---|---|---|
| `upstreamVerification.commit` | `b072d2791…` | **与你 spec 引的 commit 一致**；且在 `origin/*` 里可达（不是本地伪造 tag） |
| `upstreamVerification.twoIndependentSources` | 2 条 | 本地 clone 的 `git show v4.19.4:` 与 librarian 的上游抓取**逐字互证** |
| `upstreamVerification.notAsingleFile` | 拼装式 | 由 4 个 `sisyphus-dynamic-prompt-*.ts` 按固定顺序拼接 + 12 个模型家族 body（10–32 KB） |
| `ported` | 9 项 | 5 段委派结构、结果验证、Anti-Duplication、3 连败恢复、Hard blocks、分类桶、完成清单、诊断证据门、Specialists 6 列表 |
| `notPorted` | 5 项 | 反向的 `Default Bias: DELEGATE`、`task(category/load_skills)`/skills/model-core/ultrawork、12 个模型分身、Tool Call Format、todo 强化 |
| `decisions.continuableNotOneShot` | `continuable` | spec §2.1(4)/§7.5 的 one-shot 行是孤例，已按上游 Session Continuity 对齐 |
| `measurements` | 40 行/3523 B → **75 行/7034 B** | persona 体积约翻倍（主 agent 每轮系统提示词，靠前缀缓存摊平） |

**怎么得到的**（复现方法）：`cd ~/Project/source/AI/oh-my-openagent && git rev-parse v4.19.4` 后逐文件
`git show v4.19.4:<path>` 读上游原文；再用 loader dialect 解析**软链后的真 yml** 确认 persona 仍能解析。
**宿主是否把新 persona 发给主 agent 必须开新会话**（本轮只到「解析 + 标记 + 脚本」这一层）。

**边界（别误读）**：本记录证明的是**移植了哪些条**与**上游原文长什么样**；它**不**证明这些纪律
会改变模型行为 —— **效用**是另一个问题，会话日志测不出来。

## 9. `2026-09-14-round4-5-6-in-host-verification.json`

**它证明了什么**：第 4/5/6 三轮的「**在宿主内是否生效**」不再是欠账 —— 三者的数据面信号全部为真，
验证债清零。这是本项目唯一一类**只能靠新会话**才能下结论的验证（部署无日志通道，见 #9）。

| 字段 | 值 | 含义 |
|---|---|---|
| `childSessions[1]`（designer） | `role=designer ptc=no tools=8` | **designer 首次在宿主里真的挂载**（白名单 6 + 2 已知泄漏）⇒ 证据 ⑦ 的边界关闭 |
| `childSessions[2]`（implementer） | `role=implementer ptc=no tools=10` | 第 6 轮改名在宿主内成立（白名单 8 + 2）；`--all` 无 `fixer` WARN 残留 |
| `findings[1]`（R5-a） | 脚本 `✓ 主 agent 载入 round-5 纪律 persona` | 第 5 轮生效；双证 = 脚本判定 + 编排器自读 system prompt 里的 6 列表与 `Delegation contract` |
| `findings[3]`（R1-a） | `Error: subagent depth 2 exceeds maxDepth 1` | maxDepth 缓解在宿主内**再次被真实触发**（explorer 调泄漏的 `subagent`），未产生孙代 |
| `crossChecks.deployedPresetIntegrity` | 4 软链 + 10 文件 sha256 与仓库**逐一相同** | 宿主读到的就是仓库里的；`.mjs` = `cab14ad8…`（= ⑤ 注释里记的**取证当时**的值；`80b4f7d` 后为 `71cc58b4…`，见 §5 的注记） |
| `crossChecks.allowlistDrift` | 5 角色 / 33 项 ↔ 33 项，零漂移 | #12 的漂移风险本轮实测为 0（工具是一次性的，见下） |
| `crossChecks.repoUntouched` | `M AGENTS.md` / `M HANDOFF.md`（本轮前既有） | 三角色产出全在 gitignore 覆盖的 `scratch/`；`README`/`docs`/`scripts`/`preset` mtime 未变 |
| `findings[4]`（OBS-a） | explorer 工具面无 shell ⇒ 做不了 `ls`/`shasum`，**如实报告而非编造** | 编排器任务规格写错；反过来是白名单生效的正面证据。**不给 explorer 加 shell** |

**怎么得到的**（复现方法）：在 agent-lanes preset 下开新会话，并行派 explorer / designer / implementer，
然后 `node scripts/verify-agent-lanes.cjs --raw`；单元校验见 ⑤ 的两条命令；部署一致性用
`ls -la` + `readlink` + `shasum -a 256` 对 `~/.dsh/.agent-presets/agent-lanes/` 与仓库同名文件各算一遍。
原始脚本输出逐字存于该 JSON 的 `rawScriptOutput`。

**边界（别误读）**：① 只证 **macOS 分支**，win32 分支仍不可测；② persona 那条**只证文本被载入、不证效用**；
③ `crossChecks.allowlistDrift` 用的检测器是 **gitignore 覆盖的一次性产物**（`scratch/check-allowlist-drift.cjs`），
**未入库**，所以不要把它当可复现资产引用 —— 真正的常设保障仍是「漂移即 FAIL」的行为脚本。

## 10. `2026-09-15-ptc-roles-in-host-verification.json`

> **⚠️ 已被证据 ⑫ 取代（代次维度）**：本节的宿主内观测**全部是 `?v=1` 那一代**（⑩ 记
> `intent-gate-watchdog.mjs` sha `1e35761f…`、单测 16/16）。此后插件已连跳数代
> （G-5 返工 → `?v=4`、2026-09-15 复审修订 → `?v=5`/`?v=6`），**当前代次**的宿主内证据在 **⑫**。
> ⑩ 的**结论仍然成立**（挂载、角色派发、白名单匹配是 id/白名单级事实，不随插件代次变化），
> 但**不要**用它的 sha 或断言数去核对今天的行为。按「冻结证据不改写」的纪律，本 JSON 原文不动，
> 更正只写在这一层。

**它证明了什么**：改名后的 preset id `ptc-roles` 在宿主内**真的挂载**、角色**真的能派出去且白名单精确匹配**、新交付的**意图门看门狗真的注入提醒** —— HANDOFF §1 的两项欠账（`ptc-roles` 这个 id 的宿主内证据 = 0、看门狗在宿主内零观测）就此清零。

| 字段 | 值 | 含义 |
|---|---|---|
| `session.presetSelectedEvent` | `ptc-roles` | 权威信号（`agent-preset/selected` 事件）；会话头字段 `agentPreset=standard` 是创建时默认值，**别拿它当证据** |
| `watchdogInjection.injectedMessageRawEvent` | `seq=212` / `source.kind=plugin` / `plugin=intent-gate-watchdog` | 逐字原始事件：注入发生在 `turn/start turn=2`（seq=208）之后，编排器在 turn 2 输入里实际读到（279 B，与插件 `REMINDER` 常量逐字相同） |
| `watchdogInjection.turn1MarkerHits` | `24 events / 0 hits` | 触发条件为真：turn 1 的 assistant 文本确实不含 markers |
| `childSessions[]` | explorer 5 / implementer 8 / designer 6 | 三者全部 `ptc=no` + 白名单精确匹配（另各 +2 项已知自身层泄漏，见 #7） |
| `crossChecks.sha256SameCount` / `DiffCount` | 10 / 0 | 4 个文件 + 6 个 persona 的 sha256 与仓库逐一相同 ⇒ 宿主读到的就是仓库这份 |
| `crossChecks.siblingPresets` | `["ptc-roles"]` | `~/.dsh/.agent-presets/` 下**只剩** ptc-roles ⇒ HANDOFF §1「运行时仍未切换」已过期 |
| `findings[3]`（P-4） | 全文 grep 67 ↔ 精确匹配 **1** | HANDOFF §2.4 给的取证命令**不可靠**（见边界） |
| `rawScriptOutput` | 5 条命令逐字 | 行为脚本 `✓4 ✗0 !0`；插件单测 11/11 与 **16/16（记录当时**的断言数；看门狗单测此后经 G-5 扩到 20/20、又于 2026-09-15 删 config.markers 降至 **17/17**），两条 `--control` 阴性对照按预期失败 |

**怎么得到的**（复现方法）：

```bash
node scripts/verify-ptc-roles.cjs --raw          # ✓4 ✗0 !0
node scripts/verify-role-presentation.cjs        # 11/11（--control 恰 5 项失败）
node scripts/verify-intent-gate-watchdog.cjs     # 记录当时 16/16；**当前期望 17/17**（--control 恰 9 条断言失败，判据为集合相等）
node scripts/verify-ptc-roles.cjs --all          # 阳性对照：其他工作区提权计数 20（非空转）

# 看门狗注入：turn 2 才可能发生（先让 turn 1 漏掉门行，再发一条真实用户消息）
S=~/.dsh/sessions/--Users-eric-Project-tests-dsh-plugins-cireric-dsh-ptc-roles--/session-ee97f96a-5187-427c-85fe-0f4395e9532f/session.v3.jsonl.zstd
zstd -dc "$S" | grep -m1 '"plugin":"intent-gate-watchdog"'                  # 就是那条注入
zstd -dc "$S" | grep -c '"kind":"plugin","plugin":"intent-gate-watchdog"'   # 1（精确判据）
zstd -dc "$S" | grep -c 'intent-gate-watchdog'                             # 67（**不可靠**，见边界；这是写记录时的快照，随会话继续增长）
```

**边界（别误读）**：
- **取证判据**：全文 grep 计数会被**工具结果**污染 —— 本会话里编排器 `read` 过插件源码、explorer 的任务报告又逐字引用了它，于是 67 里只有 1 条是真的注入。正确判据是**匹配消息的 `source` 字段**。
- **只证「注入发生」**，不证「行为因此改变」（效用不可由日志证明）。
- 看门狗的**观测侧**（`session/event` 记录上一轮是否命中）不落任何痕迹 ⇒ 只有「注入」可观测，「未注入」只能由缺失反推。
- 本轮只派了 explorer / implementer / designer 三个角色；`librarian` / `oracle` 两行的宿主内白名单**未验证**，win32 分支仍不可测。
- 顺带测到的机制事实：**子代理结算通知不新起轮次**（走 `agent/inbox/spliced`，`source.kind=subagent-settled`）⇒ 这类「机器轮」永远不满足看门狗要求的真实 user 来源，也就永远不触发它（设计如此）。

## 11. `2026-09-15-intent-gate-failure-record.json`

**它证明了什么**：①意图门「会静默衰减」这条失败记录成立（四个原始数字**引用自**看门狗头部注释与 HANDOFF §3④）；②但**那次审计已不可复现** —— 源会话不在会话库里了；③于是本文件改用当场可复现的产物，并把**合规率指标固化进** `scripts/verify-ptc-roles.cjs`（HANDOFF §3③ 同时落地）。

| 字段 | 值 | 含义 |
|---|---|---|
| `quotedRecord` | 26 轮 / 任意文本 3 / 可见回复 2 / **首行 0** | 标 `QUOTED`：本文件**没有**重测出这四个数字 |
| `reproducibility.scannedFiles` | 77 | 全库会话文件数 |
| `reproducibility.sessionsWithAnyGateText` | 3 | 全库只有 3 个会话出现过中文门行字面量或英文门行短语 |
| `reproducibility.topTurnCounts` | 28 / 21 / 18 … | **没有 26/27 轮的会话** ⇒ 审计源会话不在库中 |
| `reproducibility.storeSnapshot` | agent-lanes 工作区目录 mtime `2026-09-15 00:07:03`、仅存 1 个会话；5 个工作区目录为空 | 会话库是**滚动窗口**，不是归档 ⇒ 合规性只能当场测、测完落盘 |
| `measuredNow.currentSession.perTurn` | `T1-a T2+ra T3+ra` | 本会话逐轮：T1 漏 → 看门狗在 T2 提醒 → T2/T3 首行有门行（`+`=首行 / `r`=可见回复 / `a`=任意文本，含工具结果） |
| `measuredNow.silentPathObserved` | 全会话仅 1 条注入（seq=212） | 上一轮合规时**不再**提醒 —— 看门狗「沉默」分支的首次宿主内观测（对应证据 ⑩ 的 P-7） |
| `toolingDelivered.output` | `意图门合规率: 3 轮（会改变行为 3 轮）\| 首行命中 2/3 (67%) \| …` | 指标已进验证脚本（零模型成本，任何会话可重跑） |
| `findings[4]`（G-5） | 逐字的两条坏门行（`badGateLines`） | **marker 驱动的退化**：那两行含 turn 号 / 看门狗状态 / 证据文件名，**不含**用户要什么 ⇒ 修法是把这一行的读者写清楚（见下） |
| `upstreamReference` | `"I detect [bucket] intent - [reason]. My approach: [...]"`（`sisyphus/default.ts`，v4.19.4 与 HEAD **逐字相同**） | 上游自述用途 = *"makes your reasoning transparent to the user"*；**我们移植时丢了 `[reason]` 槽位** ⇒ 本次补回为「依据：」，并采纳 gpt-5-5 的「这一行是承诺，不是标签」与 grok-4 的「不照抄用户的话」 |

**怎么得到的**（复现方法）：

```bash
node scripts/verify-ptc-roles.cjs --raw      # 新增：单会话合规率 + 逐轮判定 + 全部会话合计
node scripts/verify-ptc-roles.cjs --all      # 同上，但扫全部工作区
# reproducibility 一节 = 遍历 ~/.dsh/sessions 下全部 .zstd，逐轮按三个口径统计（口径见该 JSON 的 method）
stat -f '%Sm %N' ~/.dsh/sessions/*agent-lanes*/   # 会话库快照：目录 mtime
find ~/.dsh/sessions -maxdepth 1 -type d -empty    # 空工作区目录
find ~/.dsh -name '*2982160d*'                     # 证据 ⑨ 引用的源会话：0 命中
```

**边界（别误读）**：
- 那四个原始数字是**引用**，不是本文件的测量结果：本文件能复现「口径」与「当下分布」，复现不了「当年那 26 轮」。
- 「源会话不在库里」是**事实陈述**：清理可能是人为的或策略性的，本文件没有证据判断原因（已列入 `notVerifiable`）。
- **真实缺陷 G-3（已修）**：persona 当时规定的门行形式是英文 `I detect … intent — my approach:`，而看门狗与合规率用中文 `意图判定` ⇒ 两处不同口径。**同日已修复**：persona 的 Phase 0 改成同一口径的 `意图判定` 并限定为「会改变行为的轮次」，看门狗与合规率同步；当天晚些时候又按上游原文补回 `[reason]` 槽位（终稿 `意图判定：<桶> — 你要的是 <结果>（依据：<…>）；我打算 <做法>`）—— 见轮次账本第 8、9 行。本段保留原始记录，不追改结论。
- **上游对齐（G-5 的修法依据）**：门行的原始出处是 Sisyphus `### Step 0: Verbalize Intent`，其自述用途是 *"makes your reasoning transparent to the user"* —— 与「门行要跟用户对齐」是同一条。kimi 的 `<re_entry_rule>`（确认轮不重发门行）**刻意未采纳**：它与本项目的数据面 eligibility 判据（只对会改变行为的轮次要求）口径不同，再引入一条语义规则会与唯一可自动核查的那部分冲突。
- 合规率只证「有没有输出门行」，**不证**「因此决策更正确」。
- **G-5 的边界（重要）**：插件**观测不到内容质量** —— 门行在、但内容是内部记账时它保持沉默（本轮 turn 2/3 正是如此）。所以这一层只能靠 prompt 侧（persona 与 REMINDER 写清「读者是用户」），**不做正则 linter**：判「这行是不是记账」没有可靠规则，误伤编排器合法用词的风险大于收益（同证据 ⑥ 否决 sandbox-strip 的理由）。

## 12. `2026-09-15-ptc-roles-generation4-in-host-verification.json`

**它证明了什么**：`?v=4` 那一代（G-3/G-5 返工后的 persona + 看门狗）**真的在宿主里跑起来了**，而且 eligibility 判据在真机成立 —— 证据 ⑩ 只验过**旧代**，此后新代的一切结论都还只是单测结论（单测证逻辑，不证挂载）。

| 字段 | 值 | 含义 |
|---|---|---|
| `generationProof.persona` | system/message 含 `align with the user before acting` 与 `你要的是`，**不含** `I detect` | 新 persona 就是模型实际读到的那份 |
| `generationProof.plugin` | 注入文本含新文案 `这一行的读者是`、不含旧文案 `适用于每一条用户消息` | 注入内容可反推**宿主实际加载的插件字节**（ESM 缓存已按 `?v=4` 换键） |
| `perTurn` + `injections` | turn 1 / turn 4（inner `bash`）漏行 ⇒ `seq=35` / `seq=81` 各注入一次；turn 6（inner `read`）漏行且该轮无 marker ⇒ turn 7 **无**注入 | **同一会话内对照**：行为轮提醒、只读轮不提醒 = eligibility 成立 |
| `method.confoundAndFix` | 第一版剧本让模型**引用**了「未输出意图判定行」⇒ marker 子串命中，eligibility 分支没被考到 | 方法学自纠：补一轮「只读且**不提** marker」才拿到干净对照 |
| `findings[4]`（H-5） | turn 2/3 只是**谈论**门行，就被计入「可见回复命中」 | marker 子串判据的已知弱点：判不出「输出」与「谈论」 |
| `rawScriptOutput` | 自测会话 `7 轮（会改变行为 2 轮）\| 首行命中 0/2 (0%)`；合计 `14 轮 / 9 个行为轮 / 6 命中` | 0% **是构造的结果**（我明令禁止输出门行），不是回归 |

**怎么得到的**（复现方法）：Playwright 驱动 `http://127.0.0.1:3080` → 新建会话 → 模式选择器选「PTC 角色模式」→ 按 `method.script` 的 7 条消息依次发送；判定只读会话文件（解 `turn/start` / `tool/ptc-dispatch` / `user/message(plugin)` / `assistant/message`），再跑 `node scripts/verify-ptc-roles.cjs --raw`。

**边界（别误读）**：
- 提醒的**效用**不可证（同 ⑩ / ⑪）。
- 该会话的 0% 合规率是**刻意构造**（用户消息里明令禁止输出门行）；与真实使用不能混读，脚本的合计口径把两个会话混在一起也只是**诊断值**、不是分数。
- 这个自测会话（`session-d701ad55…`）会出现在会话列表里 —— **它本身就是原始产物**，删它等于删证据。
- （原先此处列的 `librarian` / `oracle` 白名单债已由**证据 ⑬** 关闭。）

## 13. `2026-09-15-ptc-roles-role-dispatch-completion.json`

**它证明了什么**：五个角色行里最后两个（`librarian` / `oracle`）也能在宿主内派出去、`ptc=no`、工具面与白名单**精确匹配** —— 证据 ⑩ 里那条 `notVerifiable`（只派过三个角色）就此关闭。

| 字段 | 值 | 含义 |
|---|---|---|
| `roleLines.librarian` | `role=librarian model=z-ai/glm-5.3-flash ptc=no tools=10` | 白名单 8 项 + 2 项已知自身层泄漏（#7） |
| `roleLines.oracle` | `role=oracle model=deepseek/deepseek-v4.1-flash ptc=no tools=8` | 白名单 6 项 + 2 项已知自身层泄漏 |
| `childSessions[1].toolFace` | `read / grep / glob / lsp + explorer + librarian` | oracle **看得见、且仅看得见**它的两个只读下属；碰不到 `implementer` / `designer` / shell |
| `findings[2]`（R-3） | oracle 判定：`maxDepth: 1` 只在**能力层**堵死孙代，**呈现层**工具面仍多两个名字 | 「`toolFilter.allow` 即硬能力边界」这句在**呈现层为假** —— 不是新缺陷（#7 已记），是把口径说准 |
| `childSessions[0].taskOutcome` | `process.getBuiltinModule` = **v22.3.0**、回移 **v20.16.0**、Stable | 与证据 ⑧ 早前那次同题探针**逐项一致**（独立复现） |
| `rawScriptOutput` | `汇总: ✓8 ✗0 !0` | 8 个会话（2 个主 agent + 6 个子代理）零 FAIL |

**怎么得到的**（复现方法）：在本会话（旧代挂载；角色行与角色 persona 本轮未改动）并行派 `librarian`（查 Node 官方文档的版本事实）与 `oracle`（只读评估 `maxDepth: 1` 的缓解是否足够），再跑 `node scripts/verify-ptc-roles.cjs --raw`。原始输出逐字存于该 JSON 的 `rawScriptOutput`。

**边界（别误读）**：
- `verificationGap`：oracle 结论里「泄漏的那份注册沿用该行 config 的 `maxDepth`」是**它的推断**（它没读 standing scoped install 的实现）—— 本记录只记录角色说了什么，**不主张**该推断成立。
- 两个角色是从**旧代挂载**的会话派出去的；角色行与角色 persona 本轮未改，故这一条对两代同效（新代改的是 orchestrator persona 与看门狗）。
- 角色任务的**答案质量**只记录「它答了什么」，不构成效用证明。

## 14. `2026-09-15-review-v3-recheck.json`

**它证明了什么**：对 `CODE-REVIEW-2026-09-15.md`（复审修订 v3）的一次**对评审的评审** —— 它的部分裁定站得住，但有两条「✅ 已落地」不成立，且它的证据有一半只活在滚动会话窗口里。本文件是那份快照的**证据承继者**（快照按它自己的建议已删除，原文冻结在 `supersededDocument`）。

| 字段 | 值 | 含义 |
|---|---|---|
| `rulingsRecheck` | R-01…R-13 逐条 verdict | R-01/03/06/07/08/10/13 成立；**R-02 半成立**（只打印不进判据，本轮补牙）；**R-04 落地声明为假**；**R-05 半落地**；R-09 成立但基数失效；R-11/R-12 本轮补强举证 |
| `findings.F1` | `HANDOFF.md:24` 至今仍写「冻结件按设计保留原名」 | `git log -S` 只命中 `4b56202`（引入该串），`git show --stat 9a9df36` 只有 2 个文件、**没碰 HANDOFF** ⇒ v3 的「该句不再存在」是假声明（成因见 `F5`：落地栏的提交归属马虎） |
| `findings.F2` | `docs/evidence/README.md:110` 的 sha 现在时断言过期 | R-05 修了同段「路径」的现在时，漏了 13 行之上的「sha」；实测当前 = `71cc58b4…`（`80b4f7d` 重写注释所致） |
| `findings.F3` | 归因计数器无牙 | `unattributable > 0` 只打印 ⇒ 归因失明也 exit 0；阳性路径原是一次性合成，现已补 fixture |
| `findings.F6` | 合规率同一个词有四个数（8% ~ 85%） | 口径 + 窗口不同 ⇒ 已在 `docs/pitfalls.md` **#19** 立唯一口径登记处 |
| `commandsRerun` | 五条命令逐字判定行 + exit | 全部与 v3 的 §3 基线一致（含 `--control` 的判定行） |
| `positiveControls.attributionCounter` | 伪造 HOME 造会话 ⇒ `✗ FAIL 不可归属的 tool/ptc-dispatch: 1`、exit 1 | F3 的端到端阳性对照（fixture 那一侧另用「期望改成 99」证明断言不空转） |
| `approvalChain` | 三次 `ask_user_question` 的 `answers` 逐字（seq 468 / 1268 / 1418） | R-11「越权不成立」的原始凭证；**v3 只提了其中两次** |
| `generationHistory` | `?v=2/3/4` 与 `lane-role-presentation ?v=1` 可从两份会话日志复现 | R-12 的原始凭证；同时记下 `?v=5`/`?v=6` **仍无宿主内证据** |
| `evidenceBaseDecay` | 四条「只能当场测」的证据基数一览 | R-09 的 30 轮基数已消失、R-02 的阳性路径从未入库 —— 下一轮别再重复这个坑 |

**怎么得到的**（复现方法）：并派三条独立核查线（三套脚本逐条复跑 / git 考古逐条验证 / 活文档一致性），再对**互相矛盾**的两份结论自己重跑仲裁 —— 关键证法见 `howToReproduce`（`git log -S` 与 `shasum` 两条各自钉死 F1/F2）。

**边界（别误读）**：
- 本文件**不主张**「v3 的裁定都错」：多数裁定复跑后成立，这是对它的正面结论。
- F1 的定性是「提交记录里没有那个动作」，不是指控动机；最可能成因是落地栏的归属马虎。
- `supersededDocument.content` 是**冻结原文**，只作历史记录，**不作事实源**（与活跃脚本输出冲突时以脚本为准）。
- 合规率**不接退出码**：模型行为不该让套件随机变红；要留的发现落证据，不落门。

## 15. `2026-09-17-review-v4.md`（代码评审 v4 快照 —— 非探针 JSON）

**它证明了什么**：① 三条最有价值的门禁检查曾抓不到东西（安全断言不看 mode 实参 / 行为脚本三条静默变绿
路径 / 部署包含性闸门被符号链接击穿），全部已修，且每条都有「改坏必须变红」的阴性对照；② **v2 前置口径
× PTC 传输 ×「开轮只读侦察」三方冲突** —— 照章办事也判未前置：该窗口 22 个「同消息」轮**全部**是这类
口径产物，真正的行为缺口是 28 个「整轮无门行」轮次；③ `backgroundMode`（子代理输入框）取证的原始结论，
**待用户裁决**。

| 复跑入口 | 期望 |
|---|---|
| `make verify` | 四支判定行全绿；行为那支新增「未前置成因」行 |
| `make control` | 三支阴性对照判据均为**集合相等**、exit 0 |
| `node scripts/verify-ptc-roles.cjs --control-sessions` | 合成会话恰好让 1 条指定断言失败 |

## 16. `2026-09-17-intent-gate-existence-criterion.json`

**它证明了什么**：意图门的义务从 ②「前置」（门行所在消息早于动手）**收窄为 ①「存在」**（门行必须落在**承载第一次动手的那条消息**里，且是该消息首行），并给出收窄前后的当场读数与代价登记。

| 字段 | 值 | 含义 |
|---|---|---|
| `readings.aggregate` | **① 22/42 (52%)** · **② 6/42 (14%)** · 可见回复 39 · 任意文本 47 | 5 个装了门的主 agent 会话 / 42 个会改变行为的轮次（2026-09-17 当场实测） |
| `readings.causes` | 同一条消息 16 / 整轮无门行 6 / 门行在动作之后 13 | ① 与 ② 的**全部**差额（16 轮）落在「同消息」类 |
| `readings.aggregate[3]` | 同消息达标 16 轮：首发是 **shell 侦察 16 轮 / 非 shell 0 轮** | pitfalls #17 预告的载体耦合被完整证实：旧口径测的主要是「第一步恰好不是 shell」，不是模型漏行 |
| `harnessFacts.ordering` | assistant 消息先落库（`agent.ts:474-483`）→ 才 `executeToolCalls`（`:488`）→ `tools/pre-execute`（`tools/src/index.ts:1465-1468`） | 闸门**有能力**看见同一条消息里的门行；但监听器时序仍是**推断**，故闸门默认 observe |
| `harnessFacts.injectionPersists` | `agent.ts:373-377` | pre-step 注入的消息**永久落库** ⇒ 旧口径下约 87% 的行为轮次各留一条逐字相同的常驻提醒 |
| `controls` | verify ✓46 ✗0 / 36/36 / 11/11 / ✓13 ✗0；control 三支「符合预期」（集合相等 5 / 16 / 1） | 判据是各脚本打印的判定行；闸门 8 条断言另有一次性变异副本逐条反证 |
| `notProven` | 真机时序 / config 传递 / 效用 / 长期不衰减 | 四条都写明，别当成已验证 |
| `nextStep` | 观察会话里 `RACE_REPORT` 一次都不出现 ⇒ 可开闸（`config.gate: enforce`） | 开闸后每轮最多拒一次，拒绝理由自带补救话术 |

**怎么得到的**（复现方法）：

```bash
node scripts/verify-ptc-roles.cjs            # 合计 + 每会话 + 「同消息达标」交叉打印
make verify && make control                  # 四支判定行全绿 / 三支阴性对照集合相等
grep -n 'mjs?v=' preset/ptc-roles/agent.cordis.yml   # intent-gate-watchdog.mjs -> ?v=10
```

**边界（别误读）**：
- ① 的读数只证「门行有没有落在载体消息里」，**不证**「因此决策更正确」，也不证提醒/闸门让人更守纪律（同 ⑩/⑪/⑫ 的口径）。
- **覆盖率口径随之下移一格**（同消息的动作也算被声明覆盖）：聚合 47%（2026-09-16 基线）→ 58%，**新旧不可直接比**。
- 窗口在改动当天从 41 漂到 42 个 eligible 轮次 —— 差额来自**本会话自身在增长**（它也是被统计的 5 个主会话之一）。引用一律带窗口 + 日期。
- 闸门**尚未在宿主内跑过**：`config.gate` 的传递有官方先例但本行未实测；开闸前置条件见 `nextStep`。

## 17. `2026-09-21-gate-deny-readings-and-mode-marker.json`

**问题**：enforce 之后，门的纪律成本能不能从数据面读出来？「被拒 → 恢复」在日志里长什么样？preset 身份能不能不靠 persona 散文？

**结论**：三条都成立 —— ① 拒绝可从**既有事件**成对判读出（PTC 落 `tool/ptc-dispatch`+`isError`、native 落 `tool/result`；
**不看参数**，否则会把我自己那条 `grep '[intent-gate]'` 的 bash 算成一次拒绝）；② preset 身份改读
`agent-preset/selected` **事件**（实测形状 `{"type":"agent-preset/selected","seq":4,"data":{"agentPreset":"ptc-gate"}}`）；
③ enforce 的模式与竞态取证都进了数据面（插件 inject `mode=` 与 `FALSE_DENY`，reader 独立复算同一判据）。

**当场读数**（口径 = `docs/pitfalls.md` #19 的 2026-09-21 段；窗口 = 本仓库工作区；2026-09-21）：
`session-5d9dcf8f`（ptc-gate）3 个 user-opened 轮 ⇒ ① 存在 2/3、拒绝 **1**、恢复 **1**、无门行继续 **0**、
假拒候选 **0**、模式标记**缺席**（该会话挂载早于标记引入 —— 预期）。`make verify` rc=0（四支 + 组成契约全绿）、
`make control` rc=0（三支阴性对照判集合相等）、`make check` rc=0（未部署记 ⓘ）。

**另一个当场事实**：两臂配对实验的会话**已全部滚出**会话库（证据文件里 11 个 id 0 命中、五个任务工作区目录皆空）
⇒ 成本归因在存量数据上不可复现；这也是 ADR 0002「读数必须当场落证据文件」那条纪律的又一次兑现。

## 18. `2026-09-23-gate-deny-account.json`

**问题**：闸门拒绝的**代价面**是什么？「每轮至多拒一次」是有意设计 ⇒ 被拒 program 里其余的派发会怎样？
拒绝率的分母定死之后，本窗口越没越预登记弱线？

**结论**：三条都成立 —— ① 拒绝的代价面 = **1 次派发，不是 1 个程序**：被拒 program 的其余派发**照跑**；
② 唯一的反例形状是「模型**没包 try/catch**」—— 机制与边界见 `docs/pitfalls.md` #29；
③ 拒绝率（user-opened 行为轮口径）在本窗口**越线**，且越线量出来的是「开轮就动手」而不是门故障。

**当场读数**（口径 = `docs/pitfalls.md` #19 的 2026-09-23 段；窗口 = 本仓库工作区；2026-09-23；
本文件 = `node scripts/verify-ptc-roles.cjs --snapshot <path>` 的**原样输出**，只收判定读数、不含 token 桶）：

| 会话 | 拒绝 | 拒绝率 | 被拒工具 | 同 program 其余派发 | 恢复 |
|---|---|---|---|---|---|
| `session-299709d6` | 1 | **1/1 (100%) ⇒ 越线** | `bash×1` | **5**（在被拒之后 5）⇒ 该 program 共 6 次派发 | 1/1 |
| `session-c413f21c` | 1 | 1/5 (20%) | `bash×1` | **0** —— 该 program 没包 try/catch，见 #29 | 1/1 |
| `session-51c3bce8`（本轮复盘会话） | 0 | 0/1 | — | 0 | 0 |

⚠️ **`合计` 为 0 是正确读数**，不是空跑：合计的人口是 **ptc-roles only**（跨代次不可汇总，#19），
而本工作区当前只有 **ptc-gate** 会话 ⇒ 逐场读数在 `会话[]` 里。

**边界（别误读）**：
- 这是**窗口读数**：会话库是滚动窗口（#15），除了本文件，任何「当时是几」都不可复算 —— 本文件就是为此存在。
- `同 program 其余派发 0` **单独不能**证明「兄弟调用被丢」（0 也可能是单发程序）；要证得看程序文本（#29）。
- 本文件是 reader 的原样输出，不是第三人复算；复核纪律见 #24（规则 9）。

## 附 · 轮次与结清状态（从 HANDOFF 搬迁至此：逐轮验证记录）

> HANDOFF 只留**当前要做什么**；逐轮历史归这里，因为它本来就是「验证账本」。
> 证据编号 ①–⑨ 对应该文件上方 `## 1`–`## 9` 各分节。

| 轮 | 内容 | 状态 | 证据 |
|---|---|---|---|
| 1–2 | v1 装配 + 行为冒烟；首轮逮到 explorer/librarian 派不出去、工具面泄漏 + 孙代升级已被利用 | ✅ 已修并复验通过 | ③④ |
| 3 | 翻转插件深度判据加固 + `.mjs` 引用引号坑；宿主内确认「加固那一代真的被挂载」 | ✅ 债清零（含**代次证明链**：loader 保留 query ⇒ `?v=1` 是独立缓存键，且该 URL 首次出现于加固写盘之后） | ⑤ 的 `hostMountConfirmation` |
| 4 | 补全被静默丢掉的 `designer`（第 5 角色）+ 平台兼容（shell 平台择一）；旁及审计全仓库 | ✅ **已结清**（designer **首次宿主挂载**：`role=designer ptc=no`，白名单 6 项精确匹配；win32 分支仍不可测） | ⑦⑨ |
| 4 | 首轮 dogfooding：explorer 清点 + oracle 对抗评判 ⇒ 白名单**零漂移**，逮到 3 处真实缺陷（悬空 designer 引用、leaf-node 口径错、README 模型档漂移） | ✅ 均已修 | ⑧ |
| 5 | 核实 Sisyphus 覆盖度（上游 v4.19.4）并补全操作性纪律；Specialists 改表；`continuable` 定案 | ✅ **已结清**（persona 文本确认载入；**仅证载入、不证效用**） | ⑧⑨ |
| 6 | 角色 `fixer` → `implementer` 改名（yml / persona / `EXPECTED` / 文档同步；**不做** LEGACY_ROLES 别名） | ✅ **已结清**（`role=implementer ptc=no` 白名单 8 项；`--all` 无 fixer WARN 残留） | ⑨ |
| 7 | 改名 `agent-lanes` → `ptc-roles` + 新增意图门看门狗；**新 id 宿主内挂载 / 角色派发与白名单 / 看门狗注入** | ✅ **已结清**（三项数据面证据齐；`--all` 阳性对照 20） | ⑩ |
| 8 | 意图门失败记录归档（HANDOFF §3④）+ **合规率指标固化进验证脚本**（§3③）；同时逮到并**修复** persona 与插件门行**不同口径**（门行补丁：Phase 0 限定为「会改变行为的轮次」+ 首行 `意图判定：<桶> — <计划>`；看门狗随之改为只提醒这类轮次，单测 20/20；`.mjs` bump 到 `?v=2`） | ✅ 已落地（「原始审计不可复现」这一事实一并入档） | ⑪ |
| 11 | 角色派发补全：`librarian` / `oracle` 宿主内白名单**精确匹配**（8 / 6 项）—— 五个角色行**全部**验过 | ✅ 已结清（⑩ 的 `notVerifiable` 缺口关闭） | ⑬ |
| 10 | **第二代（`?v=4`）宿主内验证**：新 persona 载入 / 新看门狗字节载入 / 行为轮漏行被提醒 ×2 / 只读轮漏行不提醒（同会话对照） | ✅ 已结清（方法学上先自纠了一次 marker 子串混淆） | ⑫ |
| 9 | **门行文案返工（G-5）**：marker 驱动退化（门行写成 turn 号 / 看门狗状态 / 证据文件名）⇒ 按上游 `Step 0: Verbalize Intent` 原文**补回我们移植时丢掉的 `[reason]` 槽位**、明确「读者是用户 / 是承诺不是标签 / 不照抄原话」；`.mjs` bump 到 `?v=4` | ✅ 已落地（上游 v4.19.4 与 HEAD 逐字相同已核；单测仍 20/20） | ⑪（`findings[4]` + `upstreamReference`） |
| 14（2026-09-23） | **闸门账 + 双 persona 程序契约**：reader 新增「被拒工具 / 同 program 其余派发 / 拒绝率」三读数与 `--snapshot`；两份 persona 补 PTC 程序契约段（每 `tools.*` 包 try/catch + 大常量只构造一次）；预登记弱线收敛到 ADR 0003 单处登记 | ✅ 已落地并自验（`make verify` 四支 + 组成契约全绿、`make control` 三支集合相等）；**宿主内已取证**（2026-09-23 重启后 resume：reader 打出 `✓ 主 agent 载入的是**含程序契约段**的那一代 persona`）；顺带逮到 resume 会**换代但保留旧 `createdAt`**，判据已改锚到最后一条 `system/message`（pitfalls A 节） | ⑱ |
| 13 | **意图门口径改造**：persona 的 Phase 0 / 看门狗判据 / 合规口径 / 两套断言同一次改到 **①「存在」档**；提醒 7→3 行；新增 `tools/pre-execute` 闸门（默认 observe + 竞态诊断行）；`?v=10` | ✅ 已落地并自验（`make verify` 四支全绿、`make control` 三支集合相等）；**宿主内取证待新会话** | ⑯ |
| 12 | **复审报告 v3 的独立复核**（grill 会话）：13 条裁定逐条复跑 + §2 a–e + §3/§4/§5 复核；逮到 **R-04 的落地声明为假**、**R-05 半落地**、**归因计数器无牙**（R-02 同型病）、错指针 `#17`→`#9`；给计数器补牙 + 可复跑 fixture；合规率口径独立成 **#19** | ✅ 已落地并当场自验（三条修正 + 三套脚本全绿、`--control` 判定行在）；快照按它自己的建议删除，证据 ⑭ 承继其全部结论 | ⑭ |

**仍未做（2026-09-17 新）**：闸门的观察模式取证与开闸 —— 必须**新会话**（`?v=10`）才吃得到新代，见 ⑯ 的 `nextStep`。
**仍未做**：`skills` 细粒度分发（推迟 v1.1）；~~sandbox-strip~~ **结案不做**（证据 ⑥）；win32 平台分支（本机无该平台，只能靠设备验证）。
**仍未做（2026-09-15 复审复核追加）**：`?v=5` / `?v=6` 那一代的**宿主内**证据（要 `dev_reload_preset` + 新会话 + 派角色）；本轮按用户裁定只留痕（见 ⑭ 的 `generationHistory.gap`）。

## 注意

两次探针都在事后清理过：探针插件已卸载、profile patch 里由卸载器自动写入的 `disabled` 残留条目已删除并校验（`dev_fix_patch --check` 报全部 profile 健康）。唯一遗留是一个**仅内存**的 inert loader entry，DSH 重启即消失。
