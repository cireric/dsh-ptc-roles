# HANDOFF — ptc-gate / ptc-roles（交接）

> 本文件只回答两件事：**现在什么状态**、**你接手后要做什么**。
> 长期内容不在这里（一文档一职责，见 `README.md` 的文档地图）；**也没有任何文档引用本文件** ——
> 所以它可以随时整份重写或删掉重建。
> 项目目录：`/Users/eric/Project/tests/dsh-plugins/cireric-dsh-ptc-roles`
> 本次重写：**2026-09-21**（承接 grill 轮的 Q1(b)/Q2/Q3–Q14；上一版停在 09-17）。
> ⚠️ **§1「当前状态」停在 2026-09-21**；2026-09-23 轮（闸门账 / 拒绝率分母 / 双 persona 契约 / `--snapshot`）
> 登记在 `docs/decisions/0003` 与 `docs/pitfalls.md` #19 / #28 / #29 / #30 —— 读之前先看本节日期。

## 0. 先确认你在哪个 preset 下

**本机只装 `ptc-gate`，这是有意的（2026-09-21 用户裁定）。** 两个自检：

1. 工具面**没有** `explorer` / `librarian` / `oracle` / `implementer` / `designer` 五个命名委派工具
   （薄版本不预置角色；要角色先 `make deploy ptc-roles` + 一次真正的重新挂载）。
2. system prompt 里有 `## Phase 0 — Intent Gate`，模板是**英文 + 字面 token `Intent:`**，
   且 Delegation 段第一句是 `This preset ships **no predefined roles**`（reader 的人口判据之一）。

## 1. 当前状态（2026-09-21）

- **部署形态**：`~/.dsh/.agent-presets/` 下只有 `ptc-gate`（真目录 + 4 条内部软链 → 本仓库）。
  `make check` 现在退 **0** —— 「未部署」自 2026-09-21 起记 ⓘ、**不算漂移**（对账只针对**已部署**的那一份：
  缺项 / 断链 / 指错 / 多余项）。`ptc-roles` 留在仓库里，按需 `make deploy ptc-roles`。
- **宿主默认**：`settings.yaml` 的 `agent-presets.default` 仍是 `standard`（宿主的事，本仓库不改）。
- **门插件代次（2026-09-21 三处新行为）**：以 `preset/<id>/agent.cordis.yml` 的 `?v=` 为准（本文件不登记数字，它每改必漂）。
  1. **模式标记**：每**会话**注入一行 `[intent-gate-watchdog] mode=enforce|observe` —— `config.gate` 写错会
     fail-safe 静默降级，而本部署没有日志通道（pitfalls #9），这行是数据面上唯一可查的证据；reader 拿它与
     `preset/<id>/agent.cordis.yml` 的**声明**对照（不一致 ⇒ ✗ FAIL）。
  2. **拒绝措辞分两子情形**（整轮无门行 / 门行晚于本次动手）。可达的只有前者 —— `declSeq <= carrier`
     一旦成立就必然成立（carrier 取"最后一条 assistant 消息"），这条**可达性事实**登记在 ADR 0003。
  3. **enforce 版假拒取证**：`RACE_REPORT` 在开闸后恒不注入（`wouldDeny && !denied` 不可能成立），
     竞态的可见形态换成它的镜像 **`FALSE_DENY`**（被拒过、而该轮最终仍判 ① 合规）⇒ **回滚条件**见 ADR 0003。
- **reader（`scripts/verify-ptc-roles.cjs`）新增**：
  · preset 身份读 `agent-preset/selected` **事件**（实测字段：`{"type":"agent-preset/selected","seq":4,"data":{"agentPreset":"ptc-gate"}}`，
    就在场次开头）；persona 正文只作 legacy 回退，两者不一致时打印 ⚠（不接退出码）。
  · **闸门拒绝读数**（成对判：行为工具 + 结果文本含 `[intent-gate]`；PTC 落 `tool/ptc-dispatch`+`isError`、
    native 落 `tool/result`）：逐场「拒绝 n / 恢复 m / 无门行继续 k ｜ 假拒候选」；口径登记在 pitfalls #19。
  · `--arms`：按 preset 分组的对照读数（四桶 + 轮/步归一；seeded 子会话一律排除，#22③）。
