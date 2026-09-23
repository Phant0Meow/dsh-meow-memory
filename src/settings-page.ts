/**
 * meow-memory — 设置页「喵记忆」标签页（0.1.6 / 0.1.7 双版本）。
 *
 * 形态：settings.section 顶级分区（与「通用」「模型」「插件」平级），两版都有
 * 该 slot（0.1.7 官方自己的「通用」「账号」「Agent 预设」页同款注册形状）。
 * 读写层两条腿：
 * - 0.1.6：客户端 settingsScope 服务仍在，bind({namespace}) 读写 user 层
 *   （契约照 meow-cachebilling 验证过的实现；host 半身 installSettingsSection
 *   注册同名命名空间，index.ts applyInner 最前面，base=CONFIG_DEFAULTS 预填）。
 * - 0.1.7：settingsScope 被官方移除，改用设置域基础服务 configForms——
 *   get(entryId) 按命名空间（= entry id = 'meow-memory'）取共享表单，其
 *   getSnapshot/subscribe/set/unset 与组件消费的 scope 形状同构，组件零改动。
 *   Host 侧 describe() 自动把所有带 schema 的活跃插件列为命名空间
 *   （value/base/user 三层），本插件 Config 照常声明，数据源两版同源。
 *
 * 生效语义（诚实版）：meow-memory 的 config 在 apply 时解析，保存写入 settings.yaml
 * 的 user 层后需热重载/重启插件生效——页面顶栏明示，不做静默假生效。
 * 层级：patch config（cordis.patch.yml）=装配基线；标签页 user 层字段级覆盖；
 * dream/delegate 子对象浅合并（只改一个子字段不丢其余键）。
 */

import * as React from 'react'
import { factoryDefaultOf } from './defaults.js'
import { getUiLocale, onUiLocaleChange, t, UI_KEYS, type UiKey } from './i18n/index.js'

const SETTINGS_NS = 'meow-memory'
const CSS_ID = 'meow-memory-settings-css'

const CSS = `
.meowmm_set_page{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px;max-width:760px;padding:4px 0}
.meowmm_set_title{font-size:16px;font-weight:600;margin:0}
.meowmm_set_subtitle{color:var(--dsw-alias-label-caption);font-size:12px;line-height:1.6;margin:0}
.meowmm_set_card{background:color-mix(in srgb,currentColor 3%,transparent);border:1px solid var(--dsw-alias-border-l3);border-radius:10px;display:flex;flex-direction:column;gap:8px;padding:12px}
.meowmm_set_group{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;margin-top:2px}
.meowmm_set_row{align-items:flex-start;display:flex;gap:10px;justify-content:space-between}
.meowmm_set_rowtext{display:flex;flex-direction:column;gap:2px;min-width:0}
.meowmm_set_label{font-size:13px;font-weight:500}
.meowmm_set_hint{color:var(--dsw-alias-label-caption);font-size:12px;line-height:1.5}
.meowmm_set_ctrl{flex:none;padding-top:2px}
.meowmm_set_input{background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:inherit;font-size:13px;padding:4px 8px;width:190px}
.meowmm_set_input_err{border-color:#f43f5e}
.meowmm_set_input_time{width:230px;font-family:ui-monospace,monospace}
.meowmm_set_check{cursor:pointer}
.meowmm_set_badge{border-radius:999px;font-size:11px;line-height:16px;padding:0 8px;flex:none}
.meowmm_set_badge_override{background:color-mix(in srgb,#f59e0b 18%,transparent);color:#f59e0b}
.meowmm_set_badge_prefill{background:color-mix(in srgb,#60a5fa 18%,transparent);color:#60a5fa}
.meowmm_set_reset{background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:2px 8px}
.meowmm_set_reset:hover{border-color:var(--dsw-alias-border-l2);color:inherit}
.meowmm_set_err{color:#f43f5e;font-size:12px;line-height:1.5;margin:0}
.meowmm_set_saved{color:#34d399;font-size:12px}
.meowmm_set_muted{color:var(--dsw-alias-label-caption);font-size:12px}
`

