#!/usr/bin/env node
/**
 * Reproducible play-profile installer for dsh-tui2go.
 *
 * Builds the package bundle, then applies the minimum 0.19 overlays to an
 * ISOLATED play profile. Never touches the real user profile.
 *
 * Idempotency contract (see `overlay/_patch.mjs` for the engine):
 *   - `--ensure` is the launcher path: already-applied files are SKIPPED, a
 *     polluted `.bak` is repaired from official pristine bytes, and a file that
 *     is neither pristine nor patched is healed from the same source;
 *   - pristine restore happens automatically only when the profile's dsh-tui
 *     version changed (stale edits from another version), or with `--refresh`;
 *   - `--restore` puts every touched file back to official pristine bytes even
 *     when its `.bak` was polluted or deleted;
 *   - `--audit` prints file / backup / pristine hashes for every patched file
 *     and downloads the pristine source once into `<PLAY>/.pristine`;
 *   - `--print-profile` prints the resolved profile directory and which rule
 *     found it (diagnostics + the self-test's seam), then exits 0.
 *
 * The profile itself is never a hard-coded path: DSH_PLAY_PROFILE >
 * DSH_HOME/profiles/dsh-tui > derived from this file's location > fail loud
 * (see `locateProfile`). `launcher/bootstrap-play.mjs` creates the play root
 * this expects.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensurePristine, installedVersion, readPristine } from './overlay/_pristine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = new Set(process.argv.slice(2))

/**
 * Locate the play profile. No machine path is baked in anywhere: every step is
 * either an explicit override or derived from this file's own location.
 *
 *   1. `DSH_PLAY_PROFILE` — the profile directory itself (wins over everything;
 *      this is what a copied play root or a second profile should set);
 *   2. `DSH_HOME/profiles/dsh-tui` — the launcher's own contract: run-019.cmd
 *      always sets `DSH_HOME=<PLAY>\home` before calling us;
 *   3. derived: walk up from this script, from the plugin root, and from the
 *      current directory looking for `<dir>/home/profiles/dsh-tui` with a
 *      package.json (that is what a play root looks like: `home/`, `bin/dshd.exe`
 *      and `npm/` side by side);
 *   4. nothing matched → fail loud. Never fall back to a remembered machine
 *      path: silently patching a profile that happens to exist on *my* machine
 *      is how "it works here" ships.
 */
