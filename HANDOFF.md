# HANDOFF — agent-lanes（交接）

> 本文件只回答两件事：**现在什么状态**、**你接手后要做什么**。
> 长期内容不在这里（各归其位，见 `README.md` 的文档地图）；**也没有任何文档引用本文件** ——
> 所以它可以随时整份重写或删掉重建。
> 项目目录：`/Users/eric/Project/tests/dsh-plugins/cireric-dsh-agent-lanes`

## 0. 先确认你在哪个 preset 下

**你应该运行在 `agent-lanes` preset 下。** 两个自检：

1. 工具面里有 `explorer` / `librarian` / `oracle` / `implementer` / `designer` 五个**命名委派工具**
   （PTC 模式下它们在 `run_code` 的 SDK 里）。看不到 → 先让人在新会话里选 `agent-lanes`。
2. system prompt 里有 `## Specialists` 的 **6 列表**（含 `Topology`、`Mode` 两列）与 `## Delegation contract` 段。
   看不到 → 挂的是旧 persona。

## 1. 当前状态（2026-09-14）

**验证债清零。** 第 4/5/6 三轮「在宿主内是否生效」已结清，记录 = `docs/evidence/README.md` 第 9 节 +
`docs/evidence/2026-09-14-round4-5-6-in-host-verification.json`（含逐字原始输出）：

- **designer 首次在宿主里真正挂载**：`role=designer ptc=no tools=8`（白名单 6 项 + 2 项已知泄漏）——
  证据 ⑦ 原先记的边界（「designer 从未在任何宿主挂载过」）关闭。
- **implementer（原 fixer）同形**：`tools=10`（白名单 8 项 + 2）；`--all` 全量扫描**无 fixer WARN 残留**。
- **round-5 纪律 persona 已载入**：脚本判定 + 编排器自读 system prompt 双证（**仅证载入、不证效用**）。
- 主 agent 仍 **PTC**（`tools=[run_code]`）；三角色子代理**零提权**；`--all` 下其他工作区非零 ⇒ 计数器非空转。
- 附带一次**真实触发**：explorer 调它自身层泄漏的 `subagent` → `Error: subagent depth 2 exceeds maxDepth 1`，**无孙代**。
- 顺手复核：部署路径 4 个软链 + 10 个文件 sha256 与仓库**逐一相同**；yml↔`EXPECTED` 白名单
  **5 角色 / 33 项零漂移**；插件单元 **11/11** 且阴性对照**恰 5 项失败**。

## 2. 你接手后要做什么

**A. 工作树未提交**（`git status`）：

| 状态 | 文件 | 来源 |
|---|---|---|
| `M` | `AGENTS.md`、`HANDOFF.md` | 本轮**开始之前**就存在的既有改动（文档重构遗留） |
| `M` | `docs/evidence/README.md` | 本轮结清时新增第 9 节 + 刷新轮次账本 |
| `??` | `docs/evidence/2026-09-14-round4-5-6-in-host-verification.json` | 本轮结清时新建的证据记录 |

要不要落盘成提交，**由你定 —— 不擅自提交**。（`scratch/` 与 `.codegraph/` 被 gitignore 覆盖，不进工作树。）

**B. `scratch/` 是一次性产物（gitignore 覆盖），可整目录删**：

| 文件 | 是什么 |
|---|---|
| `designer-role-cards.html`（589 行） | designer 角色的冒烟产物：自包含角色卡，零外链、零 `<script>` |
| `check-allowlist-drift.cjs`（387 行） | yml↔`EXPECTED` 的漂移检测器（实测 exit 0，无漂移）。**不是仓库资产** |

想留下哪个就搬到正式位置并补文档；不留直接删。

**C. explorer 的元数据盲区（已结案）**：explorer / librarian 白名单里**没有 shell**，所以 `ls` /
`readlink` / `shasum` / `stat` 一类文件系统侦察**结构性做不到**。本轮编排器把这类任务派给了 explorer，
它如实回「做不到」而**没有编造** —— 这是编排器任务规格写错，反过来也是白名单生效的正面证据。
**结论、路由约定与「刻意不做」清单已落 `docs/pitfalls.md` #13 / #14**（含将来的升级路径）；
这里只留指针不重述，避免出现第二份副本。

**D. 仍然验不了的**：win32 平台分支（本机无该平台）；round-5 persona 的**效用**（文本载入可证、行为效用测不出）；
`skills` 细粒度分发（推迟 v1.1）。

## 3. 复验命令（约 1 分钟，零模型成本）

```bash
node scripts/verify-agent-lanes.cjs --raw                 # 主 agent 行必须 ✓ 保持 PTC + round-5 persona
node scripts/verify-lane-role-presentation.cjs            # 期望 11/11
node scripts/verify-lane-role-presentation.cjs --control  # 期望恰 5 项失败（否则断言空转）
```

逐条看：
- **主 agent 行**：`✓ 主 agent 保持 PTC` + `✓ 主 agent 载入 round-5 纪律 persona` —— 后者是「纪律补全
  有没有生效」的**唯一数据面信号**（persona 不生效是静默的，`docs/pitfalls.md` #9）。
- **角色行**（派过才有）：`role=<名> ptc=no` + `✓ PASS native + 白名单精确匹配（N 项）`；
  explorer 5 / librarian 8 / oracle 6 / implementer 8 / designer 6（`--raw` 打全工具名）。
- **每行带的** `⊘ 已知自身层泄漏（非白名单问题）: list_subagent_models, subagent` —— 那是**已知且已定位**
  的现象（`docs/pitfalls.md` #7），**不是**白名单写错，**别去「修」它**。
- 汇总应为 `✗0 !0`（`!` 非零 ⇒ 有认不出角色或未登记角色的会话）。

任何一项不对 ⇒ `docs/pitfalls.md` C 节排障表。
