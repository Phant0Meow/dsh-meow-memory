/** GitHub prepare must build without installing the Host-owned optional peer. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const fixture = mkdtempSync(join(tmpdir(), 'meow-prepare-'))
try {
  for (const name of ['package.json', 'build.mjs', 'src']) {
    cpSync(join(root, name), join(fixture, name), { recursive: true })
  }
  mkdirSync(join(fixture, 'node_modules'))
  // esbuild is the only build-time dependency. Do not expose this checkout's
  // node_modules: a workspace dsh-llm link would conceal the GitHub failure.
  symlinkSync(realpathSync(dirname(require.resolve('esbuild/package.json'))),
    join(fixture, 'node_modules', 'esbuild'), 'junction')
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.prepare, 'node build.mjs')
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-llm'].optional, true)
  assert.equal(manifest.devDependencies['@deepseek-ai/dsh-llm'], undefined)
  assert.equal(manifest.dependencies?.['@deepseek-ai/dsh-llm'], undefined)
  assert.equal(existsSync(join(fixture, 'node_modules', '@deepseek-ai')), false)
  const result = spawnSync(process.execPath, ['build.mjs'], { cwd: fixture, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const bundle = readFileSync(join(fixture, 'lib/index.js'), 'utf8')
  assert.match(bundle, /from ["']@deepseek-ai\/dsh-llm["']/)
  assert.match(bundle, /from ["']@deepseek-ai\/schemastery["']/)
  assert.ok(existsSync(join(fixture, 'lib/client.js')))
  assert.ok(existsSync(join(fixture, 'lib/prompts')))
  console.log('PASS: clean prepare builds without Host peers; runtime imports stay external')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
