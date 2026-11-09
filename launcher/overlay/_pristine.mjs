/**
 * Official (pristine) source for the dsh-TUI copy installed in a play profile.
 *
 * The staging launcher patches files inside
 *   <PLAY>/<home>/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/
 * and keeps one `.bak` next to every patched file. A `.bak` is only trustworthy
 * when it is byte-identical to the official package, so this module is the
 * single source of truth for that comparison:
 *
 *   1. read the *installed* version from the profile's package.json — the
 *      version is never hard-coded here;
 *   2. `npm pack @deepseek-harness-tui/dsh-tui@<version>` exactly once;
 *   3. extract it into `<PLAY>/.pristine/dsh-tui-<version>/package` and reuse
 *      that directory forever.
 *
 * After the first fill the cache is authoritative and no network is used again.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const PACKAGE_NAME = '@deepseek-harness-tui/dsh-tui'
const PACK_TARBALL_RE = /^deepseek-harness-tui-dsh-tui-.*\.tgz$/

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha16(buffer) {
  return sha256(buffer).slice(0, 16)
}

/** <profile>/node_modules/@deepseek-harness-tui/dsh-tui */
export function profilePackageRoot(profile) {
  return join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
}

/** Version actually installed in the play profile (never hard-coded). */
export function installedVersion(profile) {
  const file = join(profilePackageRoot(profile), 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`[pristine] no version field in ${file}`)
  }
  return pkg.version
}

/**
 * <PLAY>/.pristine — `<profile>` is `<PLAY>/<home>/profiles/dsh-tui`, so the
 * play root is three levels up. `DSH_TUI2GO_PRISTINE` overrides the location
 * (used by tests); nothing else may point the cache somewhere unstable.
 */
export function cacheRoot(profile) {
  const override = process.env.DSH_TUI2GO_PRISTINE
  if (override !== undefined && override.length > 0) return resolve(override)
  return join(resolve(profile, '..', '..', '..'), '.pristine')
}

export function pristinePackageDir(profile, version = installedVersion(profile)) {
  return join(cacheRoot(profile), `dsh-tui-${version}`, 'package')
}

function usable(dir, version) {
  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) return false
  try {
    return JSON.parse(readFileSync(pkgFile, 'utf8')).version === version
  } catch {
    return false
  }
}

/** Pristine text for one file, or undefined when the cache has not been filled. */
export function readPristine(profile, relPath, version = installedVersion(profile)) {
  const file = join(pristinePackageDir(profile, version), ...relPath.split('/'))
  if (!existsSync(file)) {
    if (!usable(pristinePackageDir(profile, version), version)) return undefined
    throw new Error(`[pristine] ${PACKAGE_NAME}@${version} has no ${relPath}`)
  }
  return readFileSync(file, 'utf8')
}

export function hasPristineCache(profile, version = installedVersion(profile)) {
  return usable(pristinePackageDir(profile, version), version)
}

function runNpmPack(version, packDir) {
  const spec = `${PACKAGE_NAME}@${version}`
  const args = ['pack', spec, '--pack-destination', packDir, '--loglevel=error', '--no-audit', '--no-fund']
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const options = { cwd: packDir, timeout: 300_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
  if (existsSync(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], options)
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return execFileSync(comspec, ['/d', '/s', '/c', `npm ${args.join(' ')}`], options)
}

function tarBinary() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  if (systemRoot !== undefined && process.platform === 'win32') {
    const candidate = join(systemRoot, 'System32', 'tar.exe')
    if (existsSync(candidate)) return candidate
  }
  return 'tar'
}

function extractTarball(tarball, destDir) {
  const options = { timeout: 180_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }
  execFileSync(tarBinary(), ['-xzf', tarball.replace(/\\/g, '/'), '-C', destDir.replace(/\\/g, '/')], options)
}

/**
 * Guarantee `<PLAY>/.pristine/dsh-tui-<version>/package` exists.
 * Returns { packageDir, version, cached, tarball?, tarballSha256? }.
 */
export function ensurePristine(profile) {
  const version = installedVersion(profile)
  const packageDir = pristinePackageDir(profile, version)
  if (usable(packageDir, version)) return { packageDir, version, cached: true }

  const root = cacheRoot(profile)
  mkdirSync(root, { recursive: true })
  const tmp = mkdtempSync(join(root, '.tmp-'))
  try {
    const packDir = join(tmp, 'pack')
    const extractDir = join(tmp, 'extract')
    mkdirSync(packDir, { recursive: true })
    mkdirSync(extractDir, { recursive: true })
    runNpmPack(version, packDir)
    const tarball = readdirSync(packDir).find(name => PACK_TARBALL_RE.test(name))
    if (tarball === undefined) {
      throw new Error(`[pristine] npm pack produced no tarball for ${PACKAGE_NAME}@${version}`)
    }
    const tarballPath = join(packDir, tarball)
    const tarballSha256 = sha256(readFileSync(tarballPath))
    extractTarball(tarballPath, extractDir)
    const staged = join(extractDir, 'package')
    if (!usable(staged, version)) {
      throw new Error(`[pristine] tarball for ${PACKAGE_NAME}@${version} did not contain package/package.json@${version}`)
    }
    const destDir = join(root, `dsh-tui-${version}`)
    mkdirSync(destDir, { recursive: true })
    try {
      renameSync(staged, packageDir)
    } catch (error) {
      // Another launcher run may have won the race; reuse its copy.
      if (!usable(packageDir, version)) throw error
    }
    writeFileSync(
      join(destDir, 'SOURCE.json'),
      JSON.stringify({ package: PACKAGE_NAME, version, tarball, tarballSha256, fetchedAt: new Date().toISOString() }, null, 2) + '\n',
    )
    return { packageDir, version, cached: false, tarball, tarballSha256 }
  } catch (error) {
    const stderr = error?.stderr === undefined ? '' : String(error.stderr).trim()
    throw new Error(`[pristine] cannot fetch ${PACKAGE_NAME}@${version}: ${error?.message ?? error}${stderr ? `\n${stderr}` : ''}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
