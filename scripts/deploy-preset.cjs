#!/usr/bin/env node
'use strict'

// deploy-preset.cjs — 0.2.0 起 preset 的交付形态变了（机制见 docs/pitfalls.md A 节）：
//   · 旧路径 $DSH_HOME/.agent-presets/ 已彻底废弃（运行时零读者）⇒ 往那儿放任何东西都不生效。
//   · 交付单位 = 本仓库自己（一个 npm 包 = 一个 bundle）：package.json 的 dsh.bundle.patch
//     列出 preset/<id>/preset.patch.yml；每个文件是一条 @deepseek-ai/dsh-agent-preset 声明行。
//   · 安装 = profile 的 package.json（dependencies 加 link:<repo>）+ dsh.profile.bundles 追加
//     + 在 profile 目录 pnpm install（link: 会在 node_modules 下建指向本仓库的软链）。
//   · 资产解析基 = profile 目录 ⇒ 声明行里 name: ./x.mjs 与 !!js 的 baseUrl 都会落到 profile 下，
//     必须走包名子路径与 createRequire(baseUrl).resolve(...)。
//
// 模式：（无参数）安装/更新 | --check 对账 | --compose 只查仓库 | --dry-run 只打印
// 退出码：0 = 符合预期 / 1 = 出错或被拒 / 2 = 对账漂移或读不到载体。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const PRESET_ROOT = path.join(REPO_ROOT, 'preset')
const MANIFEST = path.join(REPO_ROOT, 'package.json')
const PATCH_BASENAME = 'preset.patch.yml'
const GATE_PLUGIN = 'intent-gate-watchdog.mjs'
const LEGACY_ROOT_DIR = '.agent-presets'
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const EXIT_OK = 0
const EXIT_REFUSED = 1
const EXIT_DRIFT = 2

const USAGE = [
  '用法：node scripts/deploy-preset.cjs [选项]',
  '',
  '  （无选项）        把本仓库作为 bundle 装进 profile（写 package.json + pnpm install）',
  '  --check           只读对账：已安装 vs 仓库（依赖规格 / bundles 列表 / 软链 / 组成契约），漂移退 2',
  '  --compose         只读、只查仓库：组成契约（角色行、门插件副本一致性、0.2.0 写法残留）',
  '  --dry-run         只打印计划，不写盘',
  '  --profile <name>  覆盖 profile 名（等价于 $DSH_PROFILE；缺省 web）',
  '  --home <dir>      覆盖 DSH home（等价于 $DSH_HOME；空白视为未设 ⇒ ~/.dsh）',
  '  --help, -h        打印本帮助',
].join('\n')

// 组成契约的单一源：新增 preset 不登记 ⇒ 响亮失败。
const EXPECTED_COMPOSITION = {
  'ptc-gate': { active: true, roles: [], plugins: ['intent-gate-watchdog'], label: '本机启用的那一个' },
  'ptc-roles': {
    active: false,
    roles: ['role-explorer', 'role-librarian', 'role-oracle', 'role-implementer', 'role-designer'],
    plugins: ['role-presentation', 'intent-gate-watchdog'],
    label: '归档：随包分发但不激活（声明行 disabled: true）',
  },
}

function refuse(message) {
  console.error('✗ ' + message)
  process.exit(EXIT_REFUSED)
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.indexOf('~/') === 0 || value.indexOf('~\\') === 0) return path.join(os.homedir(), value.slice(2))
  return value
}

// $DSH_HOME 优先（空白视为未设），否则 ~/.dsh —— 与 packages/util/home-paths 同口径。
function resolveDshHome(override) {
  if (override !== null) return path.resolve(expandHome(override))
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(expandHome(env.trim()))
  return path.join(os.homedir(), '.dsh')
}

function parseArgs(argv) {
  const opts = { check: false, compose: false, dryRun: false, profile: null, home: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--compose') opts.compose = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--profile') { i += 1; opts.profile = argv[i] === undefined ? '' : argv[i] }
    else if (arg === '--home') { i += 1; opts.home = argv[i] === undefined ? '' : argv[i] }
    else refuse('未知参数：' + arg + '（--help 看用法）')
  }
  if (opts.compose && (opts.check || opts.dryRun)) refuse('--compose 只读且只查仓库，不与 --check / --dry-run 并用')
  if (opts.profile !== null && !PRESET_ID.test(opts.profile)) {
    refuse('--profile 只接受 ^[a-z0-9][a-z0-9-]*$，收到：' + JSON.stringify(opts.profile))
  }
  if (opts.home !== null && opts.home.trim() === '') refuse('--home 需要一个目录参数')
  return opts
}

function readIf(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return undefined }
}

