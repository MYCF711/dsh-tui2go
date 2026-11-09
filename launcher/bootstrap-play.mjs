#!/usr/bin/env node
/**
 * Create a DSH-GO play root from nothing.
 *
 * run-019.cmd assumes a play root already exists: `bin/dshd.exe`, a
 * `home/profiles/dsh-tui` profile with the TUI and this plugin installed, and a
 * `dsh` CLI under `npm/`. On the development machine all of that was built by
 * hand over days, which is exactly why "it only runs on this machine" was true.
 * This script produces the same layout on a clean one, one checked step at a
 * time, and refuses to continue silently when something is missing.
 *
 * What a play root contains (the checklist this script verifies at the end):
 *
 *   <PLAY>\bin\dshd.exe                          host binary
 *   <PLAY>\npm\package.json                      the dsh CLI (npm install)
 *   <PLAY>\npm\node_modules\.bin\dsh.cmd         its shim
 *   <PLAY>\home\profiles\dsh-tui\package.json    profile: bundles + deps
 *   <PLAY>\home\profiles\dsh-tui\node_modules\dsh-tui2go
 *                                                -> this plugin checkout
 *   <PLAY>\home\profiles\dsh-tui\node_modules\@deepseek-harness-tui\dsh-tui
 *   <PLAY>\logs\                                 where DSH_GO_DEBUG_LOG lands
 *
 * Created later, at first launch, by run-019.cmd / install-play.mjs / dshd:
 *   <PLAY>\home\profiles\dsh-tui\cordis.yml   profile root, written by the `dsh`
 *                                             CLI on the first boot ("edit
 *                                             cordis.patch.yml, not this file")
 *   <PLAY>\.pristine\        official dsh-tui tarball cache (overlay restore)
 *   <PLAY>\.dsh-tui\         TUI data dir (history, prefs, lang)
 *   <PLAY>\dsh-go-fresh\     DSH_GO_HOME (agent home: sessions, skills, logs)
 *
 * Usage:
 *   node launcher/bootstrap-play.mjs [--play <dir>] [--force] [--skip-cli]
 *
 *   --play <dir>   play root to create        (default: %DSH_GO_PLAY% > %TEMP%\TUI2GO-PLAY)
 *   --force        redo steps that already look done (CLI install, plugin add)
 *   --skip-cli     do not run `npm install` for the dsh CLI (offline / already there)
 *
 * Environment:
 *   DSH_GO_DSHD            use this dshd.exe instead of the repo build
 *   DSH_GO_DSH_CLI_VERSION dsh CLI version range (default: ^0.2.2-rc.1)
 *
 * Every failing step prints what is missing and the exact command that fixes it,
 * then exits non-zero: a half-built play root must never look usable.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const argv = process.argv.slice(2)
const flagValue = name => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : undefined
}
const forced = argv.includes('--force')
const skipCli = argv.includes('--skip-cli')
const CLI_RANGE = process.env.DSH_GO_DSH_CLI_VERSION ?? '^0.2.2-rc.1'
const TUI_PACKAGE = '@deepseek-harness-tui/dsh-tui@0.19.0'

const play = resolve(
  flagValue('play') ??
  (process.env.DSH_GO_PLAY && process.env.DSH_GO_PLAY.trim() !== '' ? process.env.DSH_GO_PLAY : join(process.env.TEMP ?? process.env.TMP ?? '.', 'TUI2GO-PLAY')),
)
const home = join(play, 'home')
const profile = join(home, 'profiles', 'dsh-tui')
const cliJs = join(play, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const dshd = join(play, 'bin', 'dshd.exe')

const say = line => console.log(`[bootstrap] ${line}`)
const warn = line => console.warn(`[bootstrap] WARN ${line}`)
function die (title, lines) {
  console.error(`[bootstrap] ERROR ${title}`)
  for (const line of lines) console.error(`[bootstrap]   ${line}`)
  process.exit(1)
}

/** Run a command, echo it, and turn a non-zero exit into the caller's failure. */
function run (file, args, options = {}) {
  say(`> ${[file, ...args].join(' ')}`)
  try {
    // stdio:'inherit' makes execFileSync return null, so the outcome — never the
    // return value — is what callers must read.
    execFileSync(file, args, { stdio: 'inherit', ...options })
    return { failed: false }
  } catch (error) {
    return { failed: true, error }
  }
}

