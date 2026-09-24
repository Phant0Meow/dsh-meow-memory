/**
 * settings-page 测试：设置页的 i18n 接线（标签与字段文案跟随 DSH 语言设置）。
 *
 * 用 React 桩 + DOM 桩渲染一次真实组件树（createElement 形式，无需 JSX），覆盖：
 * 字段表键完整性、标签随语言重注册、页面文案随语言切换、错误文案本地化。
 * 运行：node tests/settings-page.mjs
 */
import { build } from 'esbuild'
import { rmSync, writeFileSync } from 'node:fs'

// React 桩：组件只用到 createElement / useCallback / useSyncExternalStore /
// useState（渲染一次即可，不需要调度器）。渲染结果是一个普通对象树，直接断言。
const reactStub = `
export function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() }
}
export function useCallback(fn) { return fn }
export function useState(init) { return [init, () => {}] }
export function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() }
export const __stub = true
`

// 单一入口：settings-page 与 i18n 必须在同一 bundle 图里（两个实例的语言状态互不相通）。
const ENTRY = 'tests/_settings-page-entry.ts'
writeFileSync(
  ENTRY,
  [
    "export { applySettingsPage, MemorySettingsSection, parseSuppressWindows, serializeSuppressWindows } from '../src/settings-page.ts'",
    "export { setUiLocaleForTest, getUiLocale, t } from '../src/i18n/index.js'",
  ].join('\n'),
  'utf8',
)

let modUrl
try {
  const { outputFiles } = await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'react-stub',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({ path: 'react-stub', namespace: 'stub' }))
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: reactStub, loader: 'js' }))
        },
      },
    ],
  })
  const code = new TextDecoder().decode(outputFiles[0].contents)
  modUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
} finally {
  rmSync(ENTRY, { force: true })
}
const settings = await import(modUrl)

