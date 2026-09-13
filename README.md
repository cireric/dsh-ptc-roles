# agent-lanes

一个 DSH **agent preset**：orchestrator 主 agent + 五个有职责边界的角色子代理。

- 主 agent 保持 **PTC**（省 token），委托出去的子代理切 **native** —— 这样 `toolFilter.allow` 才是
  **真正的能力边界**，而不是提示性配置。为什么必须这样切、否决过哪些方案：见
  [docs/decisions/0001](docs/decisions/0001-role-preset-over-orchestration-bundle.md)。

## 角色

| 角色 | 职责 | maxDepth | 白名单要点 | 模型档 |
|---|---|---|---|---|
| orchestrator | 意图门 / 拆解 / 搬派 / 对账 / 证据验证 | — | 全权限（不设 toolFilter） | 会话默认 |
| `explorer` | 代码侦察定位（只读、叶子） | 2 | read / grep / glob / lsp / codegraph | 便宜档 · 不声明 effort |
| `librarian` | 外部文档与库用法（只读、叶子） | 2 | read + web_search/web_fetch + context7 + gh-grep + exa | 便宜档 · low |
| `oracle` | 只读顾问（可派 explorer/librarian） | 1 | read / grep / glob / lsp + **仅** explorer, librarian | 强档 · high |
| `implementer` | 执行给定的完整实施方案（叶子 worker；不做架构 / 调研 / 设计） | 1 | read/write/edit/glob/grep/**shell**/lsp/todo_write | 强档 · low |
| `designer` | UI/UX 视觉实现（叶子 worker，只管表现层文件） | 1 | read/write/edit/glob/grep/**shell** | 强档 · low |

> 列的含义（`maxDepth` 语义 / 叶子性怎么表达 / `shell` 为什么平台择一 / `!!js` 引号坑）见 `docs/pitfalls.md`。

## 安装

preset 源码在本仓库；DSH 从 `~/.dsh/.agent-presets/agent-lanes/` 读取，那里要是**真目录 + 内部软链**
（把整个目录做软链会被发现逻辑**静默跳过**）：

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
node scripts/verify-agent-lanes.cjs               # 行为验证（--all 扫全部工作区；--raw 打全工具名）
node scripts/verify-lane-role-presentation.cjs    # 插件单元校验（11 条断言）
```

零模型成本。前者只读 `~/.dsh/sessions`，用 `request/header.header.tools`（**真正发给模型的**工具面）
判定每个会话的角色 / 模型 / 工具面 / 是否仍是 PTC：期望主 agent `✓ 保持 PTC`、每个角色子代理
`✓ PASS native + 白名单精确匹配`，并带一行 `⊘ 已知自身层泄漏` —— 那是已知且已定位的现象
（`docs/pitfalls.md` #7），不是白名单写错。

## 文档地图（每份文档只干一件事）

| 文档 | 它回答的唯一问题 |
|---|---|
| `README.md`（本文） | 这是什么、怎么装、怎么用、怎么验、有哪些角色 |
| `AGENTS.md` | 在这个仓库里 agent **必须遵守的规则**是什么（自动加载） |
| `docs/pitfalls.md` | 机制 / 坑 / 坏了怎么修 |
| `HANDOFF.md` | 现在什么状态、接手后要验什么（**临时交接件**，可整份重写） |
| `docs/decisions/` | 当初为什么这样设计、否决过什么 |
| `docs/evidence/` | 某个结论的原始输出、复现方法、逐轮验证记录 |
