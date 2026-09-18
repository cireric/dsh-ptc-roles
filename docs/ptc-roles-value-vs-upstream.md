# ptc-roles 的价值对照 —— 上游委派能力已经覆盖到哪一层

> **文档职责**：回答**唯一**一个问题 —— 官方 Standard / PTC 模式本身就能委派子代理，`ptc-roles` 还剩什么价值。
>
> **不在本文范围内**（各自有唯一归属，勿在此重复）：
> - 「是否继续 / 是否退役 / 改进项优先级 / 触发条件」→ [`decisions/0002-continue-evolving.md`](decisions/0002-continue-evolving.md)
> - 角色设计与被否决的方案 → [`decisions/0001-role-preset-over-orchestration-bundle.md`](decisions/0001-role-preset-over-orchestration-bundle.md)
> - 本 preset 的机制与坑 → [`pitfalls.md`](pitfalls.md)
> - DSH 0.1.6 的迁移影响 → [`dsh-v0.1.6-ptc-impact.md`](dsh-v0.1.6-ptc-impact.md)
> - 结论的原始输出与复现 → [`evidence/`](evidence/)

- 日期：**2026-09-18**
- 分析基线：上游 `@deepseek-ai/dsh` **0.1.5-rc.2**（checkout `/Users/eric/Project/tests/deepseek-harness`，记为 `$DSH`；`git describe` = `dsh-v0.1.5-rc.2-139-gc291e7961a`）。本文所有 `file:line` 指该工作区。
- 证据分级：**【C】** 代码验证（读了源文件，附 `file:line`）· **【D】** 官方文档 / 生成目录 · **【实测】** 本机当场测量（附命令）· **【?】** 未验证，勿当结论

## 0. 结论

**没有能力差，只有配置差。**

上游的 `dsh-tool-subagent` 已经把子代理的**人格 / 工具面 / 深度 / 模型档**全部做成「每个委派目标一份」，并明写用法是「每个委派目标挂一个实例」【D】。`ptc-roles` 的五个角色行就是这句话的五个实例【C】—— 用的是上游那一个插件，没有一处上游给不出的能力。

于是价值只剩三处，其中**只有第三处可能被证否**：

| # | 价值 | 判定 |
|---|---|---|
| ① | 一份**已经调对**、并被回归门禁守着的角色配置 | **成立** —— 省的是时间，不是能力 |
| ② | 「**PTC 父 + native 子**」这个组合形态 | **成立** —— 唯一算机制性的差异；但它是**组合**差异，任何人可自配 |
| ③ | 每角色模型档**真的省成本吗** | **未测** —— 目前是猜的档位（归属：ADR 0002 的 B 项） |
| — | 行为纪律（意图门 / 看门狗） | 与角色无关，任何 preset 里都能跑 —— **不计入角色价值** |

**底线判断**：若目的只是「能委派、能分角色」，本 preset **不是必需品**（官方两种模式 + 自配两三个实例即可，配置面就是 §1 那一张表）。它挣的是两样：反复委派时省掉重配与重踩坑；以及 ③ 这条**尚未测**的省钱押注。

## 1. 上游给的是一条参数面【D】

`$DSH/packages/subagent/tool-subagent/README.md` 的配置表（字段与含义照抄原文，未改措辞）：

| 字段 | 默认 | 含义（原文节选） |
|---|---|---|
| `provider` | 必填 | `ctx.subagents` 上的 provider 名（`spawn` / `fork` / `acp`） |
| `toolName` | `subagent` | 模型可见工具名；**distinct for every loaded instance** |
| `modelSelectionSettings` | `false` | 为每个顶层 Session 采样宿主的 exact-route 授权偏好 |
| `enableRunInBackground` | `true` | 是否暴露 `run_in_background` |
| `backgroundMode` | `one-shot` | 后台策略；`continuable` 需 provider 的 `prepareContinuable` |
| **`agentOptions`** | — | 子代理的 `provider` / `model` / `reasoningEffort` / `maxTokens` 默认值 |
| `persona` | — | **Per-child persona**；需 provider 的 `persona` capability |
| `toolFilter` | — | **Per-child global-tool restriction**；需 `toolFilter` capability |
| **`maxDepth`** | `3` | 绝对委派深度上限（`0` = 禁止再委派；`'provider-managed'` = 不向进程外 provider 下发上限） |

同页的用法句：**「Mount one instance per delegation target, each with a distinct `toolName`.」**

本文的论证只用其中四行加一个工具名（**`persona` / `toolFilter` / `maxDepth` / `agentOptions`** + `toolName`），其余是上下文；完整表以该 README 为准（**唯一来源**，勿在此维护副本）。

⇒ 「多角色」在上游不是能力缺口，而是**配置缺口**。

## 2. 官方 shipped preset：能力在，没有用【C】

`$DSH/packages/preset/agent-presets/presets/{standard,ptc}/agent.cordis.yml`：

| 行 | 内容 |
|---|---|
| `standard:181-187`、`ptc:188-194` | `tool-subagent`：`provider: spawn` · `toolName: subagent` · `modelSelectionSettings: true` · `backgroundMode: continuable` |
| `standard:193-198`、`ptc:200-205` | `tool-subagent-fork`：`provider: fork` · `toolName: subagent_fork` · `backgroundMode: continuable` |
| 两处均无 | `persona` / `toolFilter` / `maxDepth` / `agentOptions` |

## 3. 本仓 ptc-roles：五个角色行 = 同一机制的五个实例【C】

`preset/ptc-roles/agent.cordis.yml`：

| 角色 | 行（=`toolName` 所在行） | `maxDepth` |
|---|---|---|
| explorer | `:364` | 2 |
| librarian | `:387` | 2 |
| oracle | `:413` | 1 |
| implementer | `:434` | 1 |
| designer | `:462` | 1 |
| 通用委派 `subagent` | `:209` | 1 |

