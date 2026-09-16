# HANDOFF — ptc-roles（交接）

> 本文件只回答两件事：**现在什么状态**、**你接手后要做什么**。
> 长期内容不在这里（一文档一职责，见 `README.md` 的文档地图）；**也没有任何文档引用本文件** ——
> 所以它可以随时整份重写或删掉重建。
> 项目目录：`/Users/eric/Project/tests/dsh-plugins/cireric-dsh-ptc-roles`
> 本次重写：**2026-09-16**（上一版停在 09-15：读数、待办、脚本条数都已过期，故整份重写而非增补）。

## 0. 先确认你在哪个 preset 下

**你应该运行在 `ptc-roles` preset 下**（选择器里显示为「PTC 角色模式」）。两个自检：

1. 工具面里有 `explorer` / `librarian` / `oracle` / `implementer` / `designer` 五个**命名委派工具**
   （PTC 模式下它们在 `run_code` 的 SDK 里）。看不到 → 先让人在新会话里选这个 preset。
2. system prompt 里有 `## Specialists` 的 **6 列表**（含 `Topology`、`Mode`）与 `## Delegation contract` 段，
   且门行的模板是**英文 + 字面 token `Intent:`**。

## 1. 当前状态（2026-09-16）

- **宿主版本**：本机跑的是 `0.1.5-rc.2`（checkout `/Users/eric/Project/tests/deepseek-harness`，
  `git describe` = `dsh-v0.1.5-rc.2-139-gc291e7961a`）；本地**没有** 0.1.6 的 tag。
- **0.1.6 的处理方式（用户已定）**：它还在 alpha，**等 `0.1.6-rc.*` 再统一处理**，本轮不动 preset。
  版本事实与 rc 后的修复清单（P0–P3）唯一来源：`docs/dsh-v0.1.6-ptc-impact.md`。
- **运行时**：`~/.dsh/.agent-presets/ptc-roles/` = 真目录 + 内部 5 个软链 → 本仓库（已逐条核对）。
- **插件代次**：`role-presentation.mjs?v=6` / `intent-gate-watchdog.mjs?v=7`（`dev_reload_preset` 输出确认）。
  persona 与插件都是**挂载时读取** ⇒ 改完必须开新会话才生效（`docs/pitfalls.md` A 节）。
- **门行 token 迁移（2026-09-16）**：`意图判定` → **`Intent:`**（persona 模板与插件 `DEFAULT_MARKERS` 同步）；
  合规率脚本的 `INTENT_MARKERS` **同时**接受两个 token（插件看当轮=严、脚本扫历史=宽）。口径与理由：`docs/pitfalls.md` #19。
  ⚠️ **会话级代次边界**：迁移前挂载的会话里，看门狗只认旧 token —— 你按新 token 写，它仍会提醒一次，那不是漏行。
- **四项脚本的当前读数**（退出码契约：`0` = 本次运行符合预期）：

  | 脚本 | 期望 |
  |---|---|
  | `verify-ptc-roles.cjs` | `✓23 ✗0 !0`（含归因 / 角色事实静态 / 意图门统计三个自测） |
  | `verify-role-presentation.cjs` | `11/11`；`--control` 恰 5 项失败 |
  | `verify-intent-gate-watchdog.cjs` | `17/17`；`--control` 恰 9 条失败（判据是集合相等） |
  | `verify-harness-contract.cjs` | `✓13 ✗0`；读不到 checkout ⇒ 退出码 `2`（响亮失败） |

- **ADR**：0001 已补版本作用域（决定性证据第 1 行只对 0.1.5-rc.2 成立）与状态行；0002 状态已改「**已采纳**」，
  证据窗口标注「尚未计时」（A 项依赖 0.1.6），其 **C / D / E 三项已先行落地并自验**。
- **文档语言政策（2026-09-16 用户确认）**：正文中文；文件名 / 标识符 / 契约 token 用英文。
  **未落纸**（`AGENTS.md` 属规则文件，写入需人工确认）—— 别自作主张把正文翻成英文。
- **工作区状态**：`11` 个已改 + `8` 个未跟踪，**尚未提交**（提交是持久化操作，等你一句话）。
  其中含 09-15 复审轮那批从未提交的成果 —— 它与今天这批在 `README.md` / `docs/pitfalls.md` /
  `scripts/verify-ptc-roles.cjs` 三个文件里**交织在同一份 diff 里**，非交互拆分必然拆错。

## 2. 你接手后要做什么（按顺序）

1. **开一个新会话**（persona 与 `.mjs` 都是挂载时读取），跑 §0 的两条自检。
2. **跑四个脚本**（命令见 `README.md` 的「验证」段），确认仍是四绿；`--control` 的判定行也要看
   （退出码 `0` 不等于零失败）。
3. **等 `0.1.6-rc.*`**：升级**前后各**跑一次 `node scripts/verify-harness-contract.cjs --harness <checkout>`
   —— 它就是那次升级的差异报告（包改名那条还会给出疑似新名）；然后按 impact 文档的 P0–P3 执行，
   **P0-1 是 engine 行改名**（`workflow-worker-thread` → `workflow-ptc`，且别照抄官方的 `disabled: true`）。
4. **开证据窗口**（ADR 0002）：rc 之后计时，并当场记一条**带日期戳**的基线；口径必须带「口径 + 窗口 + 日期」
   （登记处 `docs/pitfalls.md` #19）。
5. **未结事项**（都已登记，别重复决策）：B（每角色成本归因 —— 窗口判定里「成本」那一侧能否测出改善全靠它）、
   F / G / H（条件押注）、`skills` 细粒度分发（`v1.1` 在仓内无定义，见 ADR 0001 的待办）、
   以及 **看门狗 / 验证基建 / 门行契约迁移三处仍无 ADR** —— 本轮裁定「只纠事实」，不补新决策记录。

## 3. 仍然验不了的

- **win32 平台分支**（本机无该平台）。
- **persona / 门行 / 看门狗提醒的「效用」**：文本被载入、提醒被注入都可证；「因此模型行为改变」不可由日志证明。
- **「拒绝」类轮次**：persona 要求门行，但从工具面认不出「只拒绝、不动手」的轮次 —— 已知的数据面边界。
