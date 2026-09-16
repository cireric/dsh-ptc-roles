# ptc-roles

一个 DSH **agent preset**：orchestrator 主 agent + 五个有职责边界的角色子代理。

- 主 agent 保持 **PTC**（省 token），委托出去的子代理切 **native** —— 这样 `toolFilter.allow` 才是
  **真正的能力边界**，而不是提示性配置（**已知例外**：宿主注入的 `subagent` / `list_subagent_models`
  掩不掉，脚本按 `⊘ 已知自身层泄漏` 容忍并标注 —— 机制见 `docs/pitfalls.md` #7）。
  为什么必须这样切、否决过哪些方案：见
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

preset 源码在本仓库；DSH 从 `~/.dsh/.agent-presets/ptc-roles/` 读取，那里要是**真目录 + 内部软链**
（把整个目录做软链会被发现逻辑**静默跳过**）：

```bash
mkdir -p ~/.dsh/.agent-presets/ptc-roles && cd ~/.dsh/.agent-presets/ptc-roles
R=~/Project/tests/dsh-plugins/cireric-dsh-ptc-roles/preset/ptc-roles
ln -s "$R/agent.cordis.yml" agent.cordis.yml
ln -s "$R/role-presentation.mjs" role-presentation.mjs
ln -s "$R/intent-gate-watchdog.mjs" intent-gate-watchdog.mjs
ln -s "$R/preset.yml" preset.yml
ln -s "$R/personas" personas
```

## 使用

新会话在 preset 选择器里选 `ptc-roles`，然后正常说话即可 ——
主 agent 会按 orchestrator persona 的意图门判断，并把独立轨道派给对应角色工具。

## 验证

```bash
node scripts/verify-ptc-roles.cjs               # 行为验证（--all 扫全部工作区；--raw 打全工具名）
                                             # 含三个自测：归因计数器 / 角色事实静态检查 / 意图门统计
                                             # （fixture: scripts/fixtures/{attribution,intent-gate}-cases.json）
node scripts/verify-role-presentation.cjs    # 插件单元校验（11 条断言；--control 必须恰 5 项失败）
node scripts/verify-intent-gate-watchdog.cjs  # 看门狗单元校验（17 条断言；--control 必须恰 9 项失败）
node scripts/verify-harness-contract.cjs      # 契约门禁（--harness <checkout>）—— **升级 dsh 本体前后各跑一次**
```

四个脚本的**退出码契约**统一为「0 = 本次运行符合预期」——`--control` 在预期失败数上也退 0，
所以判定要看脚本自己打印的那行（`阴性对照符合预期…`），不能只看 `$?`。
契约门禁另有一个 `2`：目标 checkout 或契约载体读不到（**响亮失败**，绝不静默跳过）。

零模型成本。第一个只读 `~/.dsh/sessions`，用 `request/header.header.tools`（**真正发给模型的**工具面）
判定每个会话的角色 / 模型 / 工具面 / 是否仍是 PTC：期望主 agent `✓ 保持 PTC`、每个角色子代理
`✓ PASS native + 白名单精确匹配`，并带一行 `⊘ 已知自身层泄漏` —— 那是已知且已定位的现象
（`docs/pitfalls.md` #7），不是白名单写错。

它同时打印**意图门合规率**（逐轮判定 + 首行命中率）。口径：分子分母都只算**会改变行为**的轮次
（要委派 / 要拒绝 / 要提问 / 要改文件），判据与看门狗插件共享同一份工具名单；「任意文本」一栏
含工具结果，只作对照、不作合规分子（读过插件源码的轮次也会命中）。

> 改了 `preset/ptc-roles/*.mjs` 之后必须 `dev_reload_preset preset=ptc-roles`（输出要含 `x.mjs -> ?v=N`）
> **并开新会话** —— 挂载时才读取，运行中的会话保持旧代（`docs/pitfalls.md` A 节）。

## 文档地图（每份文档只干一件事）

| 文档 | 它回答的唯一问题 |
|---|---|
| `README.md`（本文） | 这是什么、怎么装、怎么用、怎么验、有哪些角色 |
| `AGENTS.md` | 在这个仓库里 agent **必须遵守的规则**是什么（自动加载） |
| `docs/pitfalls.md` | 机制 / 坑 / 坏了怎么修 |
| `HANDOFF.md` | 现在什么状态、接手后要验什么（**临时交接件**，可整份重写） |
| `docs/decisions/` | 当初为什么这样设计、否决过什么 |
| `docs/evidence/` | 某个结论的原始输出、复现方法、逐轮验证记录 |