**每个角色行都设了全套 per-instance 字段**（`persona` + `toolFilter.allow` + `agentOptions` + `maxDepth`）—— 这正是 §1 那句用法句在运行时的落地形态。完整的角色职责与白名单见 [`README.md`](../README.md) 的角色表（**唯一归属，勿在此复制**）；通用委派行另设 `modelSelectionSettings: true`（`:211`）。

两个值得单独指出的细节：
- oracle 的 `toolFilter.allow` 里只有 `explorer` / `librarian` 两个委派工具（`:427-428`）——「能派、但不能乱派」的实例。
- implementer 的 shell 是**平台择一**的（`:454`：`process.platform === 'win32' ? 'pwsh' : 'bash'`）。

五个角色行都显式 `backgroundMode: continuable`（`:365` / `:388` / `:414` / `:435` / `:463`）。

**模型档是刻意分层的**，不是随手填的：oracle 用强档 + `high`；implementer 用强档 + `low` 并留了理由注释（`:440-443`，「executes an ALREADY-DECIDED plan … deep reasoning here is wasted spend」）。

## 4. 三处价值，逐条交代

### ① 一份已调对的配置 —— 成立，但省的是时间

上游给参数面；把它配成「五个互不重叠、白名单精确匹配 live 工具面、shell 按平台择一、深度公式正确」的角色，是配置工作 **+ 踩坑**。本仓真正的沉淀是那份坑账本，而且这些坑是**这套参数组合**的坑、不是框架的坑，上游文档不会写：
`pitfalls.md` `#7`（宿主注入的 `subagent` / `list_subagent_models` 掩不掉）/ `#10`（深度判据四层）/ `#11`（平台择一 shell 必须带引号）/ `#13`·`#14`（只读角色对 symlink 与目录条目结构性不可见）/ `#17`（`bash` 无条件算「动手」）。

### ② PTC 父 + native 子 —— 唯一算「机制性」的差异

主 agent 保持 PTC（`run_code`，省 token），角色子代理切 native（`toolFilter.allow` 才成为**硬**能力边界）。官方 `ptc` preset 只是把 `standard` 的呈现换成 SDK，**不提供这个组合**（§2：两处都没有 per-instance 裁剪）。
⇒ 这是 [ADR 0001](decisions/0001-role-preset-over-orchestration-bundle.md) 的立项理由（「为什么父必须是 PTC、子必须是 native」的唯一解释处在那里），但它仍是**组合**差异：任何人在自己的 preset 里配得出来。

### ③ 每角色模型档省不省钱 —— 未测，且是唯一可被证否的部分

「便宜档做侦察 / 强档做顾问与实现」目前是**猜的档位**；归因测量（ADR 0002 的 B 项）没做。数据在盘上（口径见 `pitfalls.md` #22），**未读**。

## 5. 对 ADR 0002 的一处措辞修正建议（本文只登记，不改那份文件）

ADR 0002 的价值腿表里，「上游是否提供」一栏把**发出去的配置**和**可用的机制**混成了一栏：

| ADR 0002 原措辞 | 本文核过之后应收紧为 |
|---|---|
| ①「❌ 上游只有通用 `subagent`，无按角色裁剪」 | 上游**提供** `toolFilter` / `persona` / `maxDepth` / `agentOptions` 的**每实例**参数面；**不提供**预先配好的角色 |
| ②「❌ 无」（每角色模型档） | 同上：参数面在（`agentOptions`），**角色化的档位**不在 |

这不改变 ADR 0002 的结论（继续演进、只保留两条价值腿），只改变「为什么」——**不是上游做不到，是上游不发**。

## 6. 未验证 / 勿当结论

- 【?】上游**未来**是否发角色化委派、或给 `subagent` 加「spawn 时选 preset」：本文只指出它会抹平 ②（条件押注归属：ADR 0002 表的 G 项），无法预测。
- 【?】③ 的判定需要「非自身仓库真实任务 + 成本归因」，两者今天都没有：窗口未计时（等 `0.1.6-rc.*`），归因未实现。
- 【?】配置被载入**可证**（判据是 `make verify` 各脚本打印的判定行），「因此行为 / 成本改善」**不可由配置证明** —— ADR 0002 的「验证充分、使用不足」正是这一格。

**复核触发（本文件的保质期）**：上游 checkout 换基线 · 本仓 `preset/ptc-roles/agent.cordis.yml` 增删角色行（§3 的行号会跟着漂）· 上游给 `subagent` 加「spawn 时选 preset」类参数 · `0.1.6-rc.*` 落地后重估 ③ —— 命中任一即重读并更新本文件。

## 7. 复现方法

```bash
# 上游参数面（本文 §1）
sed -n '1,60p'  $DSH/packages/subagent/tool-subagent/README.md

# 官方 preset 的两处通用委派行（本文 §2）
sed -n '181,205p' $DSH/packages/preset/agent-presets/presets/standard/agent.cordis.yml
sed -n '188,205p' $DSH/packages/preset/agent-presets/presets/ptc/agent.cordis.yml

# 本仓角色行（本文 §3）
grep -n 'toolName:\|maxDepth:\|backgroundMode:\|toolFilter:\|persona:' preset/ptc-roles/agent.cordis.yml

# 本 preset 的角色配置在运行时真的如此（判据是各脚本打印的判定行，不是条数）
make verify
```

（`$DSH` = 上游 checkout 根，本次为 `/Users/eric/Project/tests/deepseek-harness`。§2 / §3 的行号绑定上面那个基线；本仓 `agent.cordis.yml` 一旦增删角色行，那些行号就会漂 —— 所以第三条命令给的是**模式**，不是行号。）