function locateProfile () {
  const explicit = process.env.DSH_PLAY_PROFILE
  if (explicit !== undefined && explicit.trim() !== '') return { dir: resolve(explicit), source: 'DSH_PLAY_PROFILE' }
  const home = process.env.DSH_HOME
  if (home !== undefined && home.trim() !== '') return { dir: join(resolve(home), 'profiles', 'dsh-tui'), source: 'DSH_HOME/profiles/dsh-tui' }
  const tried = []
  const seen = new Set()
  // A play root has a profile *and* the play-root markers run-019.cmd builds
  // around it (`bin/dshd.exe`, `npm/`). Requiring them matters: a plain
  // `D:\DeepSeek Harness\home\profiles\dsh-tui` (the real host home) also has a
  // package.json, and deriving *that* would patch the user's own profile — the
  // one thing this script promises never to touch.
  const looksLikePlay = dir => existsSync(join(dir, 'home', 'profiles', 'dsh-tui', 'package.json')) &&
    (existsSync(join(dir, 'bin', 'dshd.exe')) || existsSync(join(dir, 'npm', 'node_modules')))
  for (const start of [here, root, process.cwd()]) {
    let dir = resolve(start)
    // Level 0 is the start directory itself (this is how "the launcher sits
    // inside the play root" resolves), then up to four ancestors above it.
    for (let level = 0; level <= 4; level += 1) {
      const candidate = join(dir, 'home', 'profiles', 'dsh-tui')
      if (!seen.has(candidate)) {
        seen.add(candidate)
        tried.push(candidate)
        if (looksLikePlay(dir)) return { dir: candidate, source: `derived from ${dir}` }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const looked = tried.map(candidate => `\n[install-play]     ${candidate}`).join('')
  console.error(
    '[install-play] ERROR: cannot locate a dsh-tui play profile.\n' +
    '[install-play]   DSH_PLAY_PROFILE is unset\n' +
    '[install-play]   DSH_HOME is unset (the launcher sets it to <PLAY>\\home)\n' +
    `[install-play]   nothing looked like <PLAY>\\home\\profiles\\dsh-tui near this script:${looked}\n` +
    '[install-play] fix — one of:\n' +
    '[install-play]   set DSH_PLAY_PROFILE=<the profile directory>\n' +
    '[install-play]   set DSH_HOME=<PLAY>\\home      (run-019.cmd does this for you)\n' +
    '[install-play]   run launcher/bootstrap-play.mjs to create a play root, then retry',
  )
  process.exit(2)
}

const { dir: profile, source: profileSource } = locateProfile()
const restoreOnly = args.has('--restore')
const auditOnly = args.has('--audit')
const shouldBuild = args.has('--build')
const refresh = args.has('--refresh')
if (args.has('--print-profile')) {
  console.log(profile)
  console.log(`source=${profileSource}`)
  process.exit(0)
}
const hashFile = profile + '/.dsh-tui2go-bundle.json'

function hashInputs() {
  const files = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (/\.(ts|mjs|json|cmd|vbs)$/.test(name)) files.push(full)
    }
  }
  for (const p of ['src', 'launcher/overlay']) walk(join(root, p))
  for (const p of ['package.json', 'tsconfig.json', 'dsh-plugin.json', 'launcher/install-play.mjs', 'launcher/run-019.cmd']) files.push(join(root, p))
  files.sort()
  const h = createHash('sha256')
  for (const file of files) { h.update(file.slice(root.length + 1)); h.update('\u0000'); h.update(readFileSync(file)); h.update('\u0000') }
  return h.digest('hex')
}

/**
 * Every overlay that a working play profile needs. Restore runs in reverse
 * order, apply runs in this order; overlays that share a target file
 * (commands.js, channel/capabilities.js) are additive and therefore safe.
 */
const scripts = [
  // Permission modes are NOT patched here any more: the cycle is supplied by
  // this plugin as a backend `modes` capability (src/modes.ts) and the TUI
  // deletes its own native cycle as soon as a backend declares one
  // (dsh-adapter/channel/core/compose.js:1073), so rewriting
  // DEFAULT_SESSION_MODES bought nothing but an extra anchor. See `retired`.
  // plugin → TUI channel (core IPC delegates)
  ['core-ipc.mjs', 'dsh-adapter/channel/core/compose.js'],
  // command surface
  ['command-bridge.mjs', 'commands.js + channel/capabilities.js'],
  ['channel-gate.mjs', 'commands.js'],
  ['promptinput-gate.mjs', 'components/PromptInput.js'],
  ['flow-close.mjs', 'screens/Chat.js'],
  // workspace capability, port bridge and attach trace
  ['workspace-capability.mjs', 'channel/capabilities.js'],
  ['workspace-action-readiness.mjs', 'dsh-adapter/channel/action-readiness.js'],
  ['workspace-attach-trace.mjs', 'dsh-adapter/workspace.js'],
  ['placeholder-workspace.mjs', 'dsh-adapter/plugin.js + dsh-adapter/backends.js'],
]
const run = (file, ...a) => execFileSync(process.execPath, [join(here, 'overlay', file), profile, ...a], { stdio: 'inherit' })

/**
 * Patches a previous launcher applied and this one no longer ships.
 *
 * A profile installed by an older launcher still carries them, and leaving a
 * stale source patch behind is exactly the kind of hidden state that makes a
 * profile unreproducible: `--restore` would no longer cover it either, because
 * the overlay is gone from `scripts`. So `--ensure` puts the official bytes back
 * once and drops the orphaned `.bak`.
 *
 * `permission-modes` rewrote 0.19's DEFAULT_SESSION_MODES (default/plan/full,
 * sandbox+approval atoms) into the DSH-GO permission cycle. That cycle now comes
 * from the backend capability, and for a DSH-GO session the TUI never reads
 * DEFAULT_SESSION_MODES: with `capabilities.modes` present it deletes its own
 * native `cycleMode` delegate (dsh-adapter/channel/core/compose.js:1073) and
 * Shift+Tab walks `modes.cycle() ?? modes.list()` from the backend
 * (dsh-adapter/channel/core/actions.js:28). The host `modes:` config item feeds
 * the *native* roster instead (`dsh-adapter/channel/extensions.js:179`), i.e. it
 * would be dead config here — which is why this is a retirement, not a rewrite
 * into cordis.patch.yml.
 */
const retired = [
  { rel: 'lib/types/sessionModes.js', bakSuffix: '.dsh-go-permission-modes.bak', marker: "    { id: 'deny', permission: 'deny' }," },
]

function retirePatchedFiles(version) {
  for (const entry of retired) {
    const file = join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui', ...entry.rel.split('/'))
    const bakFile = `${file}${entry.bakSuffix}`
    if (!existsSync(file)) continue
    const patched = readFileSync(file, 'utf8').includes(entry.marker)
    if (!patched && !existsSync(bakFile)) continue
    let pristine
    try {
      pristine = readPristine(profile, entry.rel, version)
    } catch (error) {
      pristine = undefined
      console.warn(`[install-play] retired overlay: ${entry.rel}: ${error?.message ?? error}`)
    }
    if (pristine === undefined) {
      console.warn(`[install-play] retired overlay: no pristine source for ${entry.rel}; profile left as-is (run --audit to fill the cache)`)
      continue
    }
    if (patched) {
      // Same temp+rename as overlay/_patch.mjs: a plain write would go through a
      // pnpm hard link and edit the store (and any sibling profile) as well.
      const tmp = `${file}.dsh-go-tmp-${process.pid}`
      writeFileSync(tmp, pristine)
      renameSync(tmp, file)
      console.log(`[install-play] RETIRED ${entry.rel} -> official bytes (the mode cycle now comes from the backend)`)
    }
    rmSync(bakFile, { force: true })
  }
}

if (!existsSync(join(profile, 'node_modules/@deepseek-harness-tui/dsh-tui'))) {
  console.error(`[install-play] profile not found: ${profile}`)
  process.exit(2)
}
let version
try {
  version = installedVersion(profile)
} catch (error) {
  console.error(`[install-play] ${error.message}`)
  process.exit(2)
}
console.log(`[install-play] profile=${profile} dsh-tui=${version}`)

if (auditOnly) {
  let source
  try {
    source = ensurePristine(profile)
  } catch (error) {
    console.error(`[install-play] ${error.message}`)
    process.exit(2)
  }
  console.log(`[install-play] pristine=${source.packageDir}${source.cached ? ' (cached)' : ` (fetched tarball sha256=${source.tarballSha256})`}`)
  let failed = 0
  for (const [script] of scripts) {
    try { run(script, '--audit') } catch { failed += 1 }
  }
  console.log(`[install-play] audit scripts=${scripts.length} failed=${failed}`)
  process.exit(failed === 0 ? 0 : 2)
}

if (restoreOnly) {
  retirePatchedFiles(version)
  let failed = 0
  for (const [script] of [...scripts].reverse()) {
    try { run(script, '--restore') } catch { failed += 1 }
  }
  if (failed > 0) {
    console.error(`[install-play] restore failed scripts=${failed}`)
    process.exit(2)
  }
  console.log('[install-play] restored')
  process.exit(0)
}

const bundleHash = hashInputs()
let previous = undefined
try { previous = JSON.parse(readFileSync(hashFile, 'utf8')) } catch { /* first run */ }

if (shouldBuild || previous?.bundleHash !== bundleHash) {
  console.log(`[install-play] rebuilding bundle (${previous?.bundleHash === bundleHash ? 'forced' : 'source changed'}) ${bundleHash.slice(0, 12)}`)
  if (process.platform === 'win32') execFileSync(process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe', ['/d', '/s', '/c', 'npm run build'], { cwd: root, stdio: 'inherit' })
  else execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
} else {
  console.log(`[install-play] bundle up to date ${bundleHash.slice(0, 12)}`)
}
// Pristine restore is only needed when the patched files came from another
// dsh-tui version (stale edits would otherwise survive). Same version ⇒ the
// overlays are idempotent and report SKIP on every file.
if (refresh || previous?.tuiVersion !== version) {
  console.log(`[install-play] dsh-tui ${previous?.tuiVersion ?? '(unknown)'} -> ${version}${refresh ? ' (--refresh)' : ''}: restoring pristine before patching`)
  let restoreFailures = 0
  for (const [script] of [...scripts].reverse()) {
    try { run(script, '--restore') } catch { restoreFailures += 1 }
  }
  if (restoreFailures > 0) {
    console.warn(`[install-play] warn: ${restoreFailures} overlay(s) had no pristine source to restore from; apply will self-heal them`)
  }
} else {
  console.log('[install-play] overlays: ensure (idempotent)')
}
// Retired overlays first: a profile that still carries one of them must not be
// left with a patch this launcher no longer ships (and no longer restores).
retirePatchedFiles(version)
for (const [script] of scripts) run(script)
const dshd = process.env.DSH_GO_DSHD ?? 'dshd'
const dshdHash = existsSync(dshd) ? createHash('sha256').update(readFileSync(dshd)).digest('hex') : 'missing'
writeFileSync(hashFile, JSON.stringify({ bundleHash, tuiVersion: version, builtAt: new Date().toISOString(), dshd, dshdHash }, null, 2) + '\n')
console.log(`[install-play] ready bundle=${bundleHash.slice(0, 12)} dshd=${dshd} dshdHash=${dshdHash.slice(0, 12)} tui=${version} profile=${profile}`)
