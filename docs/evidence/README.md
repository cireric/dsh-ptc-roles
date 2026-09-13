# 证据归档（agent-lanes）

六份 JSON 是 2026-09-13 的原始输出（两份探针 + 一份冒烟证据 + 一份 v1 复验证据 + 一份插件加固证据 + 一份提权结案证据），**只读证据**，不需要重跑就能复用结论。

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

**它证明了什么**：HANDOFF §2 步骤 1 的三处改动**复验通过，v1 成立**。同一会话内并行派出 4 个角色子代理（explorer / librarian / oracle / fixer），全部 native 且工具面与白名单**精确匹配**。

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

**它证明了什么**：HANDOFF §8 G2 的加固**有效且非空转** —— 插件改用框架统一的深度口径后 **11/11 通过**，
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
node scripts/verify-lane-role-presentation.cjs                                        # 11/11
LANE_PLUGIN_PATH=/tmp/lane-role-presentation.PREV.mjs node scripts/verify-lane-role-presentation.cjs   # 6/11（旧版对照）
dev_reload_preset preset=agent-lanes                                                  # 输出里必须出现 -> ?v=N
```

**边界（别误读）**：这个单元校验不依赖宿主，所以**在本会话就能下结论**；但插件**在宿主里真正生效**
仍需**新会话**（`?v=1` 已 bump，已运行会话保持旧代）。要确认生效，新会话里派一个角色子代理，
再跑 `node scripts/verify-agent-lanes.cjs` 看它是否仍是 `ptc=no` + 白名单精确匹配。

## 6. `2026-09-13-sandbox-escalation-closure.json`

**它证明了什么**：HANDOFF §5 原先那条「sandbox-strip 缺口」**不成立** —— 子代理 schema 确实暴露
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

## 注意

两次探针都在事后清理过：探针插件已卸载、profile patch 里由卸载器自动写入的 `disabled` 残留条目已删除并校验（`dev_fix_patch --check` 报全部 profile 健康）。唯一遗留是一个**仅内存**的 inert loader entry，DSH 重启即消失。
