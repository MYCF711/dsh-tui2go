/**
 * Shared, idempotent overlay engine for the dsh-TUI 0.19 staging profile.
 *
 * Every overlay used to do this:
 *
 *     if (!existsSync(bak)) copyFileSync(file, bak)   // <-- polluted the backup
 *     patch(readFileSync(bak))                        // <-- then lost every anchor
 *
 * When the target file had already been patched and its `.bak` was missing (or
 * had been deleted), the *patched* file became the "backup". The next run then
 * read that polluted backup, could not find the pristine anchor and died with
 * `anchor missing ...` (exit 2) — which is exactly how the staging launcher
 * blocked PLAY-FINAL-INPUT-AUDIT/t122.
 *
 * This module enforces four rules instead:
 *
 *   1. idempotent  — if the target already carries the patch marker list, the
 *                    overlay logs SKIP and exits 0; it never re-patches and
 *                    never reports a missing anchor;
 *   2. backup safe — a `.bak` is only (re)written from pristine bytes. A backup
 *                    that does not match the official package (or, with no
 *                    pristine source available, cannot be proven pristine) is
 *                    repaired — patched bytes are never copied into a `.bak`;
 *   3. self-healing— target not applied *and* anchor missing ⇒ the file is in a
 *                    third state, so the pristine bytes are restored from the
 *                    official tarball cache and the patch is applied on top;
 *   4. restore     — `--restore` writes pristine bytes from that same cache even
 *                    when the `.bak` itself is polluted or missing.
 *
 * Patches stay additive: an overlay transforms the *current* file (not the
 * backup), so several overlays can touch one file (commands.js, capabilities.js)
 * without clobbering each other.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PACKAGE_NAME,
  ensurePristine,
  hasPristineCache,
  installedVersion,
  pristinePackageDir,
  profilePackageRoot,
  readPristine,
  sha16,
} from './_pristine.mjs'

/** Thrown when the pristine anchor text is absent from the current file. */
export class AnchorMissing extends Error {
  constructor(rel, detail) {
    super(`anchor missing ${rel}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'AnchorMissing'
    this.rel = rel
  }
}

/**
 * Declare one patched file.
 * @param rel       path inside `node_modules/@deepseek-harness-tui/dsh-tui`
 * @param bakSuffix backup suffix, e.g. `.dsh-go-command-bridge.bak`
 * @param markers   exact patched marker(s) — every one must be present for the
 *                  file to count as applied (multiple markers catch half-applied
 *                  multi-step overlays)
 * @param transform `(source) => patched`; must throw AnchorMissing when its
 *                  anchor text is not in `source`
 */
export function overlayFile({ rel, bakSuffix, markers, transform }) {
  if (typeof rel !== 'string' || rel.length === 0) throw new TypeError('overlayFile: rel is required')
  if (typeof bakSuffix !== 'string' || !bakSuffix.endsWith('.bak')) {
    throw new TypeError(`overlayFile: bakSuffix must end with .bak (${rel})`)
  }
  if (typeof transform !== 'function') throw new TypeError(`overlayFile: transform is required (${rel})`)
  const list = Array.isArray(markers) ? markers : [markers]
  if (list.length === 0 || list.some(marker => typeof marker !== 'string' || marker.length === 0)) {
    throw new TypeError(`overlayFile: markers must be non-empty strings (${rel})`)
  }
  return { rel, bakSuffix, markers: list, transform }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function readText(file) {
  return stripBom(readFileSync(file, 'utf8'))
}

/**
 * Replace `file` atomically (temp file + rename).
 *
 * A plain `writeFileSync` writes *through* a hard link: pnpm store files are
 * hard-linked into `node_modules`, and two play profiles installed from the same
 * store can share one inode for `lib/types/**`. Writing in place therefore
 * patched (or restored) the other profile and the store as a side effect. The
 * rename gives this profile its own inode and never leaves a half-written file.
 */
function writeAtomic(file, data) {
  const tmp = `${file}.dsh-go-tmp-${process.pid}`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function markerHit(source, entry) {
  return entry.markers.every(marker => source.includes(marker))
}

function describe(buffer) {
  return buffer === undefined ? 'missing' : `${buffer.length}:${sha16(buffer)}`
}

/**
 * Run one overlay against a play profile.
 * @returns exit code: 0 ok, 2 failed
 */
export function runOverlay({ name, profile, restore = false, audit = false, files }) {
  const tag = name === undefined ? '[overlay]' : `[${name}]`
  const say = line => console.log(`${tag} ${line}`)
  const warn = line => console.warn(`${tag} ${line}`)
  const fail = line => {
    console.error(`${tag} ERROR ${line}`)
    return 2
  }

  if (typeof profile !== 'string' || profile.length === 0) return fail('usage: <script> <profile-dir> [--restore|--audit]')
  const pkgRoot = profilePackageRoot(profile)
  if (!existsSync(join(pkgRoot, 'package.json'))) return fail(`profile not found: ${pkgRoot}`)

  let version
  try {
    version = installedVersion(profile)
  } catch (error) {
    return fail(error.message)
  }

  let pristineSource // { packageDir, version, cached, tarball?, tarballSha256? } | null (probed, unavailable)
  const pristineBytes = rel => {
    if (pristineSource === undefined) {
      pristineSource = hasPristineCache(profile, version) ? { packageDir: pristinePackageDir(profile, version), cached: true } : null
    }
    if (pristineSource === null) return undefined
    const text = readPristine(profile, rel, version)
    return text === undefined ? undefined : Buffer.from(text)
  }
  const requirePristineBytes = rel => {
    const cached = pristineBytes(rel)
    if (cached !== undefined) return cached
    const fetched = ensurePristine(profile)
    pristineSource = fetched
    say(`PRISTINE fetched ${PACKAGE_NAME}@${version} -> ${fetched.packageDir}${fetched.tarballSha256 === undefined ? '' : ` tarball sha256=${fetched.tarballSha256}`}`)
    const text = readPristine(profile, rel, version)
    if (text === undefined) throw new Error(`pristine source has no ${rel}`)
    return Buffer.from(text)
  }

  const repairBackup = (entry, bakFile, pristine) => {
    if (pristine === undefined) return false
    const current = existsSync(bakFile) ? readFileSync(bakFile) : undefined
    if (current !== undefined && current.equals(pristine)) return false
    writeAtomic(bakFile, pristine)
    say(`BAK-REPAIRED ${entry.rel}${entry.bakSuffix} <- pristine ${describe(pristine)}${current === undefined ? ' (was missing)' : ` (was ${describe(current)})`}`)
    return true
  }

  /**
   * Backup upkeep must never fail an `--ensure` that already has the right
   * target bytes: a missing/unverified `.bak` is harmless (it only weakens a
   * later `--restore`, which then fails loudly), whereas writing bytes we cannot
   * prove pristine is the bug this helper exists to prevent.
   */
  const bestEffortPristineBytes = rel => {
    try {
      return requirePristineBytes(rel)
    } catch (error) {
      warn(`pristine source unavailable for ${rel}: ${error?.message ?? error}`)
      warn(`${rel}: leaving .bak unverified (target bytes are already correct)`)
      return undefined
    }
  }

  const applyEntry = (entry, file, bakFile) => {
    const source = readText(file)
    const applied = markerHit(source, entry)
    if (applied) {
      // The target is done; the backup still has to be trustworthy, otherwise the
      // next --restore would write patched bytes back as "pristine".
      repairBackup(entry, bakFile, bestEffortPristineBytes(entry.rel))
      say(`SKIP ${entry.rel} already applied ${describe(Buffer.from(source))}`)
      return 'skipped'
    }

    let next
    let recovered = false
    try {
      next = entry.transform(source)
    } catch (error) {
      if (!(error instanceof AnchorMissing)) throw error
      const pristine = requirePristineBytes(entry.rel)
      if (markerHit(pristine.toString('utf8'), entry)) {
        throw new Error(`pristine source for ${entry.rel} is already patched — refusing to guess`)
      }
      say(`RECOVER ${entry.rel} not applied + anchor missing -> pristine ${describe(pristine)}`)
      writeAtomic(file, pristine)
      repairBackup(entry, bakFile, pristine)
      next = entry.transform(pristine.toString('utf8'))
      recovered = true
    }
    if (typeof next !== 'string' || !markerHit(next, entry)) {
      throw new Error(`patch for ${entry.rel} produced no marker — refusing to write`)
    }
    writeAtomic(file, next)
    // Never derive a backup from the target: another overlay (or a hand edit) may
    // already have touched this file, which is exactly how the polluted
    // `plugin.js` backup blocked the launcher. Official bytes or nothing.
    repairBackup(entry, bakFile, bestEffortPristineBytes(entry.rel))
    say(`${recovered ? 'RECOVERED' : 'PATCHED'} ${entry.rel} patched=${describe(Buffer.from(next))}`)
    return recovered ? 'recovered' : 'patched'
  }

  const restoreEntry = (entry, file, bakFile) => {
    // Authoritative pristine bytes only: a polluted backup must never be able to
    // pass as pristine here (that is the t122 failure mode).
    const pristine = requirePristineBytes(entry.rel)
    writeAtomic(file, pristine)
    repairBackup(entry, bakFile, pristine)
    say(`RESTORED ${entry.rel} pristine=${describe(pristine)}`)
    return 'restored'
  }

  const auditEntry = (entry, file, bakFile) => {
    const fileBytes = readFileSync(file)
    const bakBytes = existsSync(bakFile) ? readFileSync(bakFile) : undefined
    let pristine = pristineBytes(entry.rel)
    if (pristine === undefined) {
      try {
        pristine = requirePristineBytes(entry.rel)
      } catch (error) {
        warn(`no pristine source for ${entry.rel}: ${error?.message ?? error}`)
      }
    }
    const text = fileBytes.toString('utf8')
    const state =
      pristine === undefined
        ? markerHit(text, entry) ? 'applied' : 'unknown/no-cache'
        : fileBytes.equals(pristine) ? 'pristine' : markerHit(text, entry) ? 'applied' : 'DIRTY'
    const bakState =
      bakBytes === undefined
        ? 'missing'
        : pristine === undefined
          ? markerHit(bakBytes.toString('utf8'), entry) ? 'POLLUTED' : 'unverified/no-cache'
          : bakBytes.equals(pristine) ? 'pristine' : 'POLLUTED'
    console.log(`${tag} AUDIT ${entry.rel} file=${describe(fileBytes)} bak=${describe(bakBytes)} pristine=${describe(pristine)} state=${state} bak-state=${bakState}`)
    return 'audited'
  }

  const counts = { patched: 0, skipped: 0, recovered: 0, restored: 0, audited: 0 }
  for (const entry of files) {
    const file = join(pkgRoot, ...entry.rel.split('/'))
    const bakFile = file + entry.bakSuffix
    if (!existsSync(file)) return fail(`missing ${file}`)
    try {
      const result = audit
        ? auditEntry(entry, file, bakFile)
        : restore
          ? restoreEntry(entry, file, bakFile)
          : applyEntry(entry, file, bakFile)
      counts[result] += 1
    } catch (error) {
      return fail(`${entry.rel}: ${error?.message ?? error}`)
    }
  }

  if (audit) {
    say(`AUDIT done files=${files.length} pristine-source=${pristineSource === null || pristineSource === undefined ? 'unavailable' : pristineSource.packageDir}`)
  } else if (restore) {
    say(`RESTORE done files=${counts.restored} pristine=${version}`)
  } else {
    say(`OK files=${files.length} patched=${counts.patched} recovered=${counts.recovered} skipped=${counts.skipped} pristine=${version}`)
  }
  return 0
}

/** CLI glue shared by every overlay script. */
export function main({ name, files }) {
  const profile = process.argv[2]
  const restore = process.argv.includes('--restore')
  const audit = process.argv.includes('--audit')
  process.exitCode = runOverlay({ name, profile, restore, audit, files })
}
