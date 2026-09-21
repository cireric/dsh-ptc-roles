#!/usr/bin/env node
'use strict'

// deploy-preset.cjs — 把 preset/<id>/ 部署到 DSH 的本地 preset 根目录（$DSH_HOME/.agent-presets/）。
//
// 为什么需要脚本，而不是几条 ln -s（机制细节见 docs/pitfalls.md A 节）：
//   · DSH 的发现逻辑对 preset 目录用 Dirent 的 isDirectory()（不跟随软链）⇒ **整目录做软链会被静默跳过**
//     （packages/preset/agent-presets/src/discovery.ts:303）；而**内部条目做软链完全合法**
//     （组件用 stat / readFile，都跟随软链）。这就是「真目录 + 内部软链」这个形态的来源。
//   · **必须是软链、不能是副本**：dev_reload_preset 是**透过软链**改写 agent.cordis.yml 的；
//     副本会让热更新打在一个没人读的拷贝上，仓库源静默不同步。
//   · 部署清单 = preset/<id>/ 的全部顶层条目（跳过点文件），由本脚本**自动发现** ⇒
//     README / pitfalls / HANDOFF 里不再手抄条目名（加一个插件文件不需要改任何文档）。
//
// 退出码（与四个 verify 脚本同一套契约）：0 = 符合预期 / 1 = 出错或被拒 / 2 = --check 发现漂移。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')

const REPO_ROOT = path.resolve(__dirname, '..')
const SOURCE_ROOT = path.join(REPO_ROOT, 'preset')
const COMPOSITION = 'agent.cordis.yml'
const PRESET_ROOT_DIR = '.agent-presets'
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const EXIT_OK = 0
const EXIT_REFUSED = 1
const EXIT_DRIFT = 2

const USAGE = [
  '用法：node scripts/deploy-preset.cjs [选项]',
  '',
  '  （无选项）        部署 preset/<id>/ → $DSH_HOME/.agent-presets/<id>/；',
  '                   目标已存在时先列出差异并询问 y/N，确认后才重建',
  '  --check           只读对账：当前部署 vs 仓库（缺项 / 断链 / 指错 / 多余）+ 组成契约，漂移退 2',
  '  --compose         只读、只查仓库：每个 preset 的组成契约（该有哪些 agent 行 / 门插件副本是否一致），违规退 1',
  '  --dry-run         只打印计划，不写盘、不询问',
  '  --yes, -y         非交互：跳过询问（非交互终端且无此旗标时脚本拒绝执行，绝不挂起）',
  '  --preset <id>     只处理指定 preset（默认：preset/ 下全部）',
  '  --home <dir>      覆盖 DSH home（等价于 $DSH_HOME；空白视为未设 ⇒ ~/.dsh）',
  '  --help, -h        打印本帮助',
].join('\n')

/** 响亮失败：错误进 stdout/stderr（本部署没有日志落盘通道，AGENTS.md 硬约束 4）。 */
function refuse(message) {
  console.error('✗ ' + message)
  process.exit(EXIT_REFUSED)
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.indexOf('~/') === 0 || value.indexOf('~\\') === 0) return path.join(os.homedir(), value.slice(2))
  return value
}

/** $DSH_HOME 优先（空白视为未设），否则 ~/.dsh —— 与 packages/util/home-paths 同口径。 */
function resolveDshHome(override) {
  if (override !== null) return path.resolve(expandHome(override))
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(expandHome(env.trim()))
  return path.join(os.homedir(), '.dsh')
}