function readRepoManifest() {
  const text = readIf(MANIFEST)
  if (text === undefined) { console.error('✗ 读不到仓库 manifest：' + MANIFEST); process.exit(EXIT_DRIFT) }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) { refuse('仓库 package.json 不是合法 JSON：' + error.message) }
  const name = parsed.name
  const declared = parsed.dsh && parsed.dsh.bundle ? parsed.dsh.bundle.patch : undefined
  const files = typeof declared === 'string' ? [declared] : declared
  if (typeof name !== 'string' || !Array.isArray(files) || files.length === 0) {
    refuse('仓库 package.json 缺 name 或 dsh.bundle.patch（0.2.0 bundle 的必需声明）')
  }
  return { name, files: files.map((file) => String(file)) }
}

function presetIds() {
  if (!fs.existsSync(PRESET_ROOT)) refuse('preset/ 不存在：' + PRESET_ROOT)
  return fs.readdirSync(PRESET_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PRESET_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

function patchPath(id) { return path.join(PRESET_ROOT, id, PATCH_BASENAME) }

// 声明行切片：从 "    - id: preset-<id>" 到该行的 "      config:" 为止（不含 config 内部）。
function declarationSlice(text, id) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '- id: preset-' + id)
  if (start < 0) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {6}config:$/.test(lines[i])) { end = i; break }
    if (/^ {4}- id: /.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end)
}

function declaredDisabled(slice) { return slice.some((line) => /^\s*disabled:\s*true\s*$/.test(line)) }

function patchRowIds(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^ {10}- id: ([A-Za-z0-9._-]+)$/.exec(line)
    if (m !== null) out.push(m[1])
  }
  return out
}

// 0.2.0 的写法残留：这三种会把资产解析到 profile 目录，或引到已删除的包上。
function legacySweepFindings(id, text) {
  const findings = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.indexOf('name: ./') === 0) findings.push(id + '：相对插件名 ' + trimmed + ' ⇒ 会解析到 profile 目录（改用包名子路径）')
    if (trimmed.indexOf("new URL('personas/") >= 0) findings.push(id + '：!!js 仍按 preset 目录取 persona ⇒ baseUrl 是 profile 目录（改用 createRequire(baseUrl).resolve(...)）')
    if (trimmed.indexOf('@deepseek-ai/dsh-workflow-worker-thread') >= 0) findings.push(id + '：引用了 0.2.0 已删除的包 dsh-workflow-worker-thread（改用 dsh-workflow-ptc）')
  }
  return findings
}

// 门插件在多个 preset 里是副本（preset 目录自包含）⇒ 副本漂移必须可见。
function gateCopyFindings(ids) {
  const digests = new Map()
  for (const id of ids) {
    const file = path.join(PRESET_ROOT, id, GATE_PLUGIN)
    if (fs.existsSync(file)) digests.set(id, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12))
  }
  if (digests.size <= 1 || new Set(digests.values()).size <= 1) return []
  return ['门插件副本不一致（' + [...digests].map(([k, v]) => k + '=' + v).join(' / ') + '）⇒ 以 ptc-roles 为准重新 cp']
}

// 组成契约（只读仓库）。返回字符串数组，空 = 通过。
function composeFindings(ids, manifest) {
  const findings = []
  for (const file of manifest.files) {
    if (!fs.existsSync(path.join(REPO_ROOT, file))) findings.push('manifest 声明的 patch 不存在：' + file)
  }
  const listed = manifest.files.map((file) => path.basename(path.dirname(file))).sort()
  if (listed.join(',') !== ids.join(',')) {
    findings.push('manifest 的 patch 列表（' + listed.join(', ') + '）与 preset/ 目录（' + ids.join(', ') + '）不是一一对应')
  }
  for (const id of ids) {
    const spec = EXPECTED_COMPOSITION[id]
    if (spec === undefined) { findings.push('未登记的 preset（往 EXPECTED_COMPOSITION 加一行）：' + id); continue }
    const text = readIf(patchPath(id))
    if (text === undefined) { findings.push(id + '：缺 ' + PATCH_BASENAME); continue }
    const slice = declarationSlice(text, id)
    if (slice === undefined) { findings.push(id + '：找不到声明行 "- id: preset-' + id + '"'); continue }
    const disabled = declaredDisabled(slice)
    if (disabled === spec.active) {
      findings.push(id + '：启用态不符（声明 disabled=' + disabled + '，期望 active=' + spec.active + '；' + spec.label + '）')
    }
    const rowIds = patchRowIds(text)
    const roles = rowIds.filter((x) => x.indexOf('role-') === 0 && x !== 'role-presentation')
    const missing = spec.roles.filter((role) => roles.indexOf(role) < 0)
    const extra = roles.filter((role) => spec.roles.indexOf(role) < 0)
    if (missing.length > 0) findings.push(id + '：缺角色行 ' + missing.join(', '))
    if (extra.length > 0) findings.push(id + '：多出角色行 ' + extra.join(', ') + '（该 preset 不该预置角色）')
    for (const plugin of spec.plugins) if (rowIds.indexOf(plugin) < 0) findings.push(id + '：缺插件行 ' + plugin)
    for (const finding of legacySweepFindings(id, text)) findings.push(finding)
  }
  return findings.concat(gateCopyFindings(ids))
}