const el = React.createElement

/**
 * 字段元数据：sub 缺省=顶层标量；sub 给定=dream/delegate 子键。
 * label/hint/placeholder 存的是 i18n 键（不是文案本身）：渲染时才查表，语言切换
 * 自动跟随（设置页订阅 onUiLocaleChange 重渲染）。加语言只动字典，不动这张表。
 */
interface FieldSpec {
  key: string
  sub?: string
  label: UiKey
  type: 'bool' | 'num' | 'str'
  hint?: UiKey
  placeholder?: string
}

interface GroupSpec {
  title: UiKey
  fields: FieldSpec[]
}

const FIELDS: GroupSpec[] = [
  {
    title: 'settings.group.base',
    fields: [
      { key: 'enabled', label: 'settings.field.enabled.label', type: 'bool', hint: 'settings.field.enabled.hint' },
      { key: 'projectDir', label: 'settings.field.projectDir.label', type: 'str', hint: 'settings.field.projectDir.hint', placeholder: '.dsh-meow' },
      { key: 'autoMigrate', label: 'settings.field.autoMigrate.label', type: 'bool', hint: 'settings.field.autoMigrate.hint' },
    ],
  },
  {
    title: 'settings.group.inject',
    fields: [
      { key: 'hitTopK', label: 'settings.field.hitTopK.label', type: 'num', hint: 'settings.field.hitTopK.hint' },
      { key: 'titleMax', label: 'settings.field.titleMax.label', type: 'num', hint: 'settings.field.titleMax.hint' },
    ],
  },
  {
    title: 'settings.group.reflect',
    fields: [
      { key: 'reflect', label: 'settings.field.reflect.label', type: 'bool', hint: 'settings.field.reflect.hint' },
      { key: 'reflectTurns', label: 'settings.field.reflectTurns.label', type: 'num', hint: 'settings.field.reflectTurns.hint' },
    ],
  },
  {
    title: 'settings.group.delegate',
    fields: [
      { key: 'model', sub: 'delegate', label: 'settings.field.delegateModel.label', type: 'str', hint: 'settings.field.delegateModel.hint', placeholder: 'settings.field.delegateModel.placeholder' },
    ],
  },
  {
    title: 'settings.group.dream',
    fields: [
      { key: 'enabled', sub: 'dream', label: 'settings.field.dreamEnabled.label', type: 'bool' },
      { key: 'idleMinutes', sub: 'dream', label: 'settings.field.dream.idleMinutes.label', type: 'num', hint: 'settings.field.dream.idleMinutes.hint' },
      { key: 'suppressWindows', sub: 'dream', label: 'settings.field.dream.suppressWindows.label', type: 'str', hint: 'settings.field.dream.suppressWindows.hint', placeholder: '09:00-12:00, 14:00-18:00' },
      { key: 'suppressLeadMinutes', sub: 'dream', label: 'settings.field.dream.suppressLeadMinutes.label', type: 'num' },
      { key: 'checkMinutes', sub: 'dream', label: 'settings.field.dream.checkMinutes.label', type: 'num' },
      { key: 'timeZone', sub: 'dream', label: 'settings.field.dream.timeZone.label', type: 'str', hint: 'settings.field.dream.timeZone.hint' },
      { key: 'rulesReviewDays', sub: 'dream', label: 'settings.field.dream.rulesReviewDays.label', type: 'num', hint: 'settings.field.dream.rulesReviewDays.hint' },
    ],
  },
  {
    title: 'settings.group.language',
    fields: [
      { key: 'promptLang', label: 'settings.field.promptLang.label', type: 'str', hint: 'settings.field.promptLang.hint', placeholder: 'settings.field.promptLang.placeholder' },
    ],
  },
]

/** 占位符既可为字面量（'.dsh-meow'）也可为 i18n 键：是已知键则翻译，否则原样。 */
function placeholderOf(spec: FieldSpec): string | undefined {
  if (spec.placeholder === undefined) return undefined
  return (UI_KEYS as readonly string[]).includes(spec.placeholder)
    ? t(spec.placeholder as UiKey)
    : spec.placeholder
}

