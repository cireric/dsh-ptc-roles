# DSH v0.1.6 对 ptc-roles 的影响与迁移

- 日期：2026-09-15
- 状态：**待执行**（等待 `v0.1.6-rc.*`；对 `v0.1.6-alpha.1` 只做分析，不动 preset）
- 基线：本地 harness checkout `dsh-v0.1.5-rc.2-139-gc291e7961a`（package version `0.1.5-rc.2`）
- 目标版本：`dsh-v0.1.6-alpha.1`（2026-09-15 发布，prerelease）

## 0. 本文的职责边界

| 本文拥有 | 本文不拥有 |
|---|---|
| **版本迁移计划**：0.1.6 的差异事实、对 preset 的影响面、rc 版后的修复清单、改进方向 | 机制与坑的细节 —— 唯一知识源是 `docs/pitfalls.md`（本文只按编号**引用并标注哪些条目已过期**） |
| 一次性的版本影响分析（本文是**版本作用域**的，不随日常迭代更新） | 日常机制事实、排障流程、行为合规率 —— 归 `pitfalls.md` / `scripts/verify-*.cjs` |
| 升级前门禁、待实测清单 | 复现步骤与原始证据 —— 归 `docs/evidence/` |

> ⚠️ **本文与 `pitfalls.md` #6 / #10 存在事实源冲突**（见 §2.2）。落地修复时必须**同时**改 `pitfalls.md`，
> 否则两份事实漂移 —— 这正是 `pitfalls.md` #12 记过的失败模式（同一批事实多份手工副本，已被咬两次）。

> 📌 **本文不判断「还要不要继续做这个 preset」。** 存续判断、改进项的**优先级与退役条件**归
> `docs/decisions/0002-continue-evolving.md`（含证据窗口与回归基线）。本文只提供**版本事实**与**版本驱动的机制实现**——
> §4 回答「怎么做」，ADR 0002 回答「做不做、先做哪一个」。

---

## 1. 背景：0.1.6 相对 0.1.5-rc.2 的 PTC 语义变更

三条**改变设计前提**的变更，加一条纯改名。

### 1.1 PTC 执行基底：worker 线程 → 受策略约束的独立沙箱进程

官方架构决策 `.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md`，源码印证
`packages/core/tools/src/index.ts` 的 PTC 传输装配：

```ts
resolveSandboxPolicy: (exec) => {
  const policy = this.ctx.get('sandboxPolicy')
  if (policy === undefined) throw new Error('dsh-tools: confined PTC runtime requires sandboxPolicy')
  return policy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
},
```

变更要点（**CONFIRMED**：官方 note + 0.1.6 源码）：

- 每次 `run_code` 在**全新 Node 进程**中执行，通过与 Bash **同一个 `ctx.sandbox` 提供方**启动，
  生命周期交给 `ctx.subprocess`
- **PTC 传入调用 Session 的 cwd 与已解析的常设文件策略**（`sandbox/mode`：`read-only` / `workspace-write` / `danger-full-access`）
- 直接 fs / 网络 / 子进程操作**仍是 Node 操作，但受所选 OS 沙箱约束**；所需沙箱后端不可用时**受限执行直接失败**（fail-closed）
- 文件模式、观测到的拒绝、强制完整性通过 `PtcRunResult.sandbox` 独立于程序结果返回
- `run_code` 新增 `sandbox_permissions` + `justification`（提权需审批、**一次执行有效**、绝不自动重放）
- 子进程环境：**`process.env` 为空**

### 1.2 `run_code` 超时口径：compute → elapsed

| | 0.1.5-rc.2（worker-thread） | 0.1.6-alpha.1（ptc-runtime-node） |
|---|---|---|
| 默认预算 | `computeMs: 60_000`（**计算**时间） | `timeoutMs: 120_000`（**elapsed 墙上时间**） |
| 上限 | `maxWallMs: 600_000` | `maxTimeoutMs: 600_000` |
| 是否计入嵌套工具 / 审批等待 | **否**（compute 口径） | **是**（note 原文：「启用的截止包括运行时准备以及嵌套工具或审批等待」） |
| 其它 | `maxOutputBytes 64MiB`、`maxOldGenerationSizeMb 512` | 同上 + `maxPendingCalls: 128`、`maxMessageBytes 128MiB`、`graceMs: 3000` |

