/**
 * meow-memory — 设置页「喵记忆」标签页。
 *
 * 形态：settings.section 顶级分区（与「通用」「模型」「插件」平级），契约照
 * meow-cachebilling 验证过的实现：client 挂 list slot（id+order+label）+
 * settingsScope.bind({namespace}) 读写 user 层；host 半身 installSettingsSection
 * 注册同名命名空间（index.ts applyInner 最前面），base=CONFIG_DEFAULTS 预填。
 *
 * 生效语义（诚实版）：meow-memory 的 config 在 apply 时解析，保存写入 settings.yaml
 * 的 user 层后需热重载/重启插件生效——页面顶栏明示，不做静默假生效。
 * 层级：patch config（cordis.patch.yml）=装配基线；标签页 user 层字段级覆盖；
 * dream/delegate 子对象浅合并（只改一个子字段不丢其余键）。
 */

import * as React from 'react'
import { factoryDefaultOf } from './defaults.js'

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

/** 字段元数据：sub 缺省=顶层标量；sub 给定=dream/delegate 子键。 */
interface FieldSpec {
  key: string
  sub?: string
  label: string
  type: 'bool' | 'num' | 'str'
  hint?: string
  placeholder?: string
}

interface GroupSpec {
  title: string
  fields: FieldSpec[]
}

const FIELDS: GroupSpec[] = [
  {
    title: '基础',
    fields: [
      { key: 'enabled', label: '总开关', type: 'bool', hint: '关闭后注入、反思、记忆工具全部停用' },
      { key: 'projectDir', label: '记忆目录', type: 'str', hint: '相对工作区的数据目录', placeholder: '.dsh-meow' },
      { key: 'autoMigrate', label: '自动迁移旧库', type: 'bool', hint: '首次打开 v1 库时自动迁移 PROJECT.md' },
    ],
  },
  {
    title: '注入与命中',
    fields: [
      { key: 'hitTopK', label: '每条消息命中条数上限', type: 'num', hint: '关键词命中注入的条目上限（fact/lesson/rules/topic）' },
      { key: 'titleMax', label: '导引标题截断长度', type: 'num', hint: '记忆导引里项目列表的截断长度（字符）' },
    ],
  },
  {
    title: '反思',
    fields: [
      { key: 'reflect', label: '自动反思', type: 'bool', hint: '任务结束后自动回顾记忆' },
      { key: 'reflectTurns', label: '反思触发轮数', type: 'num', hint: '单任务内连续工具步达到该值才在结束时触发' },
    ],
  },
  {
    title: '整理任务模型',
    fields: [
      { key: 'model', sub: 'delegate', label: '反思/梦境换模型', type: 'str', hint: "留空=全程主模型。填写后反思轮与梦境轮自动换用该模型执行，轮次结束自动换回主模型（其余对话不受影响）；'provider/model' 指定路由，'model' 只换模型名", placeholder: '如 zai-coding-cn/glm-5.3-flash' },
    ],
  },
  {
    title: '空闲整理（dream）',
    fields: [
      { key: 'enabled', sub: 'dream', label: '空闲整理开关', type: 'bool' },
      { key: 'idleMinutes', sub: 'dream', label: '空闲分钟数', type: 'num', hint: '窗口空闲满该分钟数即允许 dream' },
      { key: 'suppressWindows', sub: 'dream', label: '峰时抑制时段', type: 'str', hint: '"HH:MM-HH:MM" 逗号分隔；这些时段内不触发 dream', placeholder: "09:00-12:00, 14:00-18:00" },
      { key: 'suppressLeadMinutes', sub: 'dream', label: '峰时前追加抑制（分钟）', type: 'num' },
      { key: 'checkMinutes', sub: 'dream', label: '检查周期（分钟）', type: 'num' },
      { key: 'timeZone', sub: 'dream', label: '抑制时段时区', type: 'str', hint: '峰时窗口按此固定时区计算（与系统时钟无关）' },
      { key: 'rulesReviewDays', sub: 'dream', label: '准则防 churn 天数', type: 'num', hint: 'updated_at 距今超该天数的稳定准则不进 dream 第 1 轮；0=不过滤' },
    ],
  },
  {
    title: '语言',
    fields: [
      { key: 'promptLang', label: 'prompt 与检索语言', type: 'str', hint: "留空=默认 zh（未配置过的会话会收到一次首用引导）；'en'=内置英文语言包。语言必须与你说的话一致，否则关键词命中率下降", placeholder: "zh / en" },
    ],
  },
]