function canonicalLinkTarget(spec) {
  if (typeof spec !== 'string' || spec.indexOf('link:') !== 0) return null
  return path.resolve(expandHome(spec.slice('link:'.length)))
}

function checkInstalled(manifest, profileDir) {
  const findings = []
  const text = readIf(path.join(profileDir, 'package.json'))
  if (text === undefined) {
    console.log('  [i] profile 无 package.json（还没初始化；本次不参与对账）')
    return { state: 'absent', findings }
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) { return { state: 'broken', findings: ['profile package.json 不是合法 JSON：' + error.message] } }
  const dep = parsed.dependencies === undefined ? undefined : parsed.dependencies[manifest.name]
  if (dep === undefined) {
    console.log('  [i] 未安装（本次不参与对账；要装跑 make deploy）—— 该不该装是人的意图，检查器猜不到')
    return { state: 'absent', findings }
  }
  const target = canonicalLinkTarget(dep)
  if (target === null) {
    findings.push('依赖规格不是 link:（收到 ' + JSON.stringify(dep) + '）⇒ bundle 必须从本仓库软链安装')
  } else if (target !== fs.realpathSync(REPO_ROOT)) {
    findings.push('依赖指向别的目录：' + target + '（期望 ' + fs.realpathSync(REPO_ROOT) + '）')
  }
  const profile = parsed.dsh === undefined ? undefined : parsed.dsh.profile
  const bundles = profile !== undefined && Array.isArray(profile.bundles) ? profile.bundles : []
  if (bundles.indexOf(manifest.name) < 0) findings.push('dsh.profile.bundles 不含 ' + manifest.name + ' ⇒ patch 层不会被叠加')
  const linked = path.join(profileDir, 'node_modules', manifest.name)
  let st = null
  try { st = fs.lstatSync(linked) } catch { st = null }
  if (st === null) findings.push('node_modules 下没有软链：' + linked + ' ⇒ 跑 pnpm install')
  else if (!st.isSymbolicLink()) findings.push(linked + ' 不是软链（应为指向本仓库的软链）')
  else {
    let real = null
    try { real = fs.realpathSync(linked) } catch { real = null }
    if (real !== fs.realpathSync(REPO_ROOT)) findings.push('软链指向 ' + (real === null ? '（断链）' : real) + '，不是本仓库')
  }
  return { state: 'installed', findings }
}

function runPnpmInstall(profileDir, dryRun) {
  if (dryRun) { console.log('  [dry-run] 将执行 pnpm install --prefer-offline（cwd=' + profileDir + '）'); return }
  console.log('  · pnpm install --prefer-offline（cwd=' + profileDir + '）')
  const result = spawnSync('pnpm', ['install', '--prefer-offline'], { cwd: profileDir, stdio: 'inherit' })
  if (result.error !== undefined && result.error !== null) {
    refuse('pnpm 起不来：' + result.error.message + '（PATH 里没有 pnpm？在能跑 pnpm 的 shell 里执行本命令）')
  }
  if (result.status !== 0) refuse('pnpm install 退出码 ' + result.status + '（profile 未装成，见上面的输出）')
}

