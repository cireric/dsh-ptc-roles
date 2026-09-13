# ADR 0001 — 角色化 preset 取代编排 bundle（agent-lanes）

- 日期：2026-09-13
- 状态：**已采纳**（v1 preset 已实现并**复验通过**，2026-09-13 —— 装配冒烟 + 行为冒烟全绿，
  原始证据 `docs/evidence/2026-09-13-v1-reverify.json`，复现方法见同目录 `README.md` 第 4 节）
- 取代并删除：`docs/specs/2026-09-13-dsh-agent-lanes-design.md` ——
  那份「编排 bundle：lane 账本 + 并发闸门 + 只读面板」的设计，本文保留其决策依据，正文已删。

## 背景

用户经常需要 3 条以上独立工作流并行、且状态跨回合存活，痛感四条：
可观测性 / 依赖顺序 / 成本失控 / 汇总验收。
最初的方案是自建 **bundle 插件**：per-session JSON lane 账本 + 并发闸门 + 只读面板 + `lane_collect` 汇总。

## 为什么放弃 bundle

1. 按宿主源码逐条核对后，四条痛点里**原生已覆盖大半**：`list_agents` 给出跨重启的 roster
   （`ready` 态即持久化的子代理）、`subagentTiming` 投影给每个子代理 `settledMs`、
   结算通知把子代理最终消息带回对话。
2. 真缺口只剩两个且都很薄：**并发上限**（原生确实没有任何 cap）、**按 lane 的 token/cost 归因**
   （原生只有 timing，无 cost projection）。
3. 而代价很重：client 面板 + 构建管线 + 两个未验证风险（`sidebar.panellist` 必须成对注册同名 main 面板
   否则点击直接 throw；client 构建管线走 `window.__ModuleLoader__`）。

## 为什么落到「角色化 preset」

用户的真实需求被重述为**有职责边界的角色**（orchestrator / explorer / librarian / oracle / fixer），
而不是「lane 簿记」。角色化真正买到的只有三样：`toolFilter` 的**硬能力边界**、persona 以 system prompt
作用域生效、每角色独立模型档——而这三样**天然是会话组合问题**，归属是 preset：
bundle 是 profile 级，做不到「只让角色会话 native、日常会话保持 PTC」。

## 决定性证据（v1 设计的前提）

| 结论 | 证据 |
|---|---|
| PTC 模式下「只读角色」不成立 | `run_code` 是保留传输，`tools.restrict()` 拒绝命名它；它跑在宿主进程的 worker 里，有 `fs`/`child_process`/`process`，**绕过 DSH 文件沙箱**（A/B 对照：同一工作区外路径 bash 写入被拒、`run_code` 写入成功） |
| 解法：子代理切 native | `modeFor` 沿 scope 链近层优先；子代理经 `composeFrom` → `bindScopeParent` 绑在父 preset scope 之下，因此在**子代理自己的 scope** 上 `presentAs('native')` 可覆盖 preset 的 PTC；且必须在 `agent/created`（一步的 prompt/工具装配发生在 `agent/pre-step` **之前**） |
| 角色能拿到 MCP 工具 | 8 个历史子会话实际调用过 `mcp__playwright__*`/`mcp__exa__*`/`mcp__github__*`；agent 作用域视图 157 工具 / 81 个 `mcp__*` |
| 白名单可精确生效 | allow 语义 runtime 实测：157 → 6（5 个白名单项 + `run_code` 保留项） |
| `maxDepth` 语义 | `childDepth = parentDepth + 1`，超过即抛 `SubagentDepthError`。主 agent 深度 0 ⇒ **`maxDepth: 0` 会拒绝一切委派**（遗留自建方案在此处是错的） |
| persona 字段 | `@deepseek-ai/dsh-persona` 的 Config 是 `prefix`（必填），**没有 `text`**（0.1.3-alpha.2 改名；只带旧字段会让整个 preset 挂载失败） |
| 角色 prompt 不伤主 agent 前缀缓存 | persona/toolFilter 是 child-scoped（`persona` section / `restrict()`），不进主 agent system prompt |

## 被否决的替代方案

- **第三方框架**（NanmiCoder/dsh-agent-teams 等）：31 个 open issue 恰好命中成本失控
  （#96 太烧 token / #97 无全局并发上限 / #117 OOM / #151 死循环），且宿主同线兼容出过问题；
  其 `role-subagent.js` 是 572 行宿主 `tool-subagent` 副本——vendor 宿主内部代码，违背本项目价值观。
  完整选型复查见 Mnemon 文档 `12325908`。
- **全 PTC 角色**：三个「只读」角色名不副实（`run_code` 仍可写任意文件）。
- **全 native preset**：主 agent 每轮吃全量工具 schema（157 个），与 dsh「前缀缓存/成本优化」的定位冲突。
- **进程外 provider 承载只读角色**：`acp`/`codex`/`claude-code` 的 start capabilities 全 `false`，
  `dsh-sdk` 只支持 `agentOptions` —— persona/toolFilter **带不过去**。
- **按角色细粒度分发 skills**：技术上可达（web 部署把 host 层 `skill-filesystem` 禁用 ⇒ preset 拥有本地
  发现权；`ctx.skills.register()` 的近层同名覆盖可遮蔽不该有的 skill，且零 import），
  但 v1 不做，推迟到 v1.1。

## 后果

- **放弃**：可观测面板、跨会话 lane 账本、并发/预算闸门、`lane_collect` 汇总、
  以及原规格的两个未验证风险（R1 sidebar slot、R6 client 构建管线）。
- **代价**：改角色模型/persona 要编辑 preset 文件（无 GUI、无热更新）；MCP 工具改名会让 preset **挂载失败**
  （allow 白名单的未知名 = 响亮失败，这是有意设计）。
- **待办**：skills 细粒度分发（推迟到 v1.1）。
- **sandbox-strip 已结案（2026-09-13）**：原以为「子代理 schema 暴露 `sandbox_permissions`/`justification`
  会烧 turn」，取证后**不做** —— 子会话 `approval/policy = never` 在 answerer 之前就确定性拒绝，
  提权构造上不可用，且没有 per-agent 隐藏 schema 属性的官方钩子；改为在验证脚本里持续检测。
- **已决的残余风险**（2026-09-13，HANDOFF §8）：①翻转插件的深度判据已对齐框架口径
  `Math.max(header ?? 0, options.subagentDepth ?? 0)` 并加 `origin === 'subagent'` 兜底
  （HANDOFF §7.10；断言 `scripts/verify-lane-role-presentation.cjs`，旧版作阴性对照）
  ②librarian 的 `reasoningEffort: low` 经复验认为够用（答案正确且有权威来源），保持。
  ③`dev_reload_preset` 需引用不带引号才生效（HANDOFF §4），已改。

## 指针

- 操作手册 / 冒烟 / 排障表：`HANDOFF.md`
- 一次性探针证据与复现方法：`docs/evidence/`
