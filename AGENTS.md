# AGENTS.md — agent-lanes

## 项目一句话

DSH agent preset：orchestrator 主 agent（PTC）+ `explorer`/`librarian`/`oracle`/`fixer` 四个角色子代理
（native，`toolFilter.allow` 即硬能力边界）。

## 开工必读

- **接手 / 冒烟 / 排障：`HANDOFF.md`**（含「症状 → 原因 → 修法」表）
- 决策与依据：`docs/decisions/0001-role-preset-over-orchestration-bundle.md`
- 探针与冒烟证据 + 复现方法：`docs/evidence/`

## 硬约束（违反要返工）

1. **不修改官方框架**：`/Users/eric/Project/tests/deepseek-harness` 只读；修复一律在 preset / 插件侧。
2. **不 vendor 宿主内部代码**：不复制 `tool-subagent` 之类的宿主实现。
3. **插件零 import**：preset 目录在用户 home 下，Node 解析不到 `@deepseek-ai/*`；
   新插件只依赖 `ctx` / `agent` / Node 内置模块。
4. **失败必须可见**：`logger.warn`，禁止空 catch、禁止静默跳过。
5. **供应链流程**：装新依赖前 `plugin_check`，装后 `security_audit` 并与基线 diff。
6. 本目录**不是 git 仓库**；删除不可逆，动手前先确认。

## 常跑命令

```bash
node scripts/verify-agent-lanes.cjs               # 会话日志行为验证（改完 preset 后跑，零模型成本）
node scripts/verify-lane-role-presentation.cjs    # 翻转插件单元校验（改 .mjs 后跑，11 条断言）
```

改 `lane-role-presentation.mjs` 后：`dev_reload_preset preset=agent-lanes`，**再开新会话**。
改 `agent.cordis.yml` / `personas/*.md`：开新会话即生效。
**但改完的 preset 在本会话不生效**（配置在挂载时已读取）—— 要*验证*改动必须开新会话，
清单见 `HANDOFF.md` §2 步骤 1。

## 容易踩的坑（都是踩过的，动 preset 前扫一眼）

1. `maxDepth: 0` 会让主 agent **一个子代理都派不出去**（`childDepth = parentDepth + 1`）。
2. persona 字段是 **`prefix`**，不是 `text`（写错会让 preset 挂载失败）。
3. 表现模式翻转必须在 **`agent/created`**；`agent/pre-step` 太晚（装配早于该 waterfall）。
4. 把**整个 preset 目录**做软链会被 discovery **静默跳过**；要「真目录 + 内部文件软链」。
5. 子代理工具面**总是**比白名单多 `subagent` + `list_subagent_models`（自身层泄漏，`allow`/`deny`/插件式挂载**都掩不掉**）。
   脚本里那行 `⊘ 已知自身层泄漏` 是**预期**，别去「修」它（根因见 `HANDOFF.md` §7.7）。
6. 角色 model + `reasoningEffort` 必须对得上 provider **实时目录**：`meituan/LongCat-2.0:free` 没有任何可选 effort，
   `z-ai/glm-5.3-flash` 只有 `low|high|max`（写 `medium` 即派发报错）。门禁**不是** `llm-commandcode.visibleModels`（见 §7.8）。
7. 通用 `subagent` 行必须保留 `maxDepth: 1` —— 删掉它，depth-1 角色就能派出无限制孙代（已实测）。
8. `dev_reload_preset` 只认**不带引号**的 `.mjs` 引用（正则 `/(name: \.\/[A-Za-z0-9._-]+\.mjs)(\?v=\d+)?/`）。
   写成 `name: './x.mjs'` 时它回「无相对 .mjs 引用（无需热更新）」然后**什么都不做** ——
   主机的 ESM 缓存继续把旧代插件发给每个新会话，而你以为已经热更新了（已实测）。