function parseArgs(argv) {
  const opts = { check: false, compose: false, dryRun: false, yes: false, preset: null, home: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--compose') opts.compose = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--preset') { i += 1; opts.preset = argv[i] === undefined ? '' : argv[i] }
    else if (arg === '--home') { i += 1; opts.home = argv[i] === undefined ? '' : argv[i] }
    else refuse('未知参数：' + arg + '（--help 看用法）')
  }
  if (opts.check && opts.dryRun) refuse('--check 与 --dry-run 互斥（--check 本身就是只读对账）')
  if (opts.compose && (opts.check || opts.dryRun)) refuse('--compose 只读且只查仓库，不与 --check / --dry-run 并用')
  if (opts.preset !== null && !PRESET_ID.test(opts.preset)) {
    refuse('--preset 只接受 ^[a-z0-9][a-z0-9-]*$，收到：' + JSON.stringify(opts.preset))
  }
  if (opts.home !== null && opts.home.trim() === '') refuse('--home 需要一个目录参数')
  return opts
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target) } catch { return null }
}

function realpathOrNull(target) {
  try { return fs.realpathSync(target) } catch { return null }
}

/**
 * 规范化一个**可能还不存在**的路径：对「最深的已存在祖先」做 realpath，再拼回剩余段。
 * 只用 realpathSync 会因路径不存在而抛错，只用 path.resolve 又会被路径里的符号链接组件骗过 ——
 * 而「目标落在本仓库内，拒绝部署」这条安全闸必须是后者也拦得住（2026-09-17 评审 M3：
 * macOS 的 /tmp → /private/tmp 就能骗过它，实测未拦下）。
 */
function canonicalPath(target) {
  const abs = path.resolve(target)
  const tail = []
  let head = abs
  for (;;) {
    const real = realpathOrNull(head)
    if (real !== null) return tail.length === 0 ? real : path.join(real, ...tail.reverse())
    const parent = path.dirname(head)
    if (parent === head) return abs
    tail.push(path.basename(head))
    head = parent
  }
}

/** 源目录的顶层条目（跳过点文件，例如 macOS 的 .DS_Store）。 */
function sourceEntries(sourceDir) {
  return fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, dir: entry.isDirectory(), from: path.join(sourceDir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function sourcePresetIds() {
  if (!fs.existsSync(SOURCE_ROOT)) refuse('源目录不存在：' + SOURCE_ROOT)
  const ids = fs.readdirSync(SOURCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PRESET_ID.test(entry.name))
    .map((entry) => entry.name)
  return ids.sort()
}

function planFor(id, home) {
  const sourceDir = path.join(SOURCE_ROOT, id)
  const targetDir = path.join(home, PRESET_ROOT_DIR, id)
  return {
    id,
    sourceDir,
    targetDir,
    stagingDir: path.join(home, PRESET_ROOT_DIR, '.' + id + '.staging'),
    entries: sourceEntries(sourceDir),
  }
}

/** 一条软链的状态：ok / missing / dangling / wrong / not-link。 */
function linkState(linkPath, wantTarget) {
  const st = lstatOrNull(linkPath)
  if (st === null) return 'missing'
  if (!st.isSymbolicLink()) return 'not-link'
  const real = realpathOrNull(linkPath)
  if (real === null) return 'dangling'
  return real === realpathOrNull(wantTarget) ? 'ok' : 'wrong'
}

const LINK_STATE_LABEL = {
  missing: '缺项',
  dangling: '断链',
  wrong: '指向错误',
  'not-link': '不是软链（真实文件/目录）',
}

function linkProblems(dir, entries) {
  const problems = []
  for (const entry of entries) {
    const state = linkState(path.join(dir, entry.name), entry.from)
    if (state !== 'ok') problems.push(entry.name + '：' + (LINK_STATE_LABEL[state] || state))
  }
  return problems
}

/** 目标已存在时，逐条列出里面是什么 —— 这是询问前唯一能看清「会丢什么」的地方。 */
function describeExisting(targetDir, sourceDir) {
  const st = lstatOrNull(targetDir)
  const lines = []
  if (st.isSymbolicLink()) {
    lines.push('  目录本身是软链 → ' + (realpathOrNull(targetDir) || '（断链）') + '   ← DSH 会静默跳过这个形态')
    return lines
  }
  const children = fs.readdirSync(targetDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const child of children) {
    const childPath = path.join(targetDir, child.name)
    if (child.isSymbolicLink()) {
      const real = realpathOrNull(childPath)
      const ours = real !== null && real.startsWith(path.resolve(sourceDir) + path.sep)
      lines.push('  ' + child.name + ' → ' + (real || '（断链）') + (ours ? '   [本仓库]' : '   [非本仓库!]'))
    } else if (child.isDirectory()) {
      lines.push('  ' + child.name + '/   【真实目录，删除后不可恢复】')
    } else {
      lines.push('  ' + child.name + '   【真实文件，删除后不可恢复】')
    }
  }
  if (lines.length === 0) lines.push('  （空目录）')
  return lines
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    refuse('目标已存在，但当前不是交互终端 —— 拒绝删除（避免替不在场的人做决定）。确认要覆盖请加 --yes。')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) => { rl.question(question, resolve) })
  rl.close()
  return /^y(es)?$/i.test(String(answer).trim())
}

