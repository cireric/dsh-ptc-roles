# HANDOFF — ptc-gate / ptc-roles（交接）

> 本文件只回答两件事：**现在什么状态**、**你接手后要做什么**。
> 长期内容不在这里：机制 / 坑在 `docs/pitfalls.md`，为什么这样设计在 `docs/decisions/`，
> 逐轮验证记录与未结事项在 `docs/evidence/README.md`（各自职责见 `README.md` 的文档地图）。
> 除文档地图把它列出来之外，**没有任何文档依赖它** ⇒ 可随时整份重写。
> 项目目录：`/Users/eric/Project/tests/dsh-plugins/cireric-dsh-ptc-roles`
> 本次重写：**2026-09-23**（上一版停在 09-21，且那一版 §2 的第 1 步「逼一次真正的重新挂载」**已经做完**）。

## 0. 先确认你在哪个 preset 下

**本机只装 `ptc-gate`**（`~/.dsh/.agent-presets/` 下只有它；`ptc-roles` 留在仓库里、按需
`make deploy ptc-roles`）。宿主 `settings.yaml` 的 `agent-presets.default` 当前 = **`ptc-gate`**
（宿主侧设置，本仓库不改它）。

三个自检（都对，才算站在预期形态上）：

1. 工具面**没有** `explorer` / `librarian` / `oracle` / `implementer` / `designer` 五个角色工具
   —— 薄版本不预置角色；要角色得先部署 `ptc-roles` 并做一次**真正的重新挂载**（A 节）。
2. system prompt 里有 `## Phase 0 — Intent Gate`，模板是**英文 + 字面 token `Intent:`**，
   且 Delegation 段第一句是 `This preset ships **no predefined roles**`。
3. `make verify` 的输出里有 `✓ 主 agent 载入的是**含程序契约段**的那一代 persona` ——
   它同时证明「挂载代次是新的」。老会话会打 `⊘ 早于程序契约下界`，**那不是失败**（时间锚）；
   要看 `✓` 就开一个**新会话**。

## 1. 当前状态（2026-09-23）

- **部署**：`~/.dsh/.agent-presets/` 只有 `ptc-gate`（真目录 + 内部软链 → 本仓库）；`make check` 退 0。
- **门**：`gate: enforce`。每**会话**注入一行 `[intent-gate-watchdog] mode=…` —— 本部署没有日志通道，
  这行是「配置有没有静默降级」**唯一**的数据面证据。
- **判据与安全阀**：拒绝率（user-opened **行为轮**口径）+ 恢复，reader 逐场打印 `闸门账`；
  **预登记弱线的阈值、分母、回滚条件的唯一登记处 = `docs/decisions/0003`**（本文件不复述阈值）。
- **读数留档**：会话库是滚动窗口（#15）⇒ 要留档就用 reader 的 `--snapshot <path>`（只写那一个文件，
  不含 token 桶）；最近一份是证据 ⑱。
- **persona 代次**：09-23 落地的两句 PTC 程序契约（每个 `tools.*` 包 try/catch、大常量只构造一次）
  已进两份 persona，并在一次**真正的重新挂载**后取证；reader 有常设断言盯着它。
- **持久化**：本仓库 **2 个提交未 push**（`e6aa626` 代码 / `a9a706a` 文档；本地 `main` 领先 `origin/main`）。
- **未结事项**的唯一登记处 = `docs/evidence/README.md` 的 §仍未做（本文件不复制它的清单）。

## 2. 你接手后要做什么（按顺序）

1. **`make verify` + `make control` + `make check`**：判据是**各脚本打印的判定行**，不是退出码，
   也不是任何文档里的断言条数（条数随改动变，抄进文档必漂）。
2. **核对代次真的换了**：reader 的两行 —— `模式标记` 不是「缺席」，且 `✓ …含程序契约段…那一代`。
   ⚠️ 判据是**最后一次挂载**（最后一条 `system/message` 的 `time`），**不是**会话的 `createdAt`：
   resume 会换上新代却保留旧 `createdAt`（pitfalls A 节）。
3. **看一眼回滚条件**：reader 的 `｜ 假拒候选 n`；处置规则在 `docs/decisions/0003` —— 别在这里找阈值。
4. **要不要 push**：本地 `main` 领先 `origin/main`（`git@github.com:cireric/dsh-ptc-roles.git`）。
   发布是独立动作：**未获明确请求不要 push**。
5. **等 `0.1.6-rc.*`**：升级**前后各**跑一次 `node scripts/verify-harness-contract.cjs --harness <checkout>`；
   升级清单与已知会破的点（engine 行改名 `workflow-worker-thread` → `workflow-ptc`，且别照抄官方的
   `disabled: true`）在 `docs/dsh-v0.1.6-ptc-impact.md`。

## 3. 别浪费时间试图验的（各有登记处）

- **persona / 门行 / 提醒的「效用」**：文本被载入、提醒被注入都可证；「因此行为改变」不可由日志证明。
- **门行的内容质量**：插件只做 marker **子串**匹配，判不出这行是不是记账（pitfalls #16）。
- **「拒绝」类轮次**：从工具面认不出「只拒绝、不动手」的轮次 —— 已知的数据面边界。
- **win32 平台分支**：本机无该平台（见 §仍未做）。
- **假拒候选只覆盖一种竞态形状**：它把「门行的消息事件比 pre-execute 晚到」变成可证伪，
  但**验不了**反向（真拒绝被时序掩盖成「看起来合规」）。