const SUPPRESS_RE = /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/

/** 峰时文本 → 结构化数组（解析失败返回错误文案）。 */
export function parseSuppressWindows(text: string): { value?: Array<{ start: string; end: string }>; error?: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { value: [] }
  const out: Array<{ start: string; end: string }> = []
  for (const part of trimmed.split(/[,，]/)) {
    const seg = part.trim()
    if (!seg) continue
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(seg)
    if (!m) return { error: `时段格式应为 "HH:MM-HH:MM"，收到 "${seg}"` }
    out.push({ start: m[1], end: m[2] })
  }
  if (out.length === 0) return { error: '至少一个时段' }
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

function MemorySettingsSection(props: { scope: any }): any {
  const scope = props.scope
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
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
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
    setError('保存未生效：写入被服务器拒绝（可能未通过校验），已恢复显示服务器当前值。')
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
        setError('恢复默认未生效，请重试。')
      }
    } catch (e) {
      setError(`恢复默认失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (snap.status === 'loading') {
    return el('div', { className: 'meowmm_set_page' }, el('span', { className: 'meowmm_set_muted' }, '喵记忆配置加载中…'))
  }
  if (snap.status === 'unavailable') {
    return el('div', { className: 'meowmm_set_page' }, el('span', { className: 'meowmm_set_muted' }, '当前连接不支持设置写入（仅本机回环连接可编辑）。'))
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
        placeholder: spec.placeholder,
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
        el('span', { className: 'meowmm_set_label' }, spec.label),
        spec.hint !== undefined ? el('span', { className: 'meowmm_set_hint' }, spec.hint) : null,
        editingSuppress && parseSuppressWindows(suppressText!).error !== undefined
          ? el('span', { className: 'meowmm_set_err' }, parseSuppressWindows(suppressText!).error)
          : null,
      ),
      el(
        'div',
        { className: 'meowmm_set_ctrl', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        control,
        el('span', { className: `meowmm_set_badge ${overridden ? 'meowmm_set_badge_override' : 'meowmm_set_badge_prefill'}` }, overridden ? '已覆盖' : '默认'),
        overridden && snap.writable ? el('button', { className: 'meowmm_set_reset', onClick: () => { clearDraft(spec); setSuppressText(null); void reset(spec) } }, '恢复默认') : null,
      ),
    )
  }

  return el(
    'div',
    { className: 'meowmm_set_page' },
    el('h2', { className: 'meowmm_set_title' }, '喵记忆'),
    el(
      'p',
      { className: 'meowmm_set_subtitle' },
      '跨会话记忆插件的全部设置。改动保存在 DSH 设置里（字段级，「恢复默认」= 回到插件出厂默认，不受 patch 装配基线影响）；生效需要热重载/重启 meow-memory 插件。',
    ),
    !snap.writable ? el('span', { className: 'meowmm_set_muted' }, '当前连接为只读（设置写入仅限本机回环连接）。') : null,
    savedAt > 0 ? el('span', { className: 'meowmm_set_saved' }, '已保存 ✓ 热重载/重启 meow-memory 插件后生效') : null,
    error !== null ? el('div', { className: 'meowmm_set_err' }, error) : null,
    ...FIELDS.map((group) =>
      el(
        'div',
        { key: group.title, className: 'meowmm_set_card' },
        el('div', { className: 'meowmm_set_group' }, group.title),
        ...group.fields.map(renderField),
      ),
    ),
  )
}

// ── 挂载 ────────────────────────────────────────────────────────────────────

export function applySettingsPage(ctx: any): void {
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'meow-memory-settings'
    tag.dataset.pluginCss = CSS_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS })

  // 顶级分区（与「通用」「模型」「插件」平级）：list slot 契约 = id + order + label。
  // label 直接返回中文（第三方 locale 字典在官方外壳没有席位——cachebilling 实测结论）。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: SETTINGS_NS,
        order: 35,
        label: () => '喵记忆',
        inject: (): unknown => ({ scope }),
      },
      MemorySettingsSection,
    ),
  )
}