// ── DOM 桩：CSS 注入与 render 期间的 window 访问 ─────────────────────────────
const head = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (el) => head.push(el) },
}
globalThis.window = { setTimeout: () => 1 }

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name} ${detail}`)
  }
}

/** 收集树里的所有字符串：子节点 + 字符串型 props（placeholder/title 等）。 */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  const props = node.props ?? {}
  const fromProps = Object.entries(props)
    .filter(([key, value]) => key !== 'children' && typeof value === 'string')
    .map(([, value]) => value)
  return [...fromProps, ...texts(props.children), ...texts(node.children ?? [])]
}

/** render 一次当前设置页（scope 桩：writable、有 user 层覆盖值）。 */
function renderPage() {
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: { enabled: true, hitTopK: 5 }, user: { hitTopK: 5 }, base: {}, writable: true, mode: 'user' }),
    set: async () => {},
    unset: async () => {},
  }
  return settings.MemorySettingsSection({ scope })
}

// ── 1. 注册契约：label 是函数，语言切换触发重注册 ────────────────────────────
// slots.inject 在 slot 可用时同步调用回调（真实外壳语义）→ applySettingsPage 里
// 注册一次；随后 i18n 订阅在挂载时立即回调，会再重注册一次（幂等，文案相同）。
console.log('=== 1. settings.section 注册与语言重注册 ===')
const registrations = []
const ctx = {
  settingsScope: { bind: () => ({ subscribe: () => () => {}, getSnapshot: () => ({}), set: async () => {}, unset: async () => {} }) },
  slots: {
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
    inject: (_slot, cb) => {
      cb()
      return () => {}
    },
  },
}
settings.setUiLocaleForTest('zh')
const dispose = settings.applySettingsPage(ctx)
check('注册了一次 settings.section', registrations.length >= 1 && registrations[0].options.name === 'settings.section', String(registrations.length))
check('注册参数 id/order 正确', registrations[0].options.id === 'meow-memory' && registrations[0].options.order === 35)
check('label 是函数（官方契约：注册者本地化）', typeof registrations[0].options.label === 'function')
check('zh 标签', registrations[0].options.label() === '喵记忆', registrations[0].options.label())
check('渲染组件已挂上', typeof registrations[0].component === 'function')
check('CSS 只注入一次', head.length === 1)

// 语言切换 → 重新注册（否则外壳永远显示旧语言）。
const afterMount = registrations.length
settings.setUiLocaleForTest('en')
check('切到 en 后重注册', registrations.length === afterMount + 1, String(registrations.length))
check('en 标签', registrations[registrations.length - 1].options.label() === 'Meow memory', registrations[registrations.length - 1].options.label())
settings.setUiLocaleForTest('pt-br')
check('切到 pt-br 后重注册', registrations.length === afterMount + 2, String(registrations.length))
check('pt-br 标签', registrations[registrations.length - 1].options.label() === 'Meow memory', registrations[registrations.length - 1].options.label())

dispose()
const afterDispose = registrations.length
settings.setUiLocaleForTest('en')
check('dispose 后不再重注册', registrations.length === afterDispose, String(registrations.length))

// ── 2. 页面文案随语言切换 ───────────────────────────────────────────────────
console.log('=== 2. 页面渲染文案 ===')
settings.setUiLocaleForTest('zh')
let page = texts(renderPage())
check('zh 页面标题', page.includes('喵记忆'))
check('zh 分组标题', page.includes('基础') && page.includes('空闲整理（dream）') && page.includes('语言'))
check('zh 字段标签', page.includes('总开关') && page.includes('prompt 与检索语言'))
check('zh 徽章', page.includes('已覆盖') && page.includes('默认'))
check('zh 恢复默认按钮', page.includes('恢复默认'))
check('zh 占位符（字面量原样）', page.includes('.dsh-meow'))
check('zh 占位符（i18n 键翻译）', page.includes('zh / en'))
// 回归防线：promptLang 只选模型文案包，设置页不得宣称内置 pt-br（src/prompts/ 只有 zh + en）。
check('zh 不宣称内置 pt-br 提示包', !page.some((s) => s.includes('内置巴西葡语')))
check('zh 说明界面语言由 DSH 决定', page.some((s) => s.includes('界面语言与它无关')))

settings.setUiLocaleForTest('en')
page = texts(renderPage())
check('en 页面标题', page.includes('Meow memory'))
check('en 分组标题', page.includes('Basics') && page.includes('Idle consolidation (dream)') && page.includes('Language'))
check('en 字段标签', page.includes('Master switch') && page.includes('Prompt and retrieval language'))
check('en 徽章', page.includes('Overridden') && page.includes('Default'))
check('en 恢复默认按钮', page.includes('Restore default'))
check('en 提示不宣称内置 pt-br', !page.some((s) => s.includes('built-in Brazilian Portuguese pack')))
check('en 说明界面语言由 DSH 决定', page.some((s) => s.includes('UI language is unrelated')))

settings.setUiLocaleForTest('pt-br')
page = texts(renderPage())
check('pt-br 页面标题', page.includes('Meow memory'))
check('pt-br 分组标题', page.includes('Básico') && page.includes('Consolidação ociosa (dream)') && page.includes('Idioma'))
check('pt-br 字段标签', page.includes('Chave geral') && page.includes('Idioma dos prompts e da busca'))
check('pt-br 徽章', page.includes('Alterado') && page.includes('Padrão'))
check('pt-br 恢复默认按钮', page.includes('Restaurar padrão'))
check('pt-br 占位符', page.includes('ex.: zai-coding-cn/glm-5.3-flash'))
check('pt-br 提示不宣称内置 pt-br', !page.some((s) => s.includes('pacote português do Brasil embutido')))
check('pt-br 说明界面语言由 DSH 决定', page.some((s) => s.includes('idioma da interface não tem relação')))

// ── 3. 峰时解析错误文案本地化 ───────────────────────────────────────────────
console.log('=== 3. 峰时解析错误文案 ===')
settings.setUiLocaleForTest('zh')
check('zh 格式错误', settings.parseSuppressWindows('abc').error === '时段格式应为 "HH:MM-HH:MM"，收到 "abc"')
check('zh 空段错误', settings.parseSuppressWindows(',').error === '至少一个时段')
settings.setUiLocaleForTest('en')
check('en 格式错误', settings.parseSuppressWindows('abc').error === 'A window must look like "HH:MM-HH:MM"; got "abc"')
check('en 空段错误', settings.parseSuppressWindows(',').error === 'At least one window is required')
settings.setUiLocaleForTest('pt-br')
check('pt-br 格式错误', settings.parseSuppressWindows('abc').error === 'O intervalo deve ter o formato "HH:MM-HH:MM"; recebido "abc"')
check('解析成功路径不变', JSON.stringify(settings.parseSuppressWindows('09:00-12:00, 14:00-18:00').value) === JSON.stringify([{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]))
check('序列化不变', settings.serializeSuppressWindows([{ start: '09:00', end: '12:00' }]) === '09:00-12:00')

// ── 4. 双版本挂载：0.1.6 settingsScope 腿 / 0.1.7 configForms 腿 ────────────
// 0.1.7 移除客户端 settingsScope，改用设置域 configForms：get(entryId) 的共享
// 表单与组件吃的 scope 形状同构（getSnapshot/subscribe/单层键 set/unset）。
// 本节锁死：软取分腿、configForms 就绪前轮询等待、双缺安全降级、dispose 清理。
console.log('=== 4. 双版本挂载（settingsScope / configForms）===')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** slots 服务桩：记录每次 register 的 {options, component}，inject 同步回调（真实外壳语义）。 */
function makeSlots() {
  const registrations = []
  return {
    registrations,
    slots: {
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
      inject: (_slot, cb) => {
        cb()
        return () => {}
      },
    },
  }
}

/** ctx.get 形态的宿主桩（真实宿主两版都有 ctx.get；返回 undefined=服务缺席）。 */
function ctxWithGet(services, slots) {
  return { get: (name) => services[name], slots }
}

/** configForms.get 产出的共享表单桩：0.1.7 ConfigForm 的形状（含 mode/revision）。 */
function makeFormStub() {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: { enabled: true }, base: {}, user: {}, writable: true, revision: 3, mode: 'host' }),
    set: async () => true,
    unset: async () => true,
  }
}

// 4.1 0.1.6 腿（ctx.get 软取路线）：bind 的命名空间结果原样当 scope。
{
  const bound = { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, writable: true, mode: 'user' }), set: async () => {}, unset: async () => {} }
  const bindArgs = []
  const { registrations, slots } = makeSlots()
  const ctx = ctxWithGet({ settingsScope: { bind: (args) => { bindArgs.push(args); return bound } } }, slots)
  const disposeLeg = settings.applySettingsPage(ctx)
  check('0.1.6 腿（ctx.get）注册了设置页', registrations.length >= 1 && registrations[0].options.name === 'settings.section')
  check('0.1.6 腿绑定 meow-memory 命名空间', bindArgs.length >= 1 && bindArgs[0].namespace === 'meow-memory', JSON.stringify(bindArgs))
  check('0.1.6 腿 scope=bind 结果', registrations[registrations.length - 1].options.inject().scope === bound)
  disposeLeg()
}

// 4.2 0.1.7 腿（configForms 就绪）：get(entryId) 表单直接当 scope，组件可渲染。
{
  const form = makeFormStub()
  const getCalls = []
  const { registrations, slots } = makeSlots()
  const ctx = ctxWithGet({ configForms: { get: (id) => { getCalls.push(id); return form } } }, slots)
  const disposeLeg = settings.applySettingsPage(ctx)
  check('0.1.7 腿注册了设置页', registrations.length >= 1 && registrations[registrations.length - 1].options.name === 'settings.section')
  check('0.1.7 腿以命名空间取表单', getCalls.includes('meow-memory'), JSON.stringify(getCalls))
  check('0.1.7 腿 scope=configForms 表单', registrations[registrations.length - 1].options.inject().scope === form)
  const page = texts(settings.MemorySettingsSection({ scope: form }))
  check('0.1.7 形状快照可渲染（标题在场）', page.includes('Meow memory') || page.includes('喵记忆'))
  disposeLeg()
  const afterDispose = registrations.length
  settings.setUiLocaleForTest('zh')
  check('0.1.7 腿 dispose 后不再重注册', registrations.length === afterDispose, String(registrations.length))
}

// 4.3 双缺（异常宿主）：不注册、轮询自行放弃、dispose 安全。
{
  const { registrations, slots } = makeSlots()
  const ctx = ctxWithGet({}, slots)
  const disposeLeg = settings.applySettingsPage(ctx, { pollMs: 5, maxPollAttempts: 2 })
  check('双缺不注册设置页', registrations.length === 0, String(registrations.length))
  await sleep(40)
  check('双缺轮询放弃后仍不注册', registrations.length === 0, String(registrations.length))
  disposeLeg()
}

// 4.4 0.1.7 腿（configForms 迟到）：提供方晚于插件 apply 就绪，轮询等到即挂页。
{
  const form = makeFormStub()
  let calls = 0
  const { registrations, slots } = makeSlots()
  const ctx = ctxWithGet({ get configForms() { calls += 1; return calls > 3 ? { get: () => form } : undefined } }, slots)
  const disposeLeg = settings.applySettingsPage(ctx, { pollMs: 5, maxPollAttempts: 200 })
  check('configForms 缺席期间不注册', registrations.length === 0, String(registrations.length))
  await sleep(60)
  check('configForms 就绪后轮询挂页', registrations.length >= 1 && registrations[registrations.length - 1].options.inject().scope === form, String(registrations.length))
  disposeLeg()
  const afterDispose = registrations.length
  await sleep(20)
  check('0.1.7 腿迟到挂页 dispose 后稳定', registrations.length === afterDispose, String(registrations.length))
}


// ── 5. 全局目录控件（homeDir）：预设 radio + 实际路径显示 + 自定义输入 ──────────
// 收集树里的 radio（type/checked），按渲染序=default/dsh-storage/plugin-root/custom。
function collectRadios(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  const props = node.props ?? {}
  if (props.type === 'radio') out.push(props)
  for (const c of [].concat(props.children ?? [], node.children ?? [])) collectRadios(c, out)
  return out
}
function collectTextInputs(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  const props = node.props ?? {}
  if (props.type === 'text') out.push(props)
  for (const c of [].concat(props.children ?? [], node.children ?? [])) collectTextInputs(c, out)
  return out
}

function renderWithHomeDir(snapshotValue, base) {
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: snapshotValue, user: snapshotValue, base, writable: true, mode: 'user' }),
    set: async () => {},
    unset: async () => {},
  }
  return settings.MemorySettingsSection({ scope })
}

const PRESETS_BASE = {
  homeDirPresets: {
    default: String.raw`C:\Users\meow\.dsh-meow`,
    'dsh-storage': String.raw`C:\dsh\storages\meow-memory`,
    'plugin-root': String.raw`C:\plugins\meow-memory\storage`,
  },
}

console.log('=== 5. 全局目录控件 ===')
settings.setUiLocaleForTest('zh')
{
  // 缺省值：default radio 选中，三个预设显示实际路径
  const tree = renderWithHomeDir({ enabled: true }, PRESETS_BASE)
  const page = texts(tree)
  const radios = collectRadios(tree)
  check('homeDir: 渲染四个 radio', radios.length === 4, String(radios.length))
  check('homeDir: 缺省=default 选中', radios[0] !== undefined && radios[0].checked === true && radios.slice(1).every((r) => !r.checked))
  check('homeDir: 三预设显示实际落点', page.some((s) => s.includes(String.raw`C:\dsh\storages\meow-memory`)) && page.some((s) => s.includes(String.raw`C:\plugins\meow-memory\storage`)))
  check('homeDir: 自定义选项存在', page.includes('自定义路径'))
  check('homeDir: hint 带多实例提醒', page.some((s) => s.includes('多个 dsh 实例')))
  // 布局结构：每个预设的实际路径是独立次行节点（等宽小字类），不是挤在名称行里
  const pathNodes = (function collectPaths(n, out = []) {
    if (n === null || n === undefined || typeof n !== 'object') return out
    const p = n.props ?? {}
    if (p.className === 'meowmm_set_homedir_path') out.push(p)
    for (const c of [].concat(p.children ?? [], n.children ?? [])) collectPaths(c, out)
    return out
  })(tree)
  check('homeDir: 三条路径各自独立次行节点', pathNodes.length === 3, String(pathNodes.length))

  // 预设标记值：对应 radio 选中
  const tree2 = renderWithHomeDir({ enabled: true, homeDir: 'dsh-storage' }, PRESETS_BASE)
  texts(tree2)
  const radios2 = collectRadios(tree2)
  check('homeDir: 预设标记选中对应 radio', radios2[1] !== undefined && radios2[1].checked === true && !radios2[0].checked && !radios2[3].checked)

  // 自定义绝对路径：custom radio 选中 + 输入框回填路径值
  const tree3 = renderWithHomeDir({ enabled: true, homeDir: String.raw`D:\data\meow` }, PRESETS_BASE)
  texts(tree3)
  const radios3 = collectRadios(tree3)
  const textInputs = collectTextInputs(tree3)
  check('homeDir: 自定义值选中 custom radio', radios3[3] !== undefined && radios3[3].checked === true && radios3.slice(0, 3).every((r) => !r.checked))
  check('homeDir: 自定义路径回填输入框', textInputs.some((p) => p.value === String.raw`D:\data\meow`))

  // 只读镜像横幅：mode='memory'（非 loopback 连接）时页面顶部亮牌——写入会被客户端丢弃
  const treeMem = renderWithHomeDir({ enabled: true }, PRESETS_BASE)
  const pageMem = texts({ ...treeMem })
  check('mirror: host 模式无横幅', !pageMem.some((s) => s.includes('只读镜像')))
  function withMode(baseTree, mode) { return null }
  const memScope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', value: { enabled: true }, user: { enabled: true }, base: {}, writable: true, mode: 'memory' }),
    set: async () => {},
    unset: async () => {},
  }
  const pageMem2 = texts(settings.MemorySettingsSection({ scope: memScope }))
  check('mirror: memory 模式亮只读横幅', pageMem2.some((s) => s.includes('只读镜像')))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
