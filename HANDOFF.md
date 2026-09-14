# HANDOFF — ptc-roles（交接）

> 本文件只回答两件事：**现在什么状态**、**你接手后要做什么**。
> 长期内容不在这里（各归其位，见 `README.md` 的文档地图）；**也没有任何文档引用本文件** ——
> 所以它可以随时整份重写或删掉重建。
> 项目目录：`/Users/eric/Project/tests/dsh-plugins/cireric-dsh-ptc-roles`

## 0. 先确认你在哪个 preset 下

**你应该运行在 `ptc-roles` preset 下**（选择器里显示为 **「PTC 角色模式」**）。两个自检：

1. 工具面里有 `explorer` / `librarian` / `oracle` / `implementer` / `designer` 五个**命名委派工具**
   （PTC 模式下它们在 `run_code` 的 SDK 里）。看不到 → 先让人在新会话里选这个 preset。
2. system prompt 里有 `## Specialists` 的 **6 列表**（含 `Topology`、`Mode`）与 `## Delegation contract` 段。

> 两条自检 2026-09-15 都用**数据面**验过一次（system/message 事件里的 persona 文本 + SDK 块），见证据 ⑩。
> **改名背景**：本 preset 于 2026-09-14 由 `agent-lanes` 改名为 `ptc-roles`。历史证据按设计保留旧名，
> 对应关系见 `docs/evidence/README.md` 顶部。

## 1. 当前状态（2026-09-15 · 源码与运行时就绪，验证债清零）

- **改名已完成**：`preset/ptc-roles/`、`role-presentation.mjs`、`intent-gate-watchdog.mjs`、
  `scripts/verify-ptc-roles.cjs`、`scripts/verify-role-presentation.cjs`、`scripts/verify-intent-gate-watchdog.cjs`。
  面向人的活文档里旧名 **0 处**；冻结件（`docs/evidence/*`、`scripts/fixtures/*prev.mjs`）按设计保留原名。
- **运行时已切换**：`~/.dsh/.agent-presets/` 下**只有 `ptc-roles`**（真目录 + 5 个内部软链，全部指向本仓库；
  4 个文件 + 6 个 persona 的 sha256 与仓库逐一相同）。旧 preset 目录已不在。
- **宿主内验证已做两轮**：证据 ⑩（旧代：新 id 挂载 / explorer·implementer·designer 白名单精确匹配 / 看门狗注入）
  与证据 ⑫（**第二代 `?v=4`**：新 persona 文本载入、新看门狗**字节**载入、行为轮漏行被提醒 ×2、
  只读轮漏行**不**提醒 —— 同一会话内对照，eligibility 判据在真机成立）。
  ✅ **五个角色行全部在宿主内验过**：⑩ 覆盖 explorer / implementer / designer，⑬ 补上 `librarian`（8 项）与 `oracle`（6 项）—— 均 `ptc=no` + 白名单精确匹配。
- **本轮（2026-09-15）新落地**：
  - **门行补丁**：persona 的 Phase 0 由「每条消息都要输出」改成「**会改变行为的轮次才要**」
    （要委派 / 要拒绝 / 要提问 / 要改文件），首行改成
    `意图判定：<桶> — 你要的是 <用结果说>（依据：<你话里让我这么读的那一点>）；我打算 <做法>`；
    看门狗同步（**只提醒这类轮次**，判据取自数据面：`tool/call` 的 name，PTC 下经 `tool/ptc-dispatch` 的
    rootCallId 回映射）并把提醒文案对齐；验证脚本新增**意图门合规率**（逐轮判定 + 首行命中率，
    分子分母都只算会改变行为的轮次）。
  - **门行文案返工（G-5）**：用户指出门行的用途是**跟用户对齐需求**，而我写成了内部记账
    （turn 号 / 看门狗状态 / 证据文件名）—— persona 与看门狗 REMINDER 都已改成「复述需求 + 做法」，
    并点名禁止这类记账（凭证件：docs/evidence 证据 ⑪ 的 findings[4]）。措辞按上游 Sisyphus 原文返工：
    **v4.19.4 与 HEAD 的 Step 0 逐字相同**，而我们的移植丢了它的 `[reason]` 槽位 —— 本次补回为「依据：」（原文与 diff 见证据 ⑪ 的 `upstreamReference`）。
  - **`AGENTS.md` 规则 7** 补上第三条验证命令与 `dev_reload_preset` 那一句。
  - **`.mjs` 已 bump**：`role-presentation.mjs?v=4` / `intent-gate-watchdog.mjs?v=4`（`dev_reload_preset` 输出确认）。
  - ✅ **第二代（`?v=4`）已在自测会话里验过**（证据 ⑫，用 GUI 自动化新建的 7 轮会话 `session-d701ad55…`）。
    persona 与看门狗仍是「挂载时读取」⇒ 对这个长会话自身而言，**本会话仍是旧代**。
- **三项脚本当前全绿**：`verify-ptc-roles` `✓4 ✗0 !0`（含合规率）；`verify-role-presentation` 11/11
  （`--control` 恰 5 项失败）；`verify-intent-gate-watchdog` **20/20**（`--control` 失败在它自列的 10 条指定断言上）。

## 2. 你接手后要做什么（按顺序）

1. **开一个新会话**（必须：persona 与 `.mjs` 都是挂载时读取的），跑 §0 的两条自检。
2. **跑三套脚本**（命令与期望见 `README.md` 的「验证」段），确认仍是三绿。
3. **看一眼合规率**：`node scripts/verify-ptc-roles.cjs --raw` 会打印
   `意图门合规率: N 轮（会改变行为 M 轮）| 首行命中 x/M (p%) | 逐轮(首行): T1✗ T2✓ …`。
   新会话里门行应当**只出现在会改变行为的轮次**上；若只有读文件/查状态的轮次也被提醒，
   说明 eligibility 判据没生效（先看 `docs/pitfalls.md` 有没有新增条目）。
4. **还想推进的两件（都要人点头，本轮未做）**：
   - **提交**：工作区仍未提交（改名 + 看门狗 + 两份证据 + 本轮门行补丁）。
   - **旧副本处置**：`cireric-dsh-agent-lanes/`（已验证 `git status` 干净、HEAD=`f096621`）建议归档到
     `dsh-plugins/@archive/`；`~/.dsh/.agent-presets/agent-lanes/` 已经不在了。

## 3. 仍然验不了的

- **win32 平台分支**（本机无该平台）。
- **persona / 门行 / 看门狗提醒的「效用」**：文本被载入、提醒被注入都可证；"因此模型行为改变"不可由日志证明。
- （原先此处列的 `librarian` / `oracle` 白名单债已由证据 ⑬ 关闭。）
- **「拒绝」类轮次**：`persona` 要求门行，但看门狗/合规率无法从工具面识别"只拒绝不动手"的轮次 —— 已知边界。
