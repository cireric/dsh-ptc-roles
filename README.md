# ptc-roles

本仓库提供**两个** DSH **agent preset**：

- **`ptc-gate`（本机选它）** —— PTC 主 agent + 意图门纪律，**不预置**角色子代理，委派按需发生。
  它是**本机有意只装的那一个**（不是上游默认：宿主组合里 `agent-preset-registry` 的 `config.default` 仍是 `standard`），
  且**未达**原毕业判据（成本判据已按 ADR 0002 重锚，见下）。
- **`ptc-roles`** —— 在 `ptc-gate` 的基础上再加五个有职责边界的角色子代理
  （explorer / librarian / oracle / implementer / designer），白名单即硬能力边界。

- 主 agent 保持 **PTC**（省 token），委托出去的子代理切 **native** —— 这样 `toolFilter.allow` 才是
  **真正的能力边界**，而不是提示性配置（**已知例外**：宿主注入的 `subagent` / `list_subagent_models`
  掩不掉，脚本按 `⊘ 已知自身层泄漏` 容忍并标注 —— 机制见 `docs/pitfalls.md` #7）。
  为什么必须这样切、否决过哪些方案：见
  [docs/decisions/0001](docs/decisions/0001-role-preset-over-orchestration-bundle.md)。

## 两个 preset 怎么选

**本机默认选 `ptc-gate`**（前提：bundle 已 `make deploy` 且它处于启用态）。只有当任务**同时**满足
下面 ≥3 条时，才改用 `ptc-roles` —— 它现在是**归档**态：把 `preset/ptc-roles/preset.patch.yml` 里声明行的
`disabled: true` 改成 `false`，跑 `make deploy`，再做一次真正的重新挂载。

| 条件 | 判据 |
|---|---|
| ① 每块说明能**小而自足** | 子代理只需父级上下文的一小部分（主-子**不共享前缀缓存**，喂全文契约给每个子块是最坏形态） |
| ② 接口能**派发前冻结一次** | 子块之间不需要来回协商 |
| ③ 每块**显著大于协调开销** | 并行能省下真实墙钟，且父级几乎没有串行尾巴 |
| ④ 本地**没有可执行裁判** | 有测试/脚本能判对错时，单 agent 直接对着裁判迭代更快更省 |

依据（三对配对、四层探针、机制读数与完整判据）：`docs/decisions/0002-continue-evolving.md` 的窗口读数；
原始记录：`docs/evidence/2026-09-2*-*arms-comparison.json`。**别在这里复述数字**（会漂）。

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

**0.2.0 起 preset 是一个 bundle，不再是一个目录**（机制见 `docs/pitfalls.md` A 节 / #31）：
本仓库自己就是那个 bundle —— `package.json` 的 `dsh.bundle.patch` 列出 `preset/<id>/preset.patch.yml`，
每个文件是一条 `@deepseek-ai/dsh-agent-preset` 声明行。安装 = 在 profile 里建一条指向本仓库的软链：

```bash
make deploy    # 写 profile 的 package.json（dependencies 加 link:<repo>）+ dsh.profile.bundles 追加
               # + 在 profile 目录 pnpm install ⇒ node_modules/<包名> 变成指向本仓库的软链
make check     # 对账：**已安装**的那一份 vs 仓库（依赖规格 / bundles 列表 / 软链 / 组成契约），漂移退 2
               # **未安装记 ⓘ、不算漂移**（「该不该装」是人的意图，检查器猜不到）
```

`make deploy` **不再接受 preset id**：一次装整个 bundle。要动个体，改对应声明行本身 ——
`ptc-gate` 启用、`ptc-roles` 归档（`disabled: true`）；把 `disabled` 改成 `false` 再 `make deploy`
就是「启用归档 preset」的全部动作。

**资产引用**：声明行里的相对 `name: ./x.mjs` 与 `!!js` 的 `baseUrl` **都解析到 profile 目录**（不是本仓库），
所以资产一律走包名子路径（`@cireric/dsh-ptc-roles/preset/<id>/x.mjs`）与
`createRequire(baseUrl).resolve('@cireric/dsh-ptc-roles/package.json')`。这条是迁移里最容易踩的坑，
`make verify` 的组成契约会拦住写法残留。

**生效**：装完必须有一次**真正的重新挂载**（宿主进程重启 / preset 重新装配）——
同一进程里新开会话**不算**（判据见 `docs/pitfalls.md` A 节）。

## 使用

新会话在 preset 选择器里选 **`ptc-gate`**（或按上一节的判据选 `ptc-roles`），然后正常说话即可 ——
主 agent 会按 orchestrator persona 的意图门判断；需要派活时它会用通用的 `subagent` 工具按需委派。