const SUPPRESS_RE = /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/

/** 峰时文本 → 结构化数组（解析失败返回错误文案，文案经 i18n 层）。 */
export function parseSuppressWindows(text: string): { value?: Array<{ start: string; end: string }>; error?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { value: [] }
  const out: Array<{ start: string; end: string }> = []
  for (const part of trimmed.split(/[,，]/)) {
    const seg = part.trim()
    if (!seg) continue
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(seg)
    if (!m) return { error: t('settings.suppress.format', { value: seg }) }
    out.push({ start: m[1], end: m[2] })
  }
  if (out.length === 0) return { error: t('settings.suppress.atLeastOne') }
  return { value: out }
}

/** 结构化数组 → 文本（编辑回显）。 */
export function serializeSuppressWindows(w: Array<{ start: string; end: string }> | undefined): string {
  return (w ?? []).map((x) => `${x.start}-${x.end}`).join(', ')
}

/** 读某字段的当前合成值（顶层或子键）。 */
function fieldValue(value: Record<string, unknown> | undefined, spec: FieldSpec): unknown {
  if (spec.sub === undefined) return value?.[spec.key]
  const parent = value?.[spec.sub] as Record<string, unknown> | undefined
  return parent?.[spec.key]
}

/** 是否在 user 层（=已覆盖，可恢复预填）。 */
function inUserLayer(user: Record<string, unknown> | undefined, spec: FieldSpec): boolean {
  if (user === undefined) return false
  if (spec.sub === undefined) return spec.key in user
  const parent = user[spec.sub] as Record<string, unknown> | undefined
  return parent !== undefined && spec.key in parent
}

/** 本地草稿键：含 sub 前缀——顶层 enabled 与 dream.enabled、reflect 与 delegate.reflect 同名，裸 key 会串草稿。 */
function draftKey(spec: FieldSpec): string {
  return spec.sub === undefined ? spec.key : `${spec.sub}.${spec.key}`
}

/** JSON 数据结构相等：镜像值是冻结快照的深拷贝，引用必不同，只能按结构比。 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => jsonEqual(entry, b[i]))
  }
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  return ka.length === kb.length
    && ka.every((k) => k in (b as Record<string, unknown>) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

// ── 页面 ────────────────────────────────────────────────────────────────────

/** 订阅界面语言：语言一变就用新字典重渲染本页（页面文案全部在渲染时查表）。 */
function useUiLocale(): string {
  const subscribe = React.useCallback((cb: () => void) => onUiLocaleChange(() => cb()), [])
  return React.useSyncExternalStore(subscribe, getUiLocale, getUiLocale)
}

