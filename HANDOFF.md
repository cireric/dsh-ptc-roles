# HANDOFF — agent-lanes（交接）

> 本文件只回答两件事：**现在什么状态**、**你接手后要验什么**。
> 长期内容不在这里（各归其位，见 `README.md` 的文档地图）；**也没有任何文档引用本文件** ——
> 所以它可以随时整份重写或删掉重建。
> 项目目录：`/Users/eric/Project/tests/dsh-plugins/cireric-dsh-agent-lanes`

## 0. 先确认你在哪个 preset 下

**你应该运行在 `agent-lanes` preset 下。** 两个自检：

1. 工具面里有 `explorer` / `librarian` / `oracle` / `implementer` / `designer` 五个**命名委派工具**
   （PTC 模式下它们在 `run_code` 的 SDK 里）。看不到 → 先让人在新会话里选 `agent-lanes`。
2. system prompt 里有 `## Specialists` 的 **6 列表**（含 `Topology`、`Mode` 两列）与 `## Delegation contract` 段。
   看不到 → 挂的是旧 persona。

## 1. 当前状态

**机制层面全绿**：装配无报错、native 翻转真生效（子代理 `run_code` 消失）、白名单对继承面精确遮蔽、
孙代升级堵死、加固那一代经宿主确认。

⚠️ **欠账＝第 4/5/6 轮「在宿主内是否生效」**：那几轮只验到「不依赖宿主的静态检查」（yml 过 loader
dialect 解析、persona 与白名单核对）这一层，**必须开新会话才算数**。清单见 §2。
**别按旧口径只查插件代次** —— 那件事已结清（逐轮记录见 `docs/evidence/README.md` 的「附」节）。

## 2. 你接手后要做什么（约 3 分钟）

1. **preset 挂上了**：§0 第 1 条那五个工具齐全，且直接可调的只有 `run_code`。
   mount 失败会 fail-fast 并指名 preset 内行的 id（排障见 `docs/pitfalls.md` C 节前两行）。
2. **第 5 轮纪律 persona 生效了吗**（自检，零成本）：即 §0 第 2 条。看不到 ⇒ persona 没被重读。
3. **新角色真能派出去吗**：派 1 个 `designer` 与 1 个 `implementer`（先派个只读的 `explorer` 也行），
   确认委派**不报错** —— model / allow / effort 写错会**响亮失败**（有意设计）。
4. **跑脚本核对**：

   ```bash
   node scripts/verify-agent-lanes.cjs                 # 期望 ✗0 !0
   node scripts/verify-lane-role-presentation.cjs      # 期望 11/11
   ```

   逐条看：
   - 主 agent 行**多出** `✓ 主 agent 载入 round-5 纪律 persona` —— 这是「纪律补全有没有生效」的
     **唯一数据面信号**（persona 不生效是静默的，`docs/pitfalls.md` #9）；
   - 刚派出的 `designer` 行 `role=designer ptc=no` **+ 白名单精确匹配（6 项）**；没派过就没有它的行，属正常；
   - 每个角色子代理行带一行 `⊘ 已知自身层泄漏（非白名单问题）: list_subagent_models, subagent` ——
     那是**已知且已定位**的现象（`docs/pitfalls.md` #7），**不是**白名单写错，别去「修」它。

**步骤 2–4 全对 ⇒ 就地验证债清零**；任何一项不对 ⇒ `docs/pitfalls.md` C 节排障表。

> **改名过渡态（第 6 轮）**：角色 `fixer` 已改名 `implementer`，所以**历史里 3 个 `fixer` 会话**会持续报
> `! WARN 没有 fixer 的期望白名单`（汇总显示 `✗0 !3`）。**验收前先删掉它们**再跑第 4 步 —— 已确认就是
> `~/.dsh/sessions/--Users-eric-Project-tests-dsh-plugins-cireric-dsh-agent-lanes--/` 下的
> `5ae1940b…` / `2c2ae2cd…` / `be45ee08…` 这三个。删完重跑，判据回到 `!0`；之后的新会话不再产生这种 WARN。
> （不做 LEGACY_ROLES 别名 —— 历史会话不复用，这是有意的取舍。）