/**
 * npm is a .js entry next to the running node, not a .cmd: going through
 * `cmd /d /s /c "npm ... \"C:\path with space\""` re-splits the prefix at the
 * quote (npm then tries to mkdir `"C:\..."` and dies with ENOENT, which is
 * exactly how the first dry run of this script failed). Exact argv has no such
 * failure mode.
 */
function npmCliPath () {
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(candidate) ? candidate : undefined
}

say(`play root : ${play}`)
say(`plugin    : ${pluginRoot}`)

// ---------------------------------------------------------------- 1. layout
for (const dir of [play, join(play, 'bin'), home, join(home, 'profiles'), join(play, 'logs'), join(play, 'npm')]) {
  mkdirSync(dir, { recursive: true })
}
say('layout    : ok (bin/ home/profiles/ logs/ npm/)')

// -------------------------------------------------------------- 2. dsh CLI
const haveCli = existsSync(cliJs)
if (!haveCli && skipCli) {
  die('no dsh CLI and --skip-cli was given', [
    `missing: ${cliJs}`,
    'drop --skip-cli to let this script install it, or install it yourself:',
    `  npm install --prefix "${join(play, 'npm')}" @deepseek-ai/dsh@${CLI_RANGE}`,
  ])
}
if (!haveCli || forced) {
  say(`dsh CLI   : installing @deepseek-ai/dsh@${CLI_RANGE} into ${join(play, 'npm')} (this needs the npm registry)`)
  const npmCli = npmCliPath()
  const result = npmCli === undefined
    ? { failed: true, error: new Error('npm-cli.js not found next to node') }
    : run(process.execPath, [npmCli, 'install', '--prefix', join(play, 'npm'), `@deepseek-ai/dsh@${CLI_RANGE}`], { cwd: play })
  if (result.failed || !existsSync(cliJs)) {
    die('npm install for the dsh CLI failed', [
      `expected afterwards: ${cliJs}`,
      'fix: check network/registry (npm config get registry), or install it into that prefix yourself:',
      `  npm install --prefix "${join(play, 'npm')}" @deepseek-ai/dsh@${CLI_RANGE}`,
    ])
  }
}
say(`dsh CLI   : ${cliJs}`)
const cliVersion = (() => {
  try {
    const text = readFileSync(join(play, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
    return JSON.parse(text).version ?? '(unknown)'
  } catch { return '(unknown)' }
})()
say(`dsh CLI ver: ${cliVersion}`)

// ------------------------------------------------------------ 3. dshd.exe
/**
 * Candidate order: an explicit binary, the repo's build outputs, then a fresh
 * `go build`. The repo's `bin/` is release-only (and can be older than the
 * source), so a source build is the honest fallback — it just has to be loud.
 *
 * The host repo is a *sibling* checkout (`<workspace>/public/dsh-tui2go` next to
 * `<workspace>/DSH-GO`), not an ancestor; a delivered copy of this plugin has no
 * repo at all, which is why DSH_GO_DSHD exists.
 */
const repoRoot = resolve(process.env.DSH_GO_REPO ?? join(pluginRoot, '..', '..', 'DSH-GO'))
const repoCandidates = [
  join(repoRoot, 'bin', 'dshd.exe'),
  join(repoRoot, 'bin', 'windows-amd64', 'dshd.exe'),
  join(repoRoot, 'dist', 'dshd.exe'),
]
const goModule = join(repoRoot, 'go.mod')
function installDshd () {
  const explicit = process.env.DSH_GO_DSHD
  if (explicit !== undefined && explicit.trim() !== '') {
    if (!existsSync(explicit)) die(`DSH_GO_DSHD points at a missing file`, [`${explicit}`, 'unset DSH_GO_DSHD to let this script build/copy one'])
    copyFileSync(explicit, dshd)
    return `DSH_GO_DSHD=${explicit}`
  }
  if (!forced && existsSync(dshd)) return 'already present'
  for (const candidate of repoCandidates) {
    if (existsSync(candidate)) {
      copyFileSync(candidate, dshd)
      return `copied ${candidate}`
    }
  }
  if (existsSync(goModule)) {
    say(`dshd      : no built binary found; building ./cmd/dshd from ${dirname(goModule)}`)
    const result = run('go', ['build', '-o', dshd, './cmd/dshd'], { cwd: dirname(goModule) })
    if (!result.failed && existsSync(dshd)) return `go build ./cmd/dshd -> ${dshd}`
  }
  return die('no dshd.exe available', [
    'looked for:',
    `  $DSH_GO_DSHD`,
    ...repoCandidates.map(candidate => `  ${candidate}`),
    `and a source build in ${dirname(goModule)} (go.mod ${existsSync(goModule) ? 'found' : 'NOT found'})`,
    'fix one of:',
    `  build it:  cd "${dirname(goModule)}" && go build -o "${dshd}" ./cmd/dshd`,
    `  point at it: set DSH_GO_DSHD=<a dshd.exe>`,
  ])
}
say(`dshd      : ${installDshd()} -> ${dshd}`)

// -------------------------------------------------------------- 4. profile
const profilePkg = join(profile, 'package.json')
const readProfile = () => { try { return JSON.parse(readFileSync(profilePkg, 'utf8')) } catch { return undefined } }
const deps = readProfile()?.dependencies ?? {}
const bundles = readProfile()?.dsh?.profile?.bundles ?? []

/** Forward to `dsh plugin` with exact argv (a Windows path with spaces must not
 *  go through cmd quoting: `pnpm add "D:/..."` splits at the space). */
function dshPlugin (pnpmArgs, label) {
  const result = run(process.execPath, [cliJs, 'plugin', '--profile', 'dsh-tui', ...pnpmArgs], {
    cwd: play,
    env: { ...process.env, DSH_HOME: home },
  })
  const after = readProfile()
  if (result.failed || after === undefined) {
    die(`${label} failed`, [
      `dsh plugin exited non-zero (profile: ${profile})`,
      'fix: run it by hand to see pnpm\'s own error:',
      `  set DSH_HOME=${home}`,
      `  "${process.execPath}" "${cliJs}" plugin --profile dsh-tui ${pnpmArgs.join(' ')}`,
    ])
  }
  return after
}

// The plugin first, then the TUI: `add` appends to dsh.profile.bundles, and the
// shipped profile's order is [dsh-base, dsh-tui2go, dsh-tui] (base -> backend ->
// front end). Same order here so a bootstrapped play root composes identically.
if (forced || deps['dsh-tui2go'] === undefined) {
  const after = dshPlugin(['add', pluginRoot], 'adding this plugin to the profile')
  say(`profile   : dsh-tui2go -> ${after.dependencies['dsh-tui2go']}`)
} else {
  say(`profile   : dsh-tui2go already declared (${deps['dsh-tui2go']})`)
}
if (forced || deps['@deepseek-harness-tui/dsh-tui'] === undefined) {
  const after = dshPlugin(['add', TUI_PACKAGE], 'installing the dsh-tui front end')
  say(`profile   : @deepseek-harness-tui/dsh-tui -> ${after.dependencies['@deepseek-harness-tui/dsh-tui']}`)
} else {
  say(`profile   : dsh-tui already declared (${deps['@deepseek-harness-tui/dsh-tui']})`)
}

const finalProfile = readProfile()
const finalBundles = finalProfile?.dsh?.profile?.bundles ?? []
for (const required of ['@deepseek-ai/dsh-base', 'dsh-tui2go', '@deepseek-harness-tui/dsh-tui']) {
  if (!finalBundles.includes(required)) {
    die('profile is missing a bundle', [
      `bundle ${required} is not in ${profilePkg}`,
      `bundles: ${JSON.stringify(finalBundles)}`,
      'fix: it is written by `dsh plugin --profile dsh-tui add <package>`; re-run that for the missing one',
    ])
  }
}
say(`profile   : bundles ${JSON.stringify(finalBundles)}`)

// ------------------------------------------------------------ 5. plugin link
/**
 * `node_modules/dsh-tui2go` must resolve to THIS checkout. A copied play root
 * keeps a link that still points at the original clone (or at a tarball), and
 * then "it works after copying" is only true because the old clone is still
 * there. Repair it here instead of hoping.
 */
function ensurePluginLink () {
  const link = join(profile, 'node_modules', 'dsh-tui2go')
  const target = (() => { try { return realpathSync(link) } catch { return undefined } })()
  const want = (() => { try { return realpathSync(pluginRoot) } catch { return pluginRoot } })()
  if (target !== undefined && resolve(target).toLowerCase() === resolve(want).toLowerCase()) return 'ok'
  if (target !== undefined) say(`link      : ${link} -> ${target} (wrong), relinking to ${want}`)
  try {
    if (target !== undefined || lstatSync(link, { throwIfNoEntry: false }) !== undefined) rmSync(link, { recursive: true, force: true })
  } catch (error) {
    die('cannot remove the stale plugin link', [`${link}`, `${error.message}`, 'fix: delete it yourself and re-run this script'])
  }
  mkdirSync(dirname(link), { recursive: true })
  // A junction on Windows (no elevation, no Developer Mode — unlike a symlink),
  // a plain symlink elsewhere. Both go through fs, never through a shell.
  try {
    symlinkSync(want, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    die('cannot create the plugin link', [
      `${link} -> ${want}`,
      `${error.message}`,
      process.platform === 'win32'
        ? `fix: mklink /J "${link}" "${want}"  (in an elevated prompt)`
        : `fix: ln -sfn "${want}" "${link}"`,
    ])
  }
  return 'relinked'
}
say(`link      : ${ensurePluginLink()}`)

// ------------------------------------------------------------- 6. checklist
const checks = [
  ['bin/dshd.exe', existsSync(dshd)],
  ['npm CLI (bin.js)', existsSync(cliJs)],
  ['profile package.json', existsSync(profilePkg)],
  ['profile node_modules', existsSync(join(profile, 'node_modules'))],
  ['dsh-tui installed', existsSync(join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'))],
  ['dsh-tui2go link', (() => {
    try { return resolve(realpathSync(join(profile, 'node_modules', 'dsh-tui2go'))).toLowerCase() === resolve(realpathSync(pluginRoot)).toLowerCase() } catch { return false }
  })()],
]
const missing = checks.filter(([, ok]) => !ok)
for (const [label, ok] of checks) say(`check     : ${ok ? 'ok  ' : 'MISS'} ${label}`)
if (missing.length > 0) {
  die('play root is incomplete', [
    `missing ${missing.length} item(s): ${missing.map(([label]) => label).join(', ')}`,
    'fix: re-run this script; if a step keeps failing it already printed the exact command',
  ])
}

// The TUI's own data dir and the agent home are created on first launch; note
// them so nobody hunts for them here.
say('next      : run launcher\\run-019.cmd (it sets HOME/USERPROFILE/DSH_HOME/DSH_GO_HOME from this root,')
say('            then install-play --ensure builds the bundle and applies the overlays)')
writeFileSync(join(play, 'PLAY-CONTENTS.md'), [
  '# play root layout',
  '',
  'Created by `launcher/bootstrap-play.mjs` on ' + new Date().toISOString() + '.',
  '',
  '| path | who creates it |',
  '| --- | --- |',
  '| `bin/dshd.exe` | bootstrap (copy from the repo build, `DSH_GO_DSHD`, or `go build ./cmd/dshd`) |',
  '| `npm/` | bootstrap (`npm install @deepseek-ai/dsh`) |',
  '| `home/profiles/dsh-tui/` | `dsh plugin --profile dsh-tui add …` |',
  '| `home/profiles/dsh-tui/cordis.yml` | the `dsh` CLI on the first boot |',
  '| `home/profiles/dsh-tui/node_modules/dsh-tui2go` | bootstrap (junction to this plugin checkout) |',
  '| `.pristine/` | `install-play --ensure/--audit` (official dsh-tui tarball cache) |',
  '| `.dsh-tui/` | the TUI at first launch (history, prefs, lang) |',
  '| `dsh-go-fresh/` | dshd at first launch (`DSH_GO_HOME`) |',
  '| `logs/` | `run-019.cmd` with `DSH_GO_DEBUG=1` |',
  '',
  `plugin checkout: ${pluginRoot}`,
  '',
].join('\n'))
say(`wrote     : ${join(play, 'PLAY-CONTENTS.md')}`)
say('done      : play root is complete')
