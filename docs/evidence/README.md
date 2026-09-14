# 证据归档（agent-lanes）

> 各探针的原始输出与复现方法在下方分节；**逐轮验证记录 / 结清状态**见文末「附 · 轮次与结清状态」。
>
> ⚠️ 部分 2026-09-13 的记录里引用了 `HANDOFF §x` —— 那是**文档重构前**的旧引用。那些内容今天在
> `docs/pitfalls.md`（机制 / 坑 / 排障）与 `docs/decisions/0001`（决策）里。**记录本身不改**（历史原样）。
>
> 另外：**2026-09-13 第 6 轮**把角色 `fixer` 改名为 `implementer`，所以旧记录里的 `fixer` 即今日的 `implementer`。

九份 JSON 都是原始输出（①–⑥ 是 2026-09-13 的探针与冒烟证据，⑦⑧ 是第 4/5 轮的改动记录，⑨ 是 2026-09-14 的**宿主内**结清验证），**只读证据**，不需要重跑就能复用结论。

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


**⚠️ 关联已变动（2026-09-13 文档重构）**：本节的 `sha256.current`（`408a8ca0…`）记录的是**取证当时**的字节。
同日的文档重构为消除「外部文档引用 HANDOFF」而改了插件里的**一行注释**（`HANDOFF §8 G2` → 指向 ADR），
所以**当前工作树的 sha256 已变为** `cab14ad812715753860128b9881b533f832c65bf5888f9ef50737530bc1902f8` —— **行为完全不变**（纯注释）。
含义：①这条关联的**时间点**是取证时，不是今天；②宿主仍按 `?v=1` 缓存着旧字节，
要让它吃到新注释需 `dev_reload_preset` + 新会话（HANDOFF 接手清单里那一步本来就会做）。
**冻结的阴性对照**（`scripts/fixtures/lane-role-presentation.prev.mjs`，`eb123c76…`）**未改动**，对照关系仍然成立。

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
| `crossChecks.deployedPresetIntegrity` | 4 软链 + 10 文件 sha256 与仓库**逐一相同** | 宿主读到的就是仓库里的；`.mjs` = `cab14ad8…`（= ⑤ 注释里记的当前值） |
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

**仍未做**：`skills` 细粒度分发（推迟 v1.1）；~~sandbox-strip~~ **结案不做**（证据 ⑥）；win32 平台分支（本机无该平台，只能靠设备验证）。

## 注意

两次探针都在事后清理过：探针插件已卸载、profile patch 里由卸载器自动写入的 `disabled` 残留条目已删除并校验（`dev_fix_patch --check` 报全部 profile 健康）。唯一遗留是一个**仅内存**的 inert loader entry，DSH 重启即消失。
