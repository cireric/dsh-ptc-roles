# AGENTS.md — ptc-roles

DSH agent preset：orchestrator 主 agent（PTC）+ `explorer`/`librarian`/`oracle`/`implementer`/`designer`
五个角色子代理（native，`toolFilter.allow` 即硬能力边界）。

## 规则

**硬约束（违反要返工）**

1. **不修改官方框架**：`/Users/eric/Project/tests/deepseek-harness` 只读；修复一律在 preset / 插件侧。
2. **不 vendor 宿主内部代码**：不复制 `tool-subagent` 之类的宿主实现。
3. **插件零 import**：preset 目录在用户 home 下，Node 解析不到 `@deepseek-ai/*`；新插件只依赖
   `ctx` / `agent` / Node 内置模块。
4. **失败必须可见**：禁止空 catch、禁止静默跳过。注意本部署 `logger.warn` **没有落盘通道** ⇒
   要事后可查，失败就得进**数据面**（会话事件 → 脚本判定）。
5. **供应链**：装新依赖前 `plugin_check`，装后 `security_audit` 并与基线 diff。
6. **不擅自持久化**：未经明确请求不提交、不发布。动手**删除**前先 `git status` / `git diff` 确认目标已入库
   —— 未提交的改动删掉就找不回来了。

**条件触发**

7. **改完 preset 必须自验**：
   `node scripts/verify-ptc-roles.cjs`（行为，期望 `✗0 !0`，并打印意图门合规率）与
   `node scripts/verify-role-presentation.cjs`（插件单元，期望 `11/11`；
   `--control` 必须**恰好 5 项失败**，否则断言是空转）与
   `node scripts/verify-intent-gate-watchdog.cjs`（看门狗单元，期望 `20/20`；
   `--control` 必须失败在它自己的 `REQUIRED_CONTROL_FAILURES` 上，少一条就是断言空转）。
   改了 `.mjs` 还要 `dev_reload_preset`（输出须含 `x.mjs -> ?v=N`）并开新会话。
8. **改 preset、或排障之前，先读 `docs/pitfalls.md`** —— 机制与坑的唯一知识源。
