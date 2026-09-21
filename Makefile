# ptc-roles 命令面：部署 / 对账 / 自验 / 清理。
# 约定与 ~/Project/tests/dsh-plugins/DSH-better-sidebar/Makefile 一致：目标用 "## " 写描述，
# help 从注释里生成；新增目标不需要改 help。

.DEFAULT_GOAL := help
HARNESS ?= $(HOME)/.dsh/dsh-harness

help: ## 列出所有可用目标
	@awk -F':.*## ' '/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-9s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# 位置参数：make 没有"给目标的参数"，deploy 的 id 只能靠第二个 goal 传进来（不传则为空 ⇒ 部署全部）。
# 也可显式 make deploy PRESET=ptc-gate（命令行变量优先于这里的 ?=）。
PRESET ?= $(word 2,$(MAKECMDGOALS))
DEPLOY_EXTRA := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
ifneq ($(DEPLOY_EXTRA),)
  ifneq ($(firstword $(MAKECMDGOALS)),deploy)
    $(error $(firstword $(MAKECMDGOALS)) 不接受参数：$(DEPLOY_EXTRA)（make help 看可用目标）)
  endif
  ifneq ($(words $(DEPLOY_EXTRA)),1)
    $(error deploy 只接受一个 preset id，收到：$(DEPLOY_EXTRA))
  endif
endif

deploy: ## 部署 preset 到 ~/.dsh/.agent-presets/（make deploy [ptc-roles|ptc-gate] 只部署一个；不传则全部）
	node scripts/deploy-preset.cjs$(if $(PRESET), --preset $(PRESET),)

check: ## 对账：当前部署 vs 仓库（漂移退 2，不写盘）
	node scripts/deploy-preset.cjs --check

verify: ## 自验四支脚本 + 组成契约（判据是各脚本打印的判定行；**全部跑完**再汇总，任一非 0 则 make 非 0）
	@rc=0; \
	node scripts/verify-ptc-roles.cjs || rc=1; \
	node scripts/verify-role-presentation.cjs || rc=1; \
	node scripts/verify-intent-gate-watchdog.cjs || rc=1; \
	node scripts/verify-harness-contract.cjs --harness $(HARNESS) || rc=1; \
	node scripts/deploy-preset.cjs --compose || rc=1; \
	echo "⇒ make verify：四支脚本 + 组成契约已全部跑完（rc=$${rc} —— 判据仍以各脚本打印的判定行为准）"; \
	exit $$rc

control: ## 阴性对照：断言有没有空转（判据 = 集合相等；符合预期即退 0）
	@rc=0; \
	node scripts/verify-role-presentation.cjs --control || rc=1; \
	node scripts/verify-intent-gate-watchdog.cjs --control || rc=1; \
	node scripts/verify-ptc-roles.cjs --control-sessions || rc=1; \
	echo "⇒ make control：阴性对照已全部跑完（rc=$${rc}）"; \
	exit $$rc

clean: ## 清理项目内临时文件（只删 .gitignore 覆盖的产物，逐条打印删了什么）
	@find . -name '.DS_Store' -not -path './.git/*' -print -delete
	@for d in .tmp scratch; do if [ -e "$$d" ]; then echo "删除目录 $$d"; rm -rf "$$d"; fi; done
	@find . -maxdepth 1 -name '*.log' -print -delete
	@echo "⇒ clean 完成（以上即全部删除项）"

# `make deploy <id>` 里的 <id> 会变成第二个目标 —— 这里吸收它（id 合法性由脚本判定）；
# 其余未知目标一律响亮失败，绝不静默空转（拼错 make deply 也要看得见）。
.DEFAULT:
	@if [ "$(firstword $(MAKECMDGOALS))" = deploy ] && [ "$(words $(MAKECMDGOALS))" = 2 ]; then :; \
	else echo "✗ 未知目标：$@（make help 看可用目标）" >&2; exit 1; fi

.PHONY: help deploy check verify control clean