- **判据重锚（ADR 0002 新增段）**：成本（1.65–1.69×，两次配对，稳定）从判据里**摘出**，记为已知固定价；
  新判据落在数据面（拒绝率 + 恢复）。**预登记弱线的唯一登记处 = `docs/decisions/0003`** —— 本文件不再复制
  判据（交接件可整份重写，安全阀放这里等于没有：ADR 0003 的背景段自己就说过这句）。
- **本仓工作区实测（口径见 pitfalls #19，窗口 = 本仓库工作区，2026-09-21 当场）**：`session-5d9dcf8f`（ptc-gate）
  3 个 user-opened 轮 ⇒ ① 存在 2/3、拒绝 **1**、恢复 **1**、无门行继续 **0**、假拒候选 **0**；`汇总: ✓41 ✗0 !0`。
  ⚠️ 该场的**模式标记缺席**是预期的：它挂载于标记引入**之前**（见 §2 第 1 步）。
- **未结事项**：B（每角色成本归因）/ F（并发上限）/ G（Team 模式）**随 `ptc-roles` 一起挂起**；
  H（explorer / librarian 无 shell）对 `ptc-gate` **不存在**（没有角色）；`skills` 细粒度分发仍未定义
  （`v1.1` 在仓内无定义，见 ADR 0001 待办）；**「看门狗 / 验证基建 / 门行契约迁移三处无 ADR」中的门契约那处已结**
  （ADR 0003），另两处仍未结。

## 2. 你接手后要做什么（按顺序）

1. **逼一次真正的重新挂载**（宿主重启，或让 preset 重新装配）—— 插件与 persona 都是**挂载时读取**，
   同一进程里新开会话**不算**（判据与三次实测：`docs/pitfalls.md` A 节）。
2. **`make verify` + `make control` + `make check`**：判据是**各脚本打印的判定行**，不是退出码，
   也不是任何文档里的断言条数（条数随改动变，抄进文档必漂）。期望：四支脚本 + 组成契约全绿、
   `make control` 判「失败集合恰等于 `REQUIRED_CONTROL_FAILURES`」、`make check` 退 0。
3. **新会话里核对代次真的换了**：reader 的那行应变成 `模式标记 enforce`（仍是「缺席」⇒ 没换）。
4. **看一眼回滚触发条件**：reader 的 `｜ 假拒候选 n`；**n > 0 ⇒ 把 `preset/ptc-gate/agent.cordis.yml` 的
   `gate: enforce` 改回 `observe`**（ADR 0003）。
5. **等 `0.1.6-rc.*`**（不变）：升级**前后各**跑一次 `node scripts/verify-harness-contract.cjs --harness <checkout>`；
   P0-1 仍是 engine 行改名（`workflow-worker-thread` → `workflow-ptc`，且别照抄官方的 `disabled: true`）。

## 3. 仍然验不了的

- **win32 平台分支**（本机无该平台）。
- **persona / 门行 / 看门狗提醒的「效用」**：文本被载入、提醒被注入都可证；「因此模型行为改变」不可由日志证明。
- **「拒绝」类轮次**：persona 要求门行，但从工具面认不出「只拒绝、不动手」的轮次 —— 已知的数据面边界。
- **门行的内容质量**：插件只做 marker 匹配（#16）；「这行是不是记账」没有可靠判据。
- **假拒候选只覆盖一种竞态形状**：它把「门行的 assistant/message 事件比 pre-execute 晚到」变成可证伪，
  但**验不了**反向（真拒绝被时序掩盖成「看起来合规」）。