/** 设置页主体（导出供测试渲染：createElement 树可直接断言文案）。 */
export function MemorySettingsSection(props: { scope: any }): any {
  const scope = props.scope
  useUiLocale()
  const subscribe = React.useCallback((cb: () => void) => scope.subscribe(cb), [scope])
  const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
  const snap: {
    status: string
    value: Record<string, unknown> | undefined
    base: Record<string, unknown> | undefined
    user: Record<string, unknown> | undefined
    writable: boolean
    mode: string
  } = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const [savedAt, setSavedAt] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const [suppressText, setSuppressText] = React.useState<string | null>(null) // null=非编辑态
  // 本地草稿（键=spec.key）：受控输入必须先写本地态再异步落库——直接把 mirror 值绑
  // value/checked 而保存走异步 RPC，会在往返延迟里被 React 回滚输入（"只显示改不了"
  // 的根因 2026-09-02）。成功清草稿回落 mirror 值；失败保留草稿+错误提示。
  const [drafts, setDrafts] = React.useState<Record<string, string | boolean>>({})

  const flashSaved = (): void => {
    setSavedAt(Date.now())
    window.setTimeout(() => setSavedAt((t) => (t === 0 ? 0 : t)), 4000)
  }

  const clearDraft = (spec: FieldSpec): void => {
    const key = draftKey(spec)
    setDrafts((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  /** 写一个字段。scope.set 的 path 是单层键名（client 实现写死 path:[field]），所以：
   *  顶层=直接 set 该键；子字段=基于「user 层父对象」合成 patch 后整体 set 父键——
   *  不基于合成值合成（那会把 base 预填值整个搬进 user 层，徽章全变"已覆盖"），
   *  也不取 mergedValue[key]（那取的是顶层同名键/undefined，正是 2026-09-03 弹回 bug 的根因）。
   *  另：scope.set 永不 reject——校验被拒时 client 静默 recover 重载镜像，
   *  所以成功与否只能回读 user 层判定，不能看返回值。
   *  @returns 是否写入成功（调用方据此清/留本地草稿）。 */
  const apply = async (spec: FieldSpec, newValue: unknown): Promise<boolean> => {
    setError(null)
    try {
      if (spec.sub === undefined) {
        await scope.set(spec.key, newValue)
      } else {
        // 读取用 getSnapshot()（镜像 acceptView 同步生效）而非渲染闭包里的 snap——
        // 连续改同一子对象的两个字段时，闭包快照可能滞后导致第二次 patch 丢掉第一次的写入。
        const user = scope.getSnapshot().user as Record<string, unknown> | undefined
        const parent = { ...((user?.[spec.sub] as Record<string, unknown>) ?? {}) }
        parent[spec.key] = newValue
        await scope.set(spec.sub, parent)
      }
    } catch (e) {
      setError(t('settings.saveFailed', { error: e instanceof Error ? e.message : String(e) }))
      return false
    }
    const landed = (): boolean => {
      const v = scope.getSnapshot().user as Record<string, unknown> | undefined
      const cur = spec.sub === undefined
        ? v?.[spec.key]
        : (v?.[spec.sub] as Record<string, unknown> | undefined)?.[spec.key]
      return jsonEqual(cur, newValue)
    }
    if (landed()) {
      flashSaved()
      return true
    }
    // 写入被后续写排队 supersede 时镜像尚未 publish，给一点追赶时间再复查。
    await new Promise((resolve) => window.setTimeout(resolve, 300))
    if (landed()) {
      flashSaved()
      return true
    }
    // 失败：清草稿真正回落到服务器值（镜像已被 client recover 重载），
    // 与错误文案「已恢复显示服务器当前值」保持一致。
    clearDraft(spec)
    setError(t('settings.saveNotApplied'))
    return false
  }

  /**
   * 「恢复默认」= 回到插件出厂默认（defaults.ts 的 CONFIG_DEFAULTS）。
   *
   * 不能只做"删掉 user 层字段、显示回落 base"：base = 出厂默认 + patch 基线
   * （cordis.patch.yml），patch 里手编的非默认值会被当成"默认"还给用户——
   * 2026-09-10 猫猫实证踩到：patch 写死的 zai-coding-cn/glm-5.3-flash 成了
   * 「反思/梦境换模型」的恢复默认结果，而他期望这里为空（=主模型）。
   * 所以有出厂默认的字段直接写入出厂默认值；出厂默认缺席的字段
   * （promptLang，语义=未设置）才沿用删键回落 base。
   */
  const reset = async (spec: FieldSpec): Promise<void> => {
    setError(null)
    const def = factoryDefaultOf(spec)
    try {
      if (def === undefined) {
        if (spec.sub === undefined) {
          await scope.unset(spec.key)
        } else {
          // scope.unset 同样只认单层键：unset 父键会连坐整个子对象。
          // 「恢复未设置」= set 回去掉该字段的 user 层父对象；父对象空了才 unset 父键。
          const user = scope.getSnapshot().user as Record<string, unknown> | undefined
          const parent = { ...((user?.[spec.sub] as Record<string, unknown>) ?? {}) }
          delete parent[spec.key]
          if (Object.keys(parent).length === 0) await scope.unset(spec.sub)
          else await scope.set(spec.sub, parent)
        }
      } else {
        // 深拷贝一份：suppressWindows 是数组，别把默认常量本身写进设置镜像。
        const value = JSON.parse(JSON.stringify(def))
        if (spec.sub === undefined) {
          await scope.set(spec.key, value)
        } else {
          const user = scope.getSnapshot().user as Record<string, unknown> | undefined
          const parent = { ...((user?.[spec.sub] as Record<string, unknown>) ?? {}) }
          parent[spec.key] = value
          await scope.set(spec.sub, parent)
        }
      }
      const landed = (): boolean => {
        const user = scope.getSnapshot().user as Record<string, unknown> | undefined
        if (def === undefined) {
          const cur = spec.sub === undefined
            ? user?.[spec.key]
            : (user?.[spec.sub] as Record<string, unknown> | undefined)?.[spec.key]
          return cur === undefined
        }
        return jsonEqual(fieldValue(user, spec), def)
      }
      if (!landed()) await new Promise((resolve) => window.setTimeout(resolve, 300))
      if (landed()) {
        flashSaved()
      } else {
        setError(t('settings.resetNotApplied'))
      }
    } catch (e) {
      setError(t('settings.resetFailed', { error: e instanceof Error ? e.message : String(e) }))
    }
  }

  if (snap.status === 'loading') {
    return el('div', { className: 'meowmm_set_page' }, el('span', { className: 'meowmm_set_muted' }, t('settings.loading')))
  }
  if (snap.status === 'unavailable') {
    return el('div', { className: 'meowmm_set_page' }, el('span', { className: 'meowmm_set_muted' }, t('settings.unavailable')))
  }

  const renderField = (spec: FieldSpec): any => {
    const raw = fieldValue(snap.value, spec)
    // 「已覆盖」判定：有出厂默认的字段看"当前生效值 ≠ 出厂默认"（patch 基线的非默认值
    // 同样算覆盖，与 reset 写入出厂默认的语义对齐）；无出厂默认的字段（promptLang，
    // 语义=未设置）沿用"user 层有该键即已覆盖"。
    const def = factoryDefaultOf(spec)
    const overridden = def === undefined ? inUserLayer(snap.user, spec) : !jsonEqual(raw, def)
    const isSuppress = spec.sub === 'dream' && spec.key === 'suppressWindows'
    const editingSuppress = isSuppress && suppressText !== null
    const mirrorText = typeof raw === 'string' ? raw : (spec.type === 'num' && typeof raw === 'number' ? String(raw) : '')
    const draft = drafts[draftKey(spec)]
    let control: any = null
    if (spec.type === 'bool') {
      // checkbox：本地草稿立即反映点击，落库成功后清草稿（mirror 已含新值，无视觉跳变）；
      // 失败由 apply 清草稿回落 + 错误提示（视觉=点了没反应，红字解释）。
      const checked = typeof draft === 'boolean' ? draft : raw === true
      control = el('input', {
        className: 'meowmm_set_check',
        type: 'checkbox',
        checked,
        disabled: !snap.writable,
        onChange: (e: any) => {
          const next = e.target.checked
          setDrafts((prev) => ({ ...prev, [draftKey(spec)]: next }))
          void apply(spec, next).then((ok) => {
            if (ok) clearDraft(spec)
          })
        },
      })
    } else if (spec.type === 'num') {
      // number：输入写本地草稿（允许中间态），blur 校验+保存；非法/未变则清草稿回退。
      const text = typeof draft === 'string' ? draft : mirrorText
      control = el('input', {
        className: 'meowmm_set_input',
        type: 'number',
        value: text,
        disabled: !snap.writable,
        onChange: (e: any) => setDrafts((prev) => ({ ...prev, [draftKey(spec)]: e.target.value })),
        onBlur: (e: any) => {
          const v = e.target.value
          const num = Number(v)
          if (v.trim() === '' || !Number.isFinite(num) || num === raw) {
            clearDraft(spec)
            return
          }
          void apply(spec, num).then((ok) => {
            if (ok) clearDraft(spec)
          })
        },
      })
    } else if (isSuppress) {
      const text = editingSuppress ? suppressText! : serializeSuppressWindows(raw as Array<{ start: string; end: string }> | undefined)
      const parsed = parseSuppressWindows(text)
      control = el('input', {
        className: 'meowmm_set_input meowmm_set_input_time' + (editingSuppress && parsed.error ? ' meowmm_set_input_err' : ''),
        value: text,
        disabled: !snap.writable,
        placeholder: "09:00-12:00, 14:00-18:00",
        onChange: (e: any) => setSuppressText(e.target.value),
        onBlur: () => {
          if (!editingSuppress) return
          const res = parseSuppressWindows(suppressText!)
          setSuppressText(null)
          if (res.error !== undefined || res.value === undefined) return
          void apply(spec, res.value)
        },
      })
    } else {
      // text：输入写本地草稿，blur 时与 mirror 值比对（变了才落库）。
      const text = typeof draft === 'string' ? draft : mirrorText
      control = el('input', {
        className: 'meowmm_set_input',
        type: 'text',
        value: text,
        placeholder: placeholderOf(spec),
        disabled: !snap.writable,
        onChange: (e: any) => setDrafts((prev) => ({ ...prev, [draftKey(spec)]: e.target.value })),
        onBlur: (e: any) => {
          const next = e.target.value
          if (next === mirrorText) {
            clearDraft(spec)
            return
          }
          void apply(spec, next).then((ok) => {
            if (ok) clearDraft(spec)
          })
        },
      })
    }
    return el(
      'div',
      { key: spec.key, className: 'meowmm_set_row' },
      el(
        'div',
        { className: 'meowmm_set_rowtext' },
        el('span', { className: 'meowmm_set_label' }, t(spec.label)),
        spec.hint !== undefined ? el('span', { className: 'meowmm_set_hint' }, t(spec.hint)) : null,
        editingSuppress && parseSuppressWindows(suppressText!).error !== undefined
          ? el('span', { className: 'meowmm_set_err' }, parseSuppressWindows(suppressText!).error)
          : null,
      ),
      el(
        'div',
        { className: 'meowmm_set_ctrl', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        control,
        el('span', { className: `meowmm_set_badge ${overridden ? 'meowmm_set_badge_override' : 'meowmm_set_badge_prefill'}` }, t(overridden ? 'settings.badge.override' : 'settings.badge.default')),
        overridden && snap.writable ? el('button', { className: 'meowmm_set_reset', onClick: () => { clearDraft(spec); setSuppressText(null); void reset(spec) } }, t('settings.reset')) : null,
      ),
    )
  }

  return el(
    'div',
    { className: 'meowmm_set_page' },
    el('h2', { className: 'meowmm_set_title' }, t('settings.title')),
    el('p', { className: 'meowmm_set_subtitle' }, t('settings.summary')),
    !snap.writable ? el('span', { className: 'meowmm_set_muted' }, t('settings.readonly')) : null,
    savedAt > 0 ? el('span', { className: 'meowmm_set_saved' }, t('settings.saved')) : null,
    error !== null ? el('div', { className: 'meowmm_set_err' }, error) : null,
    ...FIELDS.map((group) =>
      el(
        'div',
        { key: group.title, className: 'meowmm_set_card' },
        el('div', { className: 'meowmm_set_group' }, t(group.title)),
        ...group.fields.map(renderField),
      ),
    ),
  )
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

/** 可选服务软取：cordis 对未声明服务的属性访问直接抛 rejectGuard（可选链防不住），
 *  ctx.get 不抛（缺服务返回 undefined）；无 ctx.get 的环境（含测试 mock）退回
 *  属性读取并用 try/catch 兜住。 */
function softService(ctx: any, name: string): any {
  if (typeof ctx?.get === 'function') return ctx.get(name)
  try { return ctx?.[name] } catch { return undefined }
}

/** 注入设置页 CSS（幂等：同名 data-plugin-css 只挂一份）。 */
function injectSettingsCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'meow-memory-settings'
  tag.dataset.pluginCss = CSS_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** 轮询参数（测试可注入短周期；生产默认 400ms × 75 ≈ 30s 后放弃并留日志）。 */
export interface SettingsPageMountOptions {
  pollMs?: number
  maxPollAttempts?: number
}

/**
 * 挂设置页（双版本两条腿，settings.section 注册形状两版共用）。
 *
 * - 0.1.6 腿：settingsScope 服务存在 → bind({namespace}) 得 scope（原链路不变）。
 * - 0.1.7 腿：settingsScope 缺席 → configForms.get(entryId) 取共享表单直接当
 *   scope（接口同构：getSnapshot 的 status/value/base/user/writable/mode、
 *   subscribe、单层键 set/unset；被拒写入静默 recover 重载镜像——成功与否照旧
 *   回读 user 层判定）。共享表单由 configForms 提供方持有并随其卸载，这里**不
 *   dispose**：dispose 后 forms 表仍缓存该实例，热重载再 get 会拿到死表单。
 *
 * 时序说明：configForms 不进 inject 清单（0.1.6 没有该服务，写进清单会让整个
 * 插件 pending），而客户端组合顺序不保证提供方先起——短轮询等它就绪再挂页；
 * 等不到（异常宿主）只留一行日志，不影响插件其余功能。
 */
export function applySettingsPage(ctx: any, opts?: SettingsPageMountOptions): () => void {
  const pollMs = opts?.pollMs ?? 400
  const maxPollAttempts = opts?.maxPollAttempts ?? 75

  // 顶级分区（与「通用」「模型」「插件」平级）：list slot 契约 = id + order + label。
  // label 是「注册者本地化」的文案：外壳不订阅 locale 状态，注册者要在语言切换时
  // 用新文案重注册（官方契约原话），所以这里保存注册 disposer，语言一变就重注册。
  const mountWithScope = (scope: any): () => void => {
    injectSettingsCss()
    let disposeEntry: (() => void) | null = null
    const registerSection = (): void => {
      try {
        disposeEntry?.()
      } catch {
        /* 旧条目已在卸载：继续注册新条目 */
      }
      disposeEntry = ctx.slots.register(
        {
          name: 'settings.section',
          id: SETTINGS_NS,
          order: 35,
          label: () => t('settings.title'),
          inject: (): unknown => ({ scope }),
        },
        MemorySettingsSection,
      )
    }
    const disposeInjection = ctx.slots.inject('settings.section', registerSection)
    const unsubscribeLocale = onUiLocaleChange(registerSection)
    return () => {
      unsubscribeLocale()
      try {
        disposeInjection()
      } catch {
        /* 清理失败不阻塞 */
      }
      try {
        disposeEntry?.()
      } catch {
        /* 清理失败不阻塞 */
      }
    }
  }

  // ── 0.1.6 腿：settingsScope 在，原样走旧链路 ──────────────────────────────
  const settingsScope = softService(ctx, 'settingsScope')
  if (settingsScope !== undefined) return mountWithScope(settingsScope.bind({ namespace: SETTINGS_NS }))

  // ── 0.1.7 腿：settingsScope 被移除，等 configForms 提供方就绪 ─────────────
  let mountDisposer: (() => void) | null = null
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let attempts = 0
  const stopPoll = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }
  const attach = (): void => {
    if (mountDisposer !== null) return
    const configForms = softService(ctx, 'configForms')
    if (configForms === undefined || typeof configForms.get !== 'function') return
    mountDisposer = mountWithScope(configForms.get(SETTINGS_NS))
    stopPoll()
  }
  attach()
  if (mountDisposer === null) {
    pollTimer = setInterval(() => {
      attach()
      attempts += 1
      if (mountDisposer === null && attempts >= maxPollAttempts) {
        stopPoll()
        console.info('[meow-memory] configForms 服务未就绪（0.1.7 设置页未注册；插件其余功能不受影响）')
      }
    }, pollMs)
  }
  return () => {
    stopPoll()
    if (mountDisposer !== null) {
      try {
        mountDisposer()
      } catch {
        /* 清理失败不阻塞 */
      }
      mountDisposer = null
    }
  }
}