**CONFIRMED**：默认值读自两侧 `Config` 源码。宿主的运行时时长由 base bundle 的 `ptc-runtime` 行提供，**该行无 config，全部走默认值**。

### 1.3 委派权限继承新增第三条：`permission/preset`

`packages/subagent/subagent/src/child-agent.ts` 的 0.1.5→0.1.6 diff 新增：

```ts
const preset = parent.ctx.get('permissionPresets')?.current(parent.session)
...
  permissionPreset: preset === 'auto' || preset === 'danger-full-access' ? preset : undefined,
if (overrides.permissionPreset !== undefined) {
  childSession.append('permission/preset', { preset: overrides.permissionPreset })
}
```

原有两条不变：`sandboxMode` **只取父 session 的显式 override**（`overrideOf(parent.session)`，**绝不取部署默认值**）；
`approvalPolicy` 恒为 `'never'`。**CONFIRMED**

### 1.4 纯改名（无兼容别名）

| 0.1.5 | 0.1.6 |
|---|---|
| `@deepseek-ai/dsh-code-runtime` | `@deepseek-ai/dsh-ptc-runtime` |
| `@deepseek-ai/dsh-code-runtime-worker-thread` | **`@deepseek-ai/dsh-ptc-runtime-node`** |
| `@deepseek-ai/dsh-experimental-code-runtime-python` | `@deepseek-ai/dsh-experimental-ptc-runtime-python` |
| `@deepseek-ai/dsh-workflow-worker-thread` | **`@deepseek-ai/dsh-workflow-ptc`** |
| 服务 `ctx.codeRuntime` | 服务 **`ctx.ptcRuntime`** |

官方决策 `2026-09-12-ptc-runtime-vocabulary.zh.md` 明示：**不提供兼容包、不提供第二份服务注册**。**CONFIRMED**

---

## 2. 对 preset 的影响面

### 2.1 硬破坏（不改则 preset 挂载失败）

| 位置 | 现状 | 0.1.6 要求 |
|---|---|---|
| `preset/ptc-roles/agent.cordis.yml:248` | `name: '@deepseek-ai/dsh-workflow-worker-thread'` | **`name: '@deepseek-ai/dsh-workflow-ptc'`**（`id` 建议同步改 `workflow-ptc`） |
| 全仓 | 任何 `ctx.codeRuntime` / `@deepseek-ai/dsh-code-runtime*` 引用 | 改名或删除（无别名） |

**勿照抄官方新版的 `disabled: true`**：官方 shipped ptc preset 与 base bundle 都把 `workflow-ptc` / `tool-ralph` 改成
`disabled: true`（Ralph 默认关闭）。本 preset 是**显式开启 Ralph 的派生**，两行都要保持 enabled，只换包名。

### 2.2 安全前提被推翻（本 preset 的核心论证）

`pitfalls.md` #6 与 ADR 0001「决定性证据」表的第一行，都建立在：

> `run_code` 跑在宿主进程的 worker 里、有 `fs` / `child_process`，**绕过 DSH 文件沙箱** ⇒ PTC 下「只读角色」不成立。

§1.1 之后，这句话的**后半段失效**：

| 断言 | 0.1.5-rc.2 | 0.1.6-alpha.1 |
|---|---|---|
| `run_code` 能否被白名单 / `restrict()` 移除 | ❌ 不能（保留传输） | ❌ **仍然不能**（`core/tools/src/index.ts:1092` 原文拒绝命名 `RUN_CODE_NAME`） |
| `run_code` 内**直接写文件** | ✅ 能，绕过文件沙箱 | ⛔ 受 session 常设文件策略约束（`read-only` 即无法写） |
| 「PTC 只读角色」 | 不成立 | **在 `read-only` 策略下成立** |
| `run_code` 内**读文件范围** | 无限制 | **仍无限制**（read-only ≠ read-scoped） |
| `run_code` 内进程 / 网络 | 可用 | 仍可用（沙箱管的是**文件效果**） |