function removeTarget(targetDir, st) {
  // 目标是软链时只断链，绝不递归（递归删除会顺着链接删到仓库里去）。
  if (st.isSymbolicLink()) { fs.unlinkSync(targetDir); return }
  // rmSync 对目录内的软链只 unlink，不跟随。
  fs.rmSync(targetDir, { recursive: true, force: true })
}

/**
 * 组成契约：每个 preset **必须 / 不得**有哪些顶层 agent 行。
 * 单一源 = 本表（本脚本是唯一遍历 preset 根目录的地方）；唯一 reader 只比对「已存在的角色行」与 EXPECTED，
 * 不重复登记这里的事实（ADR 0002 待决 #6 的 Q12 决定）。新增 preset 不登记 ⇒ **响亮失败**。
 */
const EXPECTED_COMPOSITION = {
  'ptc-roles': { roles: ['role-explorer', 'role-librarian', 'role-oracle', 'role-implementer', 'role-designer'], plugins: ['role-presentation', 'intent-gate-watchdog'] },
  'ptc-gate': { roles: [], plugins: ['intent-gate-watchdog'] },
}
const GATE_PLUGIN = 'intent-gate-watchdog.mjs'

function topLevelIds(sourceDir) {
  const text = fs.readFileSync(path.join(sourceDir, COMPOSITION), 'utf8')
  return text.split('\n').filter((line) => /^- id: /.test(line)).map((line) => line.slice('- id: '.length).trim())
}

function compositionFindings(id, sourceDir) {
  const spec = EXPECTED_COMPOSITION[id]
  if (spec === undefined) return ['未登记的 preset（往 EXPECTED_COMPOSITION 加一行再部署）：' + id]
  const ids = topLevelIds(sourceDir)
  const findings = []
  const roles = ids.filter((x) => x.startsWith('role-') && x !== 'role-presentation')
  const missing = spec.roles.filter((r) => !roles.includes(r))
  const extra = roles.filter((r) => !spec.roles.includes(r))
  if (missing.length > 0) findings.push('缺角色行：' + missing.join(', '))
  if (extra.length > 0) findings.push('多出角色行：' + extra.join(', ') + '（该 preset 不该预置角色）')
  for (const plugin of spec.plugins) if (!ids.includes(plugin)) findings.push('缺插件行：' + plugin)
  if (!ids.includes('intent-gate-watchdog')) findings.push('每个 preset 都必须带意图门行（- id: intent-gate-watchdog）')
  return findings
}

/** 门插件在多个 preset 里是副本（preset 目录须自包含）⇒ 副本漂移必须可见。 */
function gateCopyFindings(ids) {
  const crypto = require('node:crypto')
  const digests = new Map()
  for (const id of ids) {
    const p = path.join(SOURCE_ROOT, id, GATE_PLUGIN)
    if (fs.existsSync(p)) digests.set(id, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12))
  }
  if (new Set(digests.values()).size <= 1) return []
  return ['门插件副本不一致（' + [...digests].map(([k, v]) => k + '=' + v).join(' / ') + '）⇒ 以 ptc-roles 为准重新 cp']
}

