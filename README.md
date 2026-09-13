# agent-lanes

一个 DSH **agent preset**：orchestrator 主 agent + 四个有职责边界的角色子代理。

- 主 agent（orchestrator）保持 **PTC** 表现模式 —— 保住 dsh 的成本优化（一轮可连调多个工具）。
- 委托出去的角色子代理切 **native** —— 让 `toolFilter.allow` 成为**真正的能力边界**，而不是提示性配置。

为什么必须这样切：PTC 下子代理唯一可调的工具是 `run_code`，而 `run_code` 是**保留传输**
（`tools.restrict()` 拒绝命名它），且它跑在宿主进程的 worker 里、带 `fs`/`child_process`，
**绕过 DSH 文件沙箱** —— 也就是说 PTC 下「只读子代理」根本不成立。
完整论证见 [docs/decisions/0001](docs/decisions/0001-role-preset-over-orchestration-bundle.md)。

## 角色

| 角色 | 职责 | maxDepth | 白名单要点 | 模型档 |
|---|---|---|---|---|
| orchestrator | 意图门 / 拆解 / 搬派 / 对账 / 证据验证 | — | 全权限（不设 toolFilter） | 会话默认 |
| `explorer` | 代码侦察定位（只读、叶子） | 2 | read / grep / glob / lsp / codegraph | 便宜档 · low |
| `librarian` | 外部文档与库用法（只读、叶子） | 2 | read + web_search/web_fetch + context7 + gh-grep + exa | 便宜档 · medium |
| `oracle` | 只读顾问（可派 explorer/librarian） | 1 | read / grep / glob / lsp + **仅** explorer, librarian | 强档 · high |
| `fixer` | 有界实现（叶子 worker） | 1 | read/write/edit/glob/grep/bash/lsp/todo_write | 强档 · high |

> `maxDepth` 是子代理的**绝对深度上限**（`childDepth = parentDepth + 1`，超过即抛）。
> 主 agent 深度 0 ⇒ `maxDepth: 0` 会让它**一个子代理都派不出去**。
> 叶子性不靠 `maxDepth`（一个工具实例服务所有调用深度），靠**白名单不含任何角色工具名**。

## 安装

preset 源码在本仓库；DSH 从 `~/.dsh/.agent-presets/agent-lanes/` 读取。用**真目录 + 内部软链**
保持单一事实源（**不要**把整个目录做软链：发现逻辑用 `readdir(withFileTypes)` + `isDirectory()`，
目录软链会被**静默跳过**）：

```bash
mkdir -p ~/.dsh/.agent-presets/agent-lanes && cd ~/.dsh/.agent-presets/agent-lanes
R=~/Project/tests/dsh-plugins/cireric-dsh-agent-lanes/preset/agent-lanes
ln -s "$R/agent.cordis.yml" agent.cordis.yml
ln -s "$R/lane-role-presentation.mjs" lane-role-presentation.mjs
ln -s "$R/preset.yml" preset.yml
ln -s "$R/personas" personas
```

## 使用

新会话在 preset 选择器里选 `agent-lanes`，然后正常说话即可 ——
主 agent 会按 orchestrator persona 的意图门判断，并把独立轨道派给对应角色工具。

## 验证

```bash
node scripts/verify-agent-lanes.cjs        # --all 扫全部工作区；--raw 打印完整工具名列表
```

零模型成本：只读 `~/.dsh/sessions`，用 `request/header.header.tools`（**真正发给模型的**工具面）
判定每个会话的角色 / 模型 / 工具面 / 是否仍是 PTC，并与脚本内的期望白名单比对。期望：
主 agent `✓ 保持 PTC`；每个角色子代理 `✓ PASS native + 白名单精确匹配`，**并带一行
`⊘ 已知自身层泄漏（非白名单问题）: list_subagent_models, subagent`** —— 这是已知且已定位的现象
（HANDOFF §7.7），不是白名单写错。

## 目录

```
HANDOFF.md                      ← 下一个会话从这里开始（状态 / 冒烟 / 排障表 / 开发循环）
preset/agent-lanes/             ← 交付物（preset 本体）
scripts/verify-agent-lanes.cjs  ← 行为验证（零模型成本；含提权请求计数）
scripts/verify-lane-role-presentation.cjs ← 翻转插件单元校验（零成本，11 条断言）
docs/decisions/                 ← ADR：为什么是 preset、为什么子代理要 native
docs/evidence/                  ← 一次性探针的原始输出 + 复现方法
```

## 开发循环

- 改 `agent.cordis.yml` / `personas/*.md` → **开新会话即生效**（yml 每次新会话重读）。
- 改 `lane-role-presentation.mjs` → 先 `dev_reload_preset preset=agent-lanes`（bump `?v=N` 绕 ESM 缓存），**再开新会话**。
  ⚠️ 该工具只认**不带引号**的 `.mjs` 引用；写成 `name: './x.mjs'` 时它会回「无相对 .mjs 引用」并**静默空转**，
  新会话继续用旧代插件。改完确认输出含 `x.mjs -> ?v=N`。

## 约束

- 不修改官方框架（`deepseek-harness` 只读），修复一律在 preset/插件侧。
- 不 vendor 宿主内部代码。
- 插件**零 import**（preset 目录在 home 下，Node 解析不到 `@deepseek-ai/*`）。
- 失败必须可见（`logger.warn`，禁止空 catch / 静默跳过）。
- 装新依赖前 `plugin_check`、装后 `security_audit` 与基线 diff。

## 状态与剩余项

- ✅ **装配冒烟**（2026-09-13）。
- ✅ **行为冒烟 + 复验全绿**：`node scripts/verify-agent-lanes.cjs` → `✓7 ✗0 !0`；四个角色 native、
  工具面与白名单精确匹配。脚本对两个**已知自身层泄漏**工具容忍并**显式标注**（即「白名单 + 2」，
  根因见 HANDOFF §7.7），不把它们并进期望值。
- ✅ **翻转插件深度判据加固**：`node scripts/verify-lane-role-presentation.cjs` → `11/11`；
  旧版作阴性对照只有 `6/11`（证明断言能抓住「子代理静默留在 PTC」）。
  ⚠️ 上述 preset/插件改动**要新会话才算在宿主里生效**（`?v=1` 已 bump）。
- ✅ **sandbox-strip 结案：不做**。子代理 schema 确实暴露 `sandbox_permissions`/`justification`，
  但子会话的 `approval/policy` 是 `never` 且**先于任何 answerer** 确定性拒绝 ⇒ 提权构造上关闭、
  不可能弹给用户；本机 91 个会话零证据，也没有 per-agent 隐藏 schema 属性的官方钩子。
  改为在验证脚本里**检测**（当前角色子代理 0 次）。证据：
  `docs/evidence/2026-09-13-sandbox-escalation-closure.json`。
- ⏳ **按角色细粒度分发 skills**：技术上可达（见 ADR「被否决的替代方案」），推迟到 v1.1。
