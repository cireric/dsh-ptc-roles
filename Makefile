# ptc-roles 命令面：安装 / 对账 / 自验 / 清理。
# 0.2.0 起 preset 是一个 bundle（本仓库自己），装法 = profile 软链 + bundles 列表 + pnpm install；
# 旧路径 ~/.dsh/.agent-presets/ 已彻底废弃（运行时零读者）—— 机制与坑见 docs/pitfalls.md A 节。
# 约定与 ~/Project/tests/dsh-plugins/DSH-better-sidebar/Makefile 一致：目标用 "## " 写描述，
# help 从注释里生成；新增目标不需要改 help。

.DEFAULT_GOAL := help
HARNESS ?= $(HOME)/.dsh/dsh-harness

help: ## 列出所有可用目标
	@awk -F':.*## ' '/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

deploy: ## 把本仓库作为 bundle 装进 web profile（写 profile package.json + pnpm install）
	node scripts/deploy-preset.cjs

check: ## 对账：已安装的那一份 vs 仓库（漂移退 2，不写盘）
	node scripts/deploy-preset.cjs --check

verify: ## 自验四支脚本 + 组成契约（判据是各脚本打印的判定行；**全部跑完**再汇总，任一非 0 则 make 非 0）
	@rc=0; \
	node scripts/verify-ptc-roles.cjs || rc=1; \
	node scripts/verify-role-presentation.cjs || rc=1; \
	node scripts/verify-intent-gate-watchdog.cjs || rc=1; \
	node scripts/verify-harness-contract.cjs --harness $(HARNESS) || rc=1; \
	node scripts/deploy-preset.cjs --compose || rc=1; \
	echo "⇒ make verify：四支脚本 + 组成契约已全部跑完（rc=$${rc} —— 判据仍以各脚本打印的判定行为准）"; \
	exit ${rc}

control: ## 阴性对照：断言有没有空转（判据 = 集合相等；符合预期即退 0）
	@rc=0; \
	node scripts/verify-role-presentation.cjs --control || rc=1; \
	node scripts/verify-intent-gate-watchdog.cjs --control || rc=1; \
	node scripts/verify-ptc-roles.cjs --control-sessions || rc=1; \
	node scripts/verify-ptc-roles.cjs --mount --control || rc=1; \
	echo "⇒ make control：阴性对照已全部跑完（rc=$${rc}）"; \
	exit ${rc}

fresh: ## 挂载代次对账：我改的这一代，生效了没有（只读；0=已生效 1=未生效 2=不可得）
	node scripts/verify-ptc-roles.cjs --mount

clean: ## 清理项目内临时文件（只删 .gitignore 覆盖的产物，逐条打印删了什么）
	@find . -name '.DS_Store' -not -path './.git/*' -print -delete
	@for d in .tmp scratch; do if [ -e "$$d" ]; then echo "删除目录 $$d"; rm -rf "$$d"; fi; done
	@find . -maxdepth 1 -name '*.log' -print -delete
	@echo "⇒ clean 完成（以上即全部删除项）"

# deploy 不再接受 preset id：一次装整个 bundle；归档 preset 留在 preset/ 下但不列入 manifest。
# 未知目标一律响亮失败，绝不静默空转（拼错 make deply 也要看得见）。
.DEFAULT:
	@echo "✗ 未知目标：$@（make help 看可用目标；deploy 自 0.2.0 起不接受 preset id）" >&2; exit 1

.PHONY: help deploy check verify control fresh clean
