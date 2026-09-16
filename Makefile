# ptc-roles 命令面：部署 / 对账 / 自验 / 清理。
# 约定与 ~/Project/tests/dsh-plugins/DSH-better-sidebar/Makefile 一致：目标用 "## " 写描述，
# help 从注释里生成；新增目标不需要改 help。

.DEFAULT_GOAL := help
HARNESS ?= $(HOME)/.dsh/dsh-harness

help: ## 列出所有可用目标
	@awk -F':.*## ' '/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

deploy: ## 部署 preset 到 ~/.dsh/.agent-presets/（同名已存在会先问 y/N）
	node scripts/deploy-preset.cjs

check: ## 对账：当前部署 vs 仓库（漂移退 2，不写盘）
	node scripts/deploy-preset.cjs --check

verify: ## 自验四支脚本（判据是各脚本打印的判定行，不是退出码）
	node scripts/verify-ptc-roles.cjs
	node scripts/verify-role-presentation.cjs
	node scripts/verify-intent-gate-watchdog.cjs
	node scripts/verify-harness-contract.cjs --harness $(HARNESS)

control: ## 阴性对照：断言有没有空转（预期失败数由脚本内定义，同样退 0）
	node scripts/verify-role-presentation.cjs --control
	node scripts/verify-intent-gate-watchdog.cjs --control

clean: ## 清理项目内临时文件（只删 .gitignore 覆盖的产物，逐条打印删了什么）
	@find . -name '.DS_Store' -not -path './.git/*' -print -delete
	@for d in .tmp scratch; do if [ -e "$$d" ]; then echo "删除目录 $$d"; rm -rf "$$d"; fi; done
	@find . -maxdepth 1 -name '*.log' -print -delete
	@echo "⇒ clean 完成（以上即全部删除项）"

.PHONY: help deploy check verify control clean