function installBundle(manifest, opts, profileDir) {
  if (!fs.existsSync(profileDir)) refuse('profile 目录不存在：' + profileDir + '（先用 dsh 初始化该 profile）')
  const manifestPath = path.join(profileDir, 'package.json')
  const text = readIf(manifestPath)
  if (text === undefined) refuse('profile 缺 package.json：' + manifestPath)
  let parsed
  try { parsed = JSON.parse(text) } catch (error) { refuse('profile package.json 不是合法 JSON：' + error.message) }
  parsed.dependencies = parsed.dependencies === undefined ? {} : parsed.dependencies
  parsed.dsh = parsed.dsh === undefined ? {} : parsed.dsh
  parsed.dsh.profile = parsed.dsh.profile === undefined ? {} : parsed.dsh.profile
  const bundles = Array.isArray(parsed.dsh.profile.bundles) ? parsed.dsh.profile.bundles.slice() : []
  const spec = 'link:' + REPO_ROOT
  const before = JSON.stringify(parsed)
  const prev = parsed.dependencies[manifest.name]
  parsed.dependencies[manifest.name] = spec
  if (bundles.indexOf(manifest.name) < 0) bundles.push(manifest.name)
  parsed.dsh.profile.bundles = bundles
  const changed = JSON.stringify(parsed) !== before

  console.log('· ' + manifest.name)
  console.log('  仓库：' + REPO_ROOT)
  console.log('  依赖：' + (prev === undefined ? '（原先没有）' : prev) + ' → ' + spec)
  console.log('  bundles：' + (changed ? '已追加/更新' : '已是最新') + '（共 ' + bundles.length + ' 项）')
  console.log('  patch：' + manifest.files.join(', '))
  if (opts.dryRun) { console.log('  [dry-run] 未写入 ' + manifestPath); runPnpmInstall(profileDir, true); return }
  if (changed) fs.writeFileSync(manifestPath, JSON.stringify(parsed, null, 2) + '\n')
  else console.log('  [i] manifest 无变化，不重写')
  runPnpmInstall(profileDir, false)
  console.log('  ✓ 已安装 → ' + path.join(profileDir, 'node_modules', manifest.name))
  console.log('  ⇒ 生效需要一次真正的重新挂载（宿主进程重启，或让 preset 重新装配）；')
  console.log('     同一进程里新开会话不算重挂（pitfalls A 节）。装配后在新会话里选 ptc-gate。')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { console.log(USAGE); return EXIT_OK }

  const home = resolveDshHome(opts.home)
  const profile = opts.profile !== null ? opts.profile : (process.env.DSH_PROFILE || 'web')
  const profileDir = path.join(home, 'profiles', profile)
  const manifest = readRepoManifest()
  const ids = presetIds()
  if (ids.length === 0) refuse('preset/ 下没有任何合法 preset 目录（id 须匹配 ' + String(PRESET_ID) + '）')

  const findings = composeFindings(ids, manifest)
  if (opts.compose) {
    for (const id of ids) {
      const label = EXPECTED_COMPOSITION[id] === undefined ? '(未登记)' : EXPECTED_COMPOSITION[id].label
      const own = findings.filter((finding) => finding.indexOf(id) === 0)
      console.log('· ' + id + '  ' + label + (own.length === 0 ? '  ✓ 组成符合期望' : ''))
      for (const finding of own) console.log('  ✗ ' + finding)
    }
    for (const finding of findings) {
      if (finding.indexOf(id) === 0) continue
      console.log('· ' + finding)
    }
    if (findings.length === 0) { console.log('✓ 组成契约通过：' + ids.length + ' 个 preset（含门插件副本一致性与 0.2.0 写法残留）'); return EXIT_OK }
    console.log('✗ 组成契约发现 ' + findings.length + ' 处问题')
    return EXIT_REFUSED
  }

  console.log('DSH home：' + home)
  console.log('profile：' + profileDir)
  console.log('bundle：' + manifest.name + '（' + manifest.files.length + ' 个 patch 文件）')

  if (opts.check) {
    if (findings.length > 0) {
      for (const finding of findings) console.log('  ✗ 组成：' + finding)
      console.log('✗ 对账发现 ' + findings.length + ' 处组成问题 ⇒ 先修仓库')
      return EXIT_DRIFT
    }
    const result = checkInstalled(manifest, profileDir)
    for (const finding of result.findings) console.log('  ✗ ' + finding)
    if (result.state === 'installed' && result.findings.length === 0) {
      console.log('✓ 对账通过：' + manifest.name + ' 已按仓库安装于 ' + profileDir)
      return EXIT_OK
    }
    if (result.state === 'absent' || result.state === 'broken') {
      if (result.state === 'broken') { console.log('✗ 对账中止：profile manifest 读不了'); return EXIT_DRIFT }
      console.log('✓ 对账通过：未安装（不算漂移）')
      return EXIT_OK
    }
    console.log('✗ 对账发现 ' + result.findings.length + ' 处漂移 ⇒ 跑 make deploy 重新安装')
    return EXIT_DRIFT
  }

  if (findings.length > 0) {
    for (const finding of findings) console.log('  ✗ 组成：' + finding)
    refuse('组成契约不通过，拒绝安装（先修仓库）')
  }
  const legacy = path.join(home, LEGACY_ROOT_DIR)
  if (fs.existsSync(legacy)) {
    const entries = fs.readdirSync(legacy).filter((name) => name.indexOf('.') !== 0)
    if (entries.length > 0) {
      console.log('  [i] 旧目录 ' + legacy + ' 还有 ' + entries.length + ' 项（' + entries.join(', ') + '）')
      console.log('      0.2.0 已无任何读者，删掉是安全且推荐的（内容只是软链或副本，仓库源不受影响）')
    }
  }
  installBundle(manifest, opts, profileDir)
  return EXIT_OK
}

try {
  process.exitCode = main()
} catch (error) {
  refuse('未捕获异常：' + (error && error.stack ? error.stack : String(error)))
}