> **结论：native 翻转不再是「只读角色」的唯一/必要手段，也不再是安全上的必要条件。**
> 它今天仍然买到的是 PTC 买不到的 **① 能力面最小化（allow-list）+ ② 读范围最小化（fs 工具自带 workspace 包含性）**。
> 因此 `pitfalls.md` #6 的论证要从「绕过文件沙箱」改写为「读范围与能力面」，**不要**直接删除该条 ——
> 保留翻转的理由变了，但没有消失（见 §4.2）。

### 2.3 已确认兼容（无需改，但值得写进门禁脚本）

**CONFIRMED**（逐项读 0.1.6 源码 / diff）：

| 依赖 | 0.1.6 状态 |
|---|---|
| `tools.presentAs(mode)` / `modeFor` | 存在且**语义未变**；`core/tools/src/index.ts` 的 diff 未触及 presentAs / `layer.mode` 冲突判定 |
| `presentAs` 的「一 scope 一声明」检查 | 未变（仍是 per-layer 检查，跨 layer 不冲突） |
| `agent/created` payload | `ctx.serial(carrier, 'agent/created', { agent, source, signal? })` ⇒ 仍有 `agent` |
| `agent/created` 时序 | **改为异步串行，且框架保证监听器完成后才发首个模型请求** ⇒ 翻转的时序保证比 0.1.5 **更强** |
| `agent/pre-step` | 仍在（`agent-loop/src/agent.ts:251`），`kind: 'enter'` + `messages` 契约不变 ⇒ 看门狗的消息注入照旧 |
| `session/event` | 仍是公共事件（全仓 8+ 包消费） |
| `tool/ptc-dispatch` | 仍在（`core/tools/src/index.ts:173/352`） |
| `subagent/src/depth.ts` | **文件未改动**；`Math.max(header.delegationDepth ?? 0, runtime ?? 0)` + 畸形 runtime 抛 `TypeError`，与 `role-presentation.mjs` 的 `resolveDepth` **逐字一致** |
| `tool-ralph` config schema | `subagentProvider` / `maxRounds` 仍在（默认 `spawn` / 256），现值合法 |

**新增义务（1 条）**：`agent/created` 监听器**抛错会使 agent 创建失败**。本插件的 try/catch（「响亮告警 + 仍翻转」）
在 0.1.6 下仍需保留，但要注意：**告警本身在本部署不可见**（`pitfalls.md` #9 —— 无落盘通道）。见 §4.4。

---

## 3. rc 版后修复建议

> 顺序即优先级。**P0 不做完不要动主 profile。**

### P0 — 阻断项（preset 能否挂载）

| # | 动作 | 文件 | 验证 |
|---|---|---|---|
| P0-1 | engine 行改名 `@deepseek-ai/dsh-workflow-ptc`（`id` 同步） | `agent.cordis.yml:247-250` | 开新会话能选中 preset |
| P0-2 | 保持 engine 与 `tool-ralph` 行 **enabled**（勿照抄官方 `disabled: true`） | `agent.cordis.yml:247-262` | `ralph` 出现在工具面 |
| P0-3 | 全仓排查 `codeRuntime` / `code-runtime` 残留引用 | preset / `.mjs` / scripts / personas | `grep -rn 'code-runtime\|codeRuntime'` 零命中 |
| P0-4 | 注释同步：`agent.cordis.yml:284` 的 `codeRuntime` → `ptcRuntime` | `agent.cordis.yml` | 人工核对 |

### P1 — 安全项（把边界从「插件判据」迁到「框架策略」）

| # | 动作 | 理由 | 验证 |
|---|---|---|---|
| P1-1 | **给只读角色 seed `sandbox/mode: read-only`**（§4.1） | 让「翻转失败」从**安全事件**降级为**功能降级** —— 当前翻转是唯一边界，而告警在本部署不可见（#9） | §6-V1 |
| P1-2 | 更新 `pitfalls.md` #6 / #10 与 ADR 0001 的「决定性证据」表 | §2.2：旧论证已过期，不改就是事实漂移 | 人工核对 |
| P1-3 | 验证父会话在 **auto / danger-full-access** 时子角色的实际沙箱 | §1.3 是**新的独立变宽路径**，`docs/evidence/2026-09-13-sandbox-escalation-closure.json` 的结论未覆盖它 | §6-V3 |
| P1-4 | personas 里若用 `run_code` 读环境变量 → 改掉 | §1.1：PTC `process.env` **为空**（`DSH_WEB_URL` 等只在 bash 工具侧可见） | 人工核对 personas |

