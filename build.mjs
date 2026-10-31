/**
 * Build script: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/index.js — host loader entry (exports["."] / main), loaded by the
 *    dsh Node process.
 *  - lib/client.js — browser bundle in ModuleLoader.load format (the web
 *    shell's client module loader; see @deepseek-ai/dsh-client-modules).
 *
 * Plugin code is bundled with esbuild. Host-owned schemastery and dsh-llm
 * stay external and are resolved by the DSH profile loader; react stays
 * external on the client side (shell singleton, ModuleLoader resolves it).
 */
import { build, context } from 'esbuild';
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

// The @deepseek-ai/* packages live in the dsh-meow pnpm workspace, not in this
// package's node_modules. `node_modules/@deepseek-ai` holds junction mirrors
// (created by scripts/link-workspace.ps1) so esbuild can resolve both this
// plugin's direct imports and the transitive imports of bundled packages.
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))];

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  // Both peers are supplied by the running DSH Host. In particular, the
  // optional dsh-llm peer is absent during a clean GitHub prepare build.
  // Do not restore it as a devDependency: file/link installs can introduce
  // another copy of a host core package into the profile (see #84).
  external: ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm'],
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
};

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  outfile: 'lib/client.js',
  // react 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react），
  // 不能打进 bundle——否则双 React 实例会崩掉 slots 渲染。
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "meow-memory",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await (await context(hostOptions)).watch();
  await (await context(clientOptions)).watch();
  console.log('[build] watching src/ for changes...');
} else {
  // prompt 文案外置（v0.19.0）：src/prompts/<lang>/*.md → lib/prompts/，运行时
  // readFileSync 读取（prompt-loader.ts 以 import.meta.url 定位 lib/prompts），
  // 不参与 esbuild bundle。语言包 = 一个子目录，新增语言不需要动构建脚本。
  // filter：Delete_ 前缀（改名留痕协议产物）与 *.bak-*（改名/重建备份）都不进发布包。
  // 2026-09-20 实证：src/prompts 下的 *.bak-20260914-femwa-word 会被整目录 cpSync 拷进
  // lib/prompts，而 package.json 的 files 白名单含 lib/prompts/** → 6 个备份文件直接进了 tgz
  // （0.26.0 是 28 个文件，那次 pack 变成 34 个）。
  const keepInPackage = (p) => {
    const name = p.split(/[\\/]/).pop() ?? ''
    return !name.startsWith('Delete_') && !/\.bak(-|$)/.test(name)
  }
  cpSync(new URL('./src/prompts', import.meta.url), new URL('./lib/prompts', import.meta.url), {
    recursive: true,
    filter: keepInPackage,
  });
  await Promise.all([build(hostOptions), build(clientOptions)]);
}
