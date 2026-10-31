/**
 * Optional integration test against an independently installed official DSH.
 * Build this plugin first, then run:
 *   node tests/host-peers.mjs /path/to/node_modules/@deepseek-ai/dsh [plugin-root]
 * No network, model calls or credentials are used. Run each Host in a new process.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

assert.ok(process.argv[2], 'Pass the package directory of an independently installed @deepseek-ai/dsh')
const hostRoot = realpathSync(resolve(process.argv[2]))
const source = resolve(process.argv[3] ?? fileURLToPath(new URL('..', import.meta.url)))
const anchor = join(hostRoot, 'package.json')
const hostManifest = JSON.parse(readFileSync(anchor, 'utf8'))
assert.equal(hostManifest.name, '@deepseek-ai/dsh')
const hostRequire = createRequire(anchor)
const host = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
const temp = mkdtempSync(join(tmpdir(), 'meow-host-peers-'))
const home = join(temp, 'home')
const profileDir = join(home, 'profiles', 'test')
const pluginDir = join(profileDir, 'node_modules', 'meow-memory')
const probeDir = join(profileDir, 'node_modules', 'meow-host-probe')
const previousHome = process.env.MEOW_MEMORY_HOME
let ctx
try {
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(probeDir)
  cpSync(join(source, 'lib'), join(pluginDir, 'lib'), { recursive: true })
  cpSync(join(source, 'package.json'), join(pluginDir, 'package.json'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ private: true,
    dependencies: { 'meow-memory': 'file:./node_modules/meow-memory', 'meow-host-probe': 'file:./node_modules/meow-host-probe' },
    dsh: { profile: { bundles: [] } } }))
  writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'meow-host-probe', version: '1.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(probeDir, 'index.js'), `
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as meow from 'meow-memory'
export function apply(ctx) {
  assert.equal(meow.name, 'meow-memory')
  assert.equal(typeof meow.apply, 'function')
  assert.ok(meow.Config)
  const workspace = ${JSON.stringify(temp)}
  try {
    const messages = [
      meow.buildDreamMessage(null, 'host-test', Date.now(), [{kind: 'project-summary', projects: ['host-test']}], 0),
      meow.buildReflectMessage(workspace, 'host-test'),
    ]
    for (const message of messages) {
      const expected = createUserMessage({content: message.content, source: message.source})
      assert.deepEqual({...message, id: undefined}, {...expected, id: undefined})
      assert.equal(message.role, 'user')
      assert.equal(typeof message.id, 'string')
      assert.equal(message.source.kind, 'plugin:meow-memory')
      assert.ok(message.content[0].text.length > 0)
      for (const value of [message, message.content, message.content[0], message.source]) assert.ok(Object.isFrozen(value))
    }
    ctx.provide('meowHostProbe', { resolved: import.meta.resolve('@deepseek-ai/dsh-llm') })
  } finally { meow.closeAllDbs() }
}
`)
  const config = join(profileDir, 'config.yml')
  writeFileSync(config, '- id: probe\n  name: meow-host-probe\n')
  assert.equal(existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-llm')), false)
  // Negative control: avoid accidentally testing ordinary ancestor resolution.
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(pluginDir, 'lib/index.js')).href)})`], { encoding: 'utf8' })
  assert.notEqual(plain.status, 0, 'Isolated plugin unexpectedly loads without the Host')
  assert.match(plain.stderr, /ERR_MODULE_NOT_FOUND/)
  assert.match(plain.stderr, /@deepseek-ai\/dsh-llm/)
  process.env.MEOW_MEMORY_HOME = join(temp, 'memory')
  let prepare
  let profile
  if (typeof host.loadProfileDirectory === 'function') {
    profile = host.loadProfileDirectory('meow-host-test', profileDir, anchor)
  } else {
    // DSH 0.1.1 performs installation-wide fallback healing before loading a profile.
    await host.healProfilesModuleFallback(anchor, home)
    profile = host.loadProfile('meow-host-test', 'test', anchor, home)
  }
  if (typeof host.createRuntimeResolution === 'function') {
    const resolution = await host.createRuntimeResolution({ installAnchor: anchor, profile, home })
    prepare = async (hostCtx) => { await hostCtx.plugin(host.PluginPackages, { resolution }) }
  } else if (typeof host.loadProfileDirectory === 'function') {
    // DSH 0.1.5 uses installation fallback links, before PluginPackages existed.
    assert.equal(typeof host.healProfilesModuleFallback, 'function')
    await host.healProfilesModuleFallback({ installAnchor: anchor, profile, home })
  }
  ctx = await host.boot('meow-host-test', config, [], prepare)
  const probe = ctx.get('meowHostProbe')
  assert.ok(probe, 'Actual Host Loader did not activate the probe')
  assert.equal(probe.resolved, pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')).href)
  assert.equal(existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-llm')), false)
  console.log('PASS: DSH', hostManifest.version, 'loads isolated plugin and preserves message contracts without a profile dsh-llm copy')
} finally {
  await ctx?.fiber.dispose()
  if (previousHome === undefined) delete process.env.MEOW_MEMORY_HOME
  else process.env.MEOW_MEMORY_HOME = previousHome
  rmSync(temp, { recursive: true, force: true })
}
