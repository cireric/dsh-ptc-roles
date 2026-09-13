# AGENTS.md — agent-lanes

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
6. **不擅自持久化**：未经明确请求不提交、不发布。本目录工作树是脏的 ⇒ 删除**可能不可逆**，
   动手前先 `git status` 确认目标已入库。

**条件触发**

7. **改完 preset 必须自验**：
   `node scripts/verify-agent-lanes.cjs`（行为，期望 `✗0 !0`）与
   `node scripts/verify-lane-role-presentation.cjs`（插件单元，期望 `11/11`；
   `--control` 必须**恰好 5 项失败**，否则断言是空转）。
8. **改 preset、或排障之前，先读 `docs/pitfalls.md`** —— 机制与坑的唯一知识源（12 条 + 排障表）。