function checkPreset(plan, home) {
  console.log('· ' + plan.id + '  ' + plan.targetDir)
  const findings = []
  const st = lstatOrNull(plan.targetDir)
  if (st === null) {
    findings.push('未部署：' + plan.targetDir + ' 不存在')
  } else if (st.isSymbolicLink()) {
    findings.push('目标目录本身是软链（DSH 会静默跳过）：' + plan.targetDir + ' → ' + (realpathOrNull(plan.targetDir) || '（断链）'))
  } else {
    for (const problem of linkProblems(plan.targetDir, plan.entries)) findings.push(problem)
    const expected = new Set(plan.entries.map((entry) => entry.name))
    for (const name of fs.readdirSync(plan.targetDir).sort()) {
      if (!name.startsWith('.') && !expected.has(name)) findings.push('多余项（源里没有）：' + name)
    }
  }
  if (findings.length === 0) {
    console.log('  ✓ 与仓库一致（' + plan.entries.length + ' 项：' + plan.entries.map((entry) => entry.name).join(', ') + '）')
  } else {
    for (const finding of findings) console.log('  ✗ ' + finding)
  }
  return findings.length
}

async function deployPreset(plan, opts, home) {
  console.log('· ' + plan.id)
  console.log('  源：' + plan.sourceDir)
  console.log('  目标：' + plan.targetDir)
  console.log('  条目（' + plan.entries.length + '）：' + plan.entries.map((entry) => entry.name).join(', '))

  const existing = lstatOrNull(plan.targetDir)
  const leftover = lstatOrNull(plan.stagingDir)

  if (opts.dryRun) {
    if (existing === null) console.log('  （目标不存在：将新建）')
    else { console.log('  目标已存在，将删除并重建：'); for (const line of describeExisting(plan.targetDir, plan.sourceDir)) console.log(line) }
    if (leftover !== null) console.log('  遗留暂存目录将被清理：' + plan.stagingDir)
    console.log('  ⊘ --dry-run：未写入任何内容')
    return true
  }

  if (existing !== null && !opts.yes) {
    console.log('  目标已存在，内容如下：')
    for (const line of describeExisting(plan.targetDir, plan.sourceDir)) console.log(line)
    const agreed = await confirm('  删除并重建为指向本仓库的软链？[y/N] ')
    if (!agreed) { console.log('  ⊘ 已取消（未改动任何文件）'); return false }
  }

  // 先建后换：暂存目录建好并自验通过，才动目标目录 —— 中途失败时目标原样不动。
  if (leftover !== null) fs.rmSync(plan.stagingDir, { recursive: true, force: true })
  fs.mkdirSync(plan.stagingDir, { recursive: true })
  for (const entry of plan.entries) {
    fs.symlinkSync(entry.from, path.join(plan.stagingDir, entry.name), entry.dir ? 'dir' : 'file')
  }
  const stagingProblems = linkProblems(plan.stagingDir, plan.entries)
  if (stagingProblems.length > 0) {
    fs.rmSync(plan.stagingDir, { recursive: true, force: true })
    refuse('暂存目录自验失败（目标未改动）：' + stagingProblems.join('；'))
  }

  if (existing !== null) removeTarget(plan.targetDir, existing)
  fs.renameSync(plan.stagingDir, plan.targetDir)

  const deployedProblems = linkProblems(plan.targetDir, plan.entries)
  if (deployedProblems.length > 0) refuse('部署后自验失败：' + deployedProblems.join('；'))

  console.log('  ✓ 已部署 ' + plan.entries.length + ' 项 → ' + plan.targetDir)
  console.log('  ⇒ 生效：开新会话（persona 与 agent.cordis.yml 每次新会话重读）；')
  console.log('     改过 .mjs 还要 dev_reload_preset preset=' + plan.id + '（输出须含 x.mjs -> ?v=N）再开新会话。')
  return true
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(USAGE); return EXIT_OK }

  const home = resolveDshHome(opts.home)
  const available = sourcePresetIds()
  if (available.length === 0) refuse('preset/ 下没有任何合法 preset 目录（id 须匹配 ' + String(PRESET_ID) + '）')
  if (opts.preset !== null && available.indexOf(opts.preset) < 0) {
    refuse('preset/' + opts.preset + ' 不存在；现有：' + available.join(', '))
  }
  const ids = opts.preset === null ? available : [opts.preset]

  if (opts.compose) {
    let bad = 0
    for (const id of ids) {
      const findings = compositionFindings(id, path.join(SOURCE_ROOT, id))
      console.log('· ' + id + (findings.length === 0 ? '  ✓ 组成符合期望' : ''))
      for (const finding of findings) { console.log('  ✗ ' + finding); bad += 1 }
    }
    for (const finding of gateCopyFindings(ids)) { console.log('· 门插件副本 · ✗ ' + finding); bad += 1 }
    if (bad === 0) { console.log('✓ 组成契约通过：' + ids.length + ' 个 preset（含门插件副本一致性）'); return EXIT_OK }
    console.log('✗ 组成契约发现 ' + bad + ' 处问题'); return EXIT_REFUSED
  }

  console.log('DSH home：' + home)
  console.log('preset 根：' + path.join(home, PRESET_ROOT_DIR))

  let drift = 0
  for (const id of ids) {
    const plan = planFor(id, home)
    if (!fs.existsSync(path.join(plan.sourceDir, COMPOSITION))) {
      refuse('源目录缺 ' + COMPOSITION + '，拒绝部署：' + plan.sourceDir)
    }
    // 断言：目标必须正好是 <preset 根>/<id>（id 已过正则，这里防的是未来重构与 --home 自指）。
    // 两侧都必须**先规范化再比**：只比词法路径时，路径里任何符号链接组件（macOS 的 /tmp →
    // /private/tmp、软链过的 home）都会让下面的「落在仓库内」判定**静默失效** —— 2026-09-17
    // 评审实测：`--home <仓库>/.fakehome` 未被拦下，照常部署。
    const expectedTarget = path.join(canonicalPath(home), PRESET_ROOT_DIR, id)
    if (canonicalPath(plan.targetDir) !== expectedTarget) refuse('目标路径不合法：' + plan.targetDir)
    const repoReal = canonicalPath(REPO_ROOT)
    if (expectedTarget === repoReal || expectedTarget.startsWith(repoReal + path.sep)) {
      refuse('目标落在本仓库内，拒绝部署（--home 指错了？）：' + expectedTarget)
    }
    if (!opts.check) {
      // 只有「真实目录」才可能删到源：软链目标我们只 unlink（见 removeTarget），
      // 所以「目标是指向源的软链」是**可修复**的漂移形态，不能在这里拦死（--check 会点名它）。
      const targetStat = lstatOrNull(plan.targetDir)
      const targetReal = realpathOrNull(plan.targetDir)
      if (targetStat !== null && !targetStat.isSymbolicLink() && targetReal === realpathOrNull(plan.sourceDir)) {
        refuse('目标是真实目录且就是源目录本身，拒绝操作：' + plan.targetDir)
      }
    }

    if (opts.check) {
      drift += checkPreset(plan, home)
      for (const finding of compositionFindings(id, plan.sourceDir)) { console.log('  ✗ 组成：' + finding); drift += 1 }
    }
    else await deployPreset(plan, opts, home)
  }

  if (opts.check) {
    if (drift === 0) {
      console.log('✓ 对账通过：' + ids.length + ' 个 preset 的部署与仓库一致')
      return EXIT_OK
    }
    console.log('✗ 对账发现 ' + drift + ' 处漂移 ⇒ 跑 make deploy 重新部署')
    return EXIT_DRIFT
  }
  return EXIT_OK
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => { refuse('未捕获异常：' + (error && error.stack ? error.stack : String(error))) })
