#!/usr/bin/env node
/**
 * Self-test for install-play.mjs's profile discovery (no dependencies).
 *
 *   node --test launcher/selftest/
 *
 * The rule under test is "never invent a path": with no environment, a manual
 * run has to fail loudly and name the variable to set, instead of patching
 * whatever profile happens to exist on the machine that wrote the script.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, '..', 'install-play.mjs')
const repoRoot = resolve(here, '..', '..')

/** Everything that could steer discovery, removed so each case is hermetic. */
function cleanEnv (extra = {}) {
  const env = { ...process.env }
  for (const key of ['DSH_PLAY_PROFILE', 'DSH_HOME', 'DSH_GO_PLAY']) delete env[key]
  return { ...env, ...extra }
}

function run (args, { cwd = tmpdir(), env = cleanEnv() } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', windowsHide: true })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const norm = value => resolve(value).toLowerCase().replace(/\//g, '\\')

const workdirs = []
function fakePlay ({ withBin = true } = {}) {
  const play = mkdtempSync(join(tmpdir(), 'go5-play-'))
  workdirs.push(play)
  mkdirSync(join(play, 'home', 'profiles', 'dsh-tui'), { recursive: true })
  writeFileSync(join(play, 'home', 'profiles', 'dsh-tui', 'package.json'), JSON.stringify({ name: 'dsh-profile-dsh-tui', private: true, dependencies: {} }))
  if (withBin) {
    mkdirSync(join(play, 'bin'), { recursive: true })
    writeFileSync(join(play, 'bin', 'dshd.exe'), '')
  }
  return play
}

test.after(() => {
  for (const dir of workdirs) rmSync(dir, { recursive: true, force: true })
})

test('no environment, foreign cwd: fails loud and names both variables', () => {
  const { code, stdout, stderr } = run(['--ensure'], { cwd: tmpdir() })
  assert.equal(code, 2, 'a missing profile must not exit 0')
  assert.equal(stdout.trim(), '', 'nothing is printed as if it worked')
  assert.match(stderr, /cannot locate a dsh-tui play profile/)
  assert.match(stderr, /DSH_PLAY_PROFILE is unset/)
  assert.match(stderr, /DSH_HOME is unset/)
  assert.match(stderr, /set DSH_PLAY_PROFILE=/)
  assert.match(stderr, /bootstrap-play\.mjs/)
})

test('no environment, running from inside the plugin checkout: still fails loud', () => {
  // The checkout is NOT a play root (no home/profiles/dsh-tui next to bin/npm),
  // so `cd`-ing into it must not be mistaken for one.
  const { code, stderr } = run(['--ensure'], { cwd: repoRoot })
  assert.equal(code, 2)
  assert.match(stderr, /cannot locate a dsh-tui play profile/)
})

test('DSH_PLAY_PROFILE wins and is used verbatim', () => {
  const profile = join(tmpdir(), 'explicit-profile')
  const { code, stdout } = run(['--print-profile'], { env: cleanEnv({ DSH_PLAY_PROFILE: profile }) })
  assert.equal(code, 0)
  const [dir, source] = stdout.trim().split('\n')
  assert.equal(norm(dir), norm(profile))
  assert.equal(source, 'source=DSH_PLAY_PROFILE')
})

test('DSH_HOME resolves to <home>/profiles/dsh-tui', () => {
  const home = join(tmpdir(), 'some-play', 'home')
  const { code, stdout } = run(['--print-profile'], { env: cleanEnv({ DSH_HOME: home }) })
  assert.equal(code, 0)
  const [dir, source] = stdout.trim().split('\n')
  assert.equal(norm(dir), norm(join(home, 'profiles', 'dsh-tui')))
  assert.equal(source, 'source=DSH_HOME/profiles/dsh-tui')
})

test('a play root is derived from the current directory when no env is set', () => {
  const play = fakePlay()
  const { code, stdout } = run(['--print-profile'], { cwd: play })
  assert.equal(code, 0)
  const [dir, source] = stdout.trim().split('\n')
  assert.equal(norm(dir), norm(join(play, 'home', 'profiles', 'dsh-tui')))
  assert.match(source, /^source=derived from /)
})

test('a bare home/profiles/dsh-tui is NOT a play root (real host home regression guard)', () => {
  // D:\DeepSeek Harness\home\profiles\dsh-tui exists and has a package.json; it
  // is the *user's* host home. Deriving it would patch the profile this script
  // promises never to touch, so the play-root markers (bin/ or npm/) are required.
  const play = fakePlay({ withBin: false })
  const { code, stderr } = run(['--print-profile'], { cwd: play })
  assert.equal(code, 2)
  assert.match(stderr, /cannot locate a dsh-tui play profile/)
})