### P2 — 编排体验（撞超时的实务风险）

| # | 动作 | 理由 |
|---|---|---|
| P2-1 | profile patch overlay `ptc-runtime` 行抬高 `timeoutMs` / `maxTimeoutMs` | §1.2：elapsed 口径 + 计入嵌套等待，多角色编排极易撞 120s |
| P2-2 | orchestrator persona 增加一条「长编排显式传 `timeoutMs`」 | 模型侧缓解；`run_code` 只接受正数覆盖值，不传即走 config 默认 |
| P2-3 | 在 Agent Presets 设置里**关闭模式切换 UI** | 0.1.6 新能力；本 preset 的模式是设计固定值，防误切导致角色边界失效 |

P2-1 的具体写法（**注意 profile patch 对 config 是整行替换，非合并**；base bundle 的该行无 config，故不会丢字段）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: ptc-runtime
  name: '@deepseek-ai/dsh-ptc-runtime-node'
  config:
    timeoutMs: 600000
    maxTimeoutMs: 600000
```

> 依据：base bundle 自己的注释示范了这种 overlay 用法（`tool-ralph` 行：「An overlay row restores it for a
> base-backed profile (`$DSH_HOME/cordis.patch.yml`, or a `--patch <file>`)」）。**LIKELY，未实测**

### P3 — 升级作业本身

| # | 动作 | 理由 |
|---|---|---|
| P3-1 | **先在独立 profile 灰度**（如 `web-016`）装 0.1.6 + 最小 bundle 集，验证 preset 后再动主 profile | 主 profile 有 18 个第三方 bundle，其中 `dsh-better-sidebar` 徽章只声明验证到 `0.1.5-rc.2`，且其 `cordis.patch.yml` 带「duplicate prefix route 会让整棵插件树失败」的硬失败逻辑 |
| P3-2 | 升级 dsh 本体后跑 `security_audit` 并与基线 JSON diff | `AGENTS.md` 规则 5（供应链） |
| P3-3 | 复跑 `make verify` + `make control`（判据 = 各脚本自己打印的判定行；`--control` 是**集合相等**。**不登记条数** —— 条数随改动变，抄进文档必漂） | `AGENTS.md` 规则 7 |

---

## 4. 改进方向

### 4.1 【首选】把「只读」落到 session 文件策略

0.1.6 新增的能力：`sandbox/mode` 是**每 session** 的策略，写入路径就是一次普通 append：

```js
// packages/sandbox/sandbox-policy/src/session-mode.ts —— 框架实现即如此
export function setSandboxMode(session, mode) {
  session.append('sandbox/mode', { mode })   // source 省略 = 运行时切换
}
```

**插件的零 import 约束不妨碍这件事** —— 直接对 `agent.session` 写同一事件，不需要 import
`@deepseek-ai/dsh-sandbox-policy`：

```js
// role-presentation.mjs：在既有的翻转分支之外再做一次策略收窄
if (READ_ONLY_ROLES.has(roleName)) {
  agent.session.append('sandbox/mode', { mode: 'read-only' })
}
```

**收益**：纵深防御。`pitfalls.md` #10 的四层深度判据是在防「真子代零告警地留在 PTC」；
一旦翻转漏判，当前后果是**子代理可写文件**（安全事件）；有了 read-only 策略，后果降级为**子代理失去原生工具面**
（功能降级）。这是把边界从「插件判据的正确性」迁到「框架策略强制」。

**⚠️ 单一事实源纪律（务必）**：role → mode 的映射**不要**新增第 4 份手工副本 ——
`pitfalls.md` #12 已记「同一批角色事实有 3 份手工副本，改一处就会漂移，本项目已被咬两次」。
把 mode 与 `allow` 放在**同一处**（yml 的 role 行），插件从该行配置读；验证脚本的 `EXPECTED` 同步。

**未实测**：append 时机是否被接受、收窄是否无审批门槛、是否与委派 seed 顺序冲突（官方注明
「later child switches still win over these events」，故本插件的 append 应当胜出）。

### 4.2 重估翻转的取舍

既然 `run_code` 已受沙箱约束，两个方案可以并列评估：

| 方案 | 能力面 / 读范围 | 写路径 | 编排成本 |
|---|---|---|---|
| A. 现状：全部子代理翻 `native` | allow-list 最小化；fs 工具 workspace 包含 | 工具层白名单 | 多轮往返 |
| B. 子代理留 PTC + `read-only` 策略 | 嵌套调用**仍过绑定 allow-list 校验**；但直接 Node API 的**读范围不受限**，且可起进程/联网 | **策略层封死** | 单轮 `run_code` 组合，更省 token/往返 |

> 注意一处常见误读：官方 note 明确 PTC 内嵌套工具调用「在分派前验证调用身份与**绑定允许列表**」——
> 所以 `toolFilter.allow` 在 PTC 下**不是纯提示**。#6 里「白名单删不掉 `run_code`」仍是事实，
> 但它**推不出**「allow 无效」。逃逸的是**读范围与进程/网络**，不再是写。

### 4.3 装前契约门禁（新脚本建议）

**动机**：本 preset 有三处「手工复刻框架口径」的依赖 —— `depth.ts` 的深度公式、
`presentAs` 的 scope 语义、`agent/created` 的 payload 形状。
而 `deepseek-ai/deepseek-harness` 的 **issues 已关闭**（社区 issue 原文：「该仓库已关闭 issues，无法上游报告」），
加上 `AGENTS.md` 规则 1（不改框架）与规则 3（插件零 import）⇒
框架漂移只能靠**自己的装前门禁**兜住，不能靠上游通知。

建议新增 `scripts/verify-harness-contract.cjs`（**升级 dsh 本体前**跑，而非改 preset 后跑）：

| 断言 | 依据 |
|---|---|
| `subagent/src/depth.ts` 的公式仍是 `Math.max(header, runtime)` + 畸形 runtime 抛错 | 插件 `resolveDepth` 逐字复刻它 |
| `core/tools` 仍导出 `presentAs` / `modeFor`，且 presentAs 冲突判定仍是 per-layer | 翻转插件的唯一写入路径 |
| `agent/created` payload 仍含 `agent`，且仍是 `ctx.serial` 派发 | 翻转与看门狗的共同入口 |
| `agent/pre-step` 仍以 `kind: 'enter'` + `messages` 返回 | 看门狗的消息注入 |
| 五个角色 allow-list 里的工具名在**实时注册表**中仍存在 | `pitfalls.md` #11：未知名会让角色派发**响亮失败** |
| `@deepseek-ai/dsh-workflow-ptc` / `dsh-ptc-runtime-node` 可解析 | §1.4 无别名 |

这与既有的三个 verify 脚本同构（`--control` 反空转断言尤其重要），契合 `AGENTS.md` 规则 7（自验）的验证文化。

### 4.4 让翻转结果进数据面（回应 #9）

`pitfalls.md` #9：本部署 `logger.warn` **没有落盘通道** ⇒「失败必须可见」只能靠数据面。
翻转插件当前在失败时 `warn(...)` —— 在 0.1.6 之后这个告警的可信度更关键（它曾是唯一边界）。

**改进方向**：翻转成功/失败各写一条可判定的事实（如角色会话的 `sandbox/mode` 事件、或一条 plugin 来源消息），
让 `verify-ptc-roles.cjs` 能像判定「意图门合规率」一样判定**翻转覆盖率**，而不是靠读日志。

### 4.5 未来预警

| 触发条件 | 冲突 |
|---|---|
| 若启用实验性 **Team 模式** | 该模式**关闭 `subagent` / `subagent_fork`** 并统一为 `spawn_teammate` ⇒ 本 preset 的角色行（`provider: spawn` / `fork`）会失效 |
| 若任一 persona / 角色行依赖 **E2B** | 0.1.6 移除内置 E2B 后端（`packages/e2b/*` 整族删除，由 `packages/ssh/*` 取代） |

---

## 5. 社区功能吸收（与本 preset 的间接关系）

结论：**能力层面社区先行在多个功能上成立，但「代码/设计被官方吸收」查无实据**，且因果方向多为相反
（官方先自建原生实现 → 插件让位迁移）。依据：core 的 feature design note 全文零次提及任何社区插件；
core 仓库搜 `better-sidebar` = 0 命中；全生态搜 `upstreamed / 已并入` 无一对指向 core；找到的插件无一归档。

对本 preset 有**实际影响**的是 profile 里两个已装插件（升级前需确认）：

| 已装插件 | 与 0.1.6 内建功能的重叠 |
|---|---|
| `dsh-better-sidebar@^0.19.1` | 内建侧边栏终端与其 terminal tab 重叠；其徽章只声明验证到 `0.1.5-rc.2`，且带 duplicate-prefix-route 硬失败逻辑 |
| `@michengai/dsh-archive-manager@^0.1.39` | 内建 `ui-settings-unarchive-sessions`（list + search + per-row Unarchive）是它的**子集** ⇒ 可能出现两个「已归档会话」设置入口 |

> 本条只记录**与本 preset 升级作业相关**的部分。完整的社区溯源（含证据 URL 与置信度分级）见结论报告，
> 不在此重复 —— 避免与外部报告形成第二份事实源。

---

## 6. 待验证清单

| ID | 待验证 | 方法 | 阻塞 |
|---|---|---|---|
| V1 | `agent/created` 里 append `sandbox/mode: read-only` 是否被接受、是否需审批、是否比委派 seed 更近 | 开新会话，让只读角色尝试写文件；读 `run_code` 结果里的 `sandbox.mode` / `sandbox.denied` | P1-1 |
| V2 | overlay `ptc-runtime` 的 `timeoutMs` 是否真的作用于 `run_code` | Trajectory 看 `run_code` 是否仍报 `timeout`；或跑一个 >120s 程序 | P2-1 |
| V3 | 父会话处于 auto / danger-full-access 时子角色的实际沙箱 | 补一条 evidence JSON（对齐 `docs/evidence/` 既有格式） | P1-3 |
| V4 | `run_code` 在 `read-only` 下能否起进程 / 联网 | 决定只读角色的真实威胁模型（§2.2 最后一行） | §4.2 取舍 |
| V5 | 内建侧边栏终端与 better-sidebar 同时挂载是否报 `duplicate prefix route` | 灰度 profile 启动日志 | P3-1 |
| V6 | 热更新**取消事务回滚**后，坏 config 的部分激活表现 | 故意写坏一行 yml，观察挂载结果与恢复方式 | 调试流程 |

---

## 附：证据与复现

| 结论 | 来源 |
|---|---|
| PTC 沙箱进程 / 策略传递 / fail-closed | `.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.zh.md`；`packages/core/tools/src/index.ts`（0.1.6） |
| PTC 命名与不提供别名 | `.agents/notes/implemented/architecture/2026-09-12-ptc-runtime-vocabulary.zh.md` |
| 工作流复用 PTC 沙箱、`timeoutMs: null` 语义 | `.agents/notes/implemented/architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md` |
| `agent/created` 异步串行 | `.agents/notes/implemented/architecture/2026-09-09-awaited-agent-creation.zh.md`；`packages/core/agent/src/index.ts:547` |
| 委派 `permission/preset` 继承 | `packages/subagent/subagent/src/child-agent.ts` 0.1.5→0.1.6 diff |
| 超时默认值（两侧） | `packages/code-runtime/code-runtime-worker-thread/src/index.ts:240-241`（0.1.5）；`ptc-runtime-node/README.md` 配置表（0.1.6） |
| 宿主 runtime 行 | `packages/bundle/base/cordis.patch.yml` 0.1.5→0.1.6 diff |
| shipped ptc preset 差异 | `packages/preset/agent-presets/presets/ptc/agent.cordis.yml` 0.1.5→0.1.6 diff |

复现方式参考 `docs/evidence/README.md`。