> 宿主默认 preset（宿主组合里 `agent-preset-registry` 的 `config.default`，0.2.0 起不再是 `settings.yaml` 的键）**不由本仓库改** —— 它现在是 `standard`；换默认值属于宿主的决定（可在 profile 补丁层覆盖那一行）。

## 验证

```bash
make verify    # 四个脚本（行为 / 插件单元 / 看门狗 / 框架契约）+ 组成契约
make control   # 两个阴性对照：断言有没有空转
```

| 脚本 | 它证明什么 |
|---|---|
| `verify-ptc-roles.cjs` | **行为**（零模型成本，只读 `~/.dsh/sessions`）：用 `request/header.header.tools`（**真正发给模型的**工具面）判定每个会话的角色 / 模型 / 工具面 / 是否仍是 PTC；内含四个自测（角色事实静态 / 行为工具名单一致性 / 归因计数 / 意图门统计）。工作区默认 = 本仓库根（`--cwd <path>` 覆盖）；**没有会话时判定行明说「行为判据本次未验证」**，zstd 缺失退 `2`。preset 身份读 `agent-preset/selected` **事件**（persona 正文只作 legacy 回退）；逐场打印**闸门拒绝**（成对判：行为工具 + `[intent-gate]` 理由）与**假拒候选**；`--arms` 给按 preset 分组的对照读数 |
| `verify-role-presentation.cjs` | 翻转插件的单元校验（深度判据四层，`docs/pitfalls.md` #10） |
| `verify-intent-gate-watchdog.cjs` | 看门狗的单元校验 + 契约一致性（**verbatim-gate 正则**（插件 ↔ reader 逐字同源）/ 六桶 / **存在要求**（门行在承载首个行为动作的那条消息里、且为首行，①）与闸门的不变量 ↔ persona 模板） |
| `verify-harness-contract.cjs` | **框架契约门禁** —— 升级 dsh 本体**前后各跑一次**：变红的那条直接指出 preset 侧要改哪一处（`--harness <checkout>`，默认 `~/.dsh/dsh-harness`） |

| `deploy-preset.cjs --compose` | **组成契约**（只读、只查仓库）：manifest 与 `preset/` 一一对应 + 启用/归档态（`ptc-gate` 启用、`ptc-roles` 归档）+ 角色行（`ptc-gate` **不得**有、`ptc-roles` 必须有五个）+ **门插件副本一致性** + **0.2.0 写法残留必须为零**（相对 `.mjs` 名 / `new URL('personas/…', baseUrl)` / 已删除的 `dsh-workflow-worker-thread`） |

**判据是各脚本自己打印的判定行** —— 不是退出码，也不是写进任何文档的断言条数（条数随改动变，抄进文档必漂）。
四支脚本 + 组成契约统一「0 = 本次运行符合预期」，`--control` 在预期失败数上同样退 0；断言集合由脚本内的
`REQUIRED_CONTROL_FAILURES` / 断言表定义，**多一条也是异常**（判据是集合相等）。契约门禁另有退出码 `2`：
目标 checkout 或契约载体读不到（**响亮失败**，绝不静默跳过）。

行为那支的期望读数：主 agent `✓ 保持 PTC`、每个角色子代理 `✓ PASS native + 白名单精确匹配`，并带一行
`⊘ 已知自身层泄漏` —— 那是已知且已定位的现象（`docs/pitfalls.md` #7），不是白名单写错。它同时打印
**意图门合规率（① 存在口径）**与**行为动作覆盖率**：分子分母都只算**会改变行为**的轮次
（要委派 / 要拒绝 / 要提问 / 要改文件），判据与看门狗插件共享同一份工具名单。① 只要求门行落在
**承载首个行为动作的那条消息**里、且为该消息首行；②「门行更早」与「可见回复 / 任意文本」只作对照
（「任意文本」含工具结果，读过插件源码的轮次也会命中，不作合规分子）。2026-09-30（verbatim-gate）起
另有**严格对照**读数（首行 = `Intent:` + 六桶之一，桶词+词边界；只对带 mode 标记的会话计算）与拒绝
理由三态分桶（MISSING/INVALID/LATE）；合规分子保持宽松。口径与历次基线：
`docs/pitfalls.md` #19（唯一登记处）。

> 改了 `preset/<id>/*.mjs` 或 `personas/*.md` 之后**必须做一次真正的重新挂载**（宿主重启 / preset 重新装配；同一进程里新开会话不算 —— 判据见 `docs/pitfalls.md` A 节）。
> 旧的 `dev_reload_preset`（bump `?v=N`）**已失效**：它硬编码 `.agent-presets`，且裸包名子路径不能带 query（#31）。

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
| `docs/2026-09-30-ptc-gate-real-task-test-plan.md` | 本次优化（verbatim-gate + 语义层 ②③④）**怎么用真实任务测**、测例与执行步骤 |
