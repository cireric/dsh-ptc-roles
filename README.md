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

preset 源码在本仓库；DSH 从 `~/.dsh/.agent-presets/ptc-roles/` 读取，那里必须是**真目录 + 内部软链**
（把整个目录做软链会被发现逻辑**静默跳过**）：

```bash
make deploy   # 建真目录 + 内部软链；目标已存在时会先列出差异并问 y/N
make check    # 对账：当前部署 vs 仓库（缺项 / 断链 / 指错 / 多余），漂移退 2
```

部署清单由 `scripts/deploy-preset.cjs` **自动发现** `preset/<id>/` 的全部顶层条目（跳过点文件）——
加一个插件文件不需要改任何文档，也不再有三处手抄的 `ln -s` 清单。

**形态**：内部条目一律软链。副本**也能跑**（与官方内置 preset 同形：真目录 + 真文件），但它会跟
`dev_reload_preset` 冲突 —— 那个工具改写的是部署目录里那份 `agent.cordis.yml`，软链会**透过链接写回本仓库**
（这就是 `git status` 里那份 M 的来源），副本则让 bump 落在没人读的拷贝上、仓库源静默不同步。
唯一的硬规则：**别把 `ptc-roles` 目录本身做成软链**（会被发现逻辑静默跳过）。
机制细节见 `docs/pitfalls.md` A 节。

## 使用

新会话在 preset 选择器里选 `ptc-roles`，然后正常说话即可 ——
主 agent 会按 orchestrator persona 的意图门判断，并把独立轨道派给对应角色工具。

## 验证

```bash
make verify    # 四个脚本：行为 / 插件单元 / 看门狗 / 框架契约
make control   # 两个阴性对照：断言有没有空转
```

| 脚本 | 它证明什么 |
|---|---|
| `verify-ptc-roles.cjs` | **行为**（零模型成本，只读 `~/.dsh/sessions`）：用 `request/header.header.tools`（**真正发给模型的**工具面）判定每个会话的角色 / 模型 / 工具面 / 是否仍是 PTC；内含四个自测（角色事实静态 / 行为工具名单一致性 / 归因计数 / 意图门统计）。工作区默认 = 本仓库根（`--cwd <path>` 覆盖）；**没有会话时判定行明说「行为判据本次未验证」**，zstd 缺失退 `2` |
| `verify-role-presentation.cjs` | 翻转插件的单元校验（深度判据四层，`docs/pitfalls.md` #10） |
| `verify-intent-gate-watchdog.cjs` | 看门狗的单元校验 + 契约一致性（插件 token / 六桶 / **存在要求**（门行在承载首个行为动作的那条消息里、且为首行，①）与闸门的四条不变量 ↔ persona 模板） |
| `verify-harness-contract.cjs` | **框架契约门禁** —— 升级 dsh 本体**前后各跑一次**：变红的那条直接指出 preset 侧要改哪一处（`--harness <checkout>`，默认 `~/.dsh/dsh-harness`） |

**判据是各脚本自己打印的判定行** —— 不是退出码，也不是写进任何文档的断言条数（条数随改动变，抄进文档必漂）。
四个脚本统一「0 = 本次运行符合预期」，`--control` 在预期失败数上同样退 0；断言集合由脚本内的
`REQUIRED_CONTROL_FAILURES` / 断言表定义，**多一条也是异常**（判据是集合相等）。契约门禁另有退出码 `2`：
目标 checkout 或契约载体读不到（**响亮失败**，绝不静默跳过）。

行为那支的期望读数：主 agent `✓ 保持 PTC`、每个角色子代理 `✓ PASS native + 白名单精确匹配`，并带一行
`⊘ 已知自身层泄漏` —— 那是已知且已定位的现象（`docs/pitfalls.md` #7），不是白名单写错。它同时打印
**意图门合规率（① 存在口径）**与**行为动作覆盖率**：分子分母都只算**会改变行为**的轮次
（要委派 / 要拒绝 / 要提问 / 要改文件），判据与看门狗插件共享同一份工具名单。① 只要求门行落在
**承载首个行为动作的那条消息**里、且为该消息首行；②「门行更早」与「可见回复 / 任意文本」只作对照
（「任意文本」含工具结果，读过插件源码的轮次也会命中，不作合规分子）。口径与历次基线：
`docs/pitfalls.md` #19（唯一登记处）。

> 改了 `preset/ptc-roles/*.mjs` 之后必须 `dev_reload_preset preset=ptc-roles`（输出要含 `x.mjs -> ?v=N`）
> 改了 `preset/ptc-roles/*.mjs` 之后必须 `dev_reload_preset preset=ptc-roles`（输出要含 `x.mjs -> ?v=N`）**并确保一次真正的重新挂载**（**宿主重启 / preset 重新装配**才算；同一进程里新开会话不算 —— 判据见 `docs/pitfalls.md` A 节）；仍在运行的会话保持旧代。

## 文档地图（每份文档只干一件事）

| 文档 | 它回答的唯一问题 |
|---|---|
| `README.md`（本文） | 这是什么、怎么装、怎么用、怎么验、有哪些角色 |
| `AGENTS.md` | 在这个仓库里 agent **必须遵守的规则**是什么（自动加载） |
| `docs/pitfalls.md` | 机制 / 坑 / 坏了怎么修 |
| `HANDOFF.md` | 现在什么状态、接手后要验什么（**临时交接件**，可整份重写） |
| `docs/ptc-roles-value-vs-upstream.md` | 官方既能委派，这个 preset 还剩什么价值（上游参数面 / 官方 preset / 本仓角色行的逐行对照） |
| `docs/decisions/` | 当初为什么这样设计、否决过什么 |
| `docs/evidence/` | 某个结论的原始输出、复现方法、逐轮验证记录 |
