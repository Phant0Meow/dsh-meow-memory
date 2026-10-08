/**
 * meow-memory — UI 文案中文包。
 *
 * 与 en.ts 是同一批键（keys.ts 为准）：中文保留了外置前的原始硬编码文案，
 * 所以这次瘦身对中文用户是逐字不变的重构。`{name}` 占位符由 t() 填充。
 *
 * 范围：本字典是插件的界面文案（UI/UX）。注入给模型的文案（注入导引、反思/
 * dream prompt、工具描述）是另一层——见 src/prompts/<lang>/ 与 promptLang。
 */
import type { UiKey } from './keys.js'

export const zh: Record<UiKey, string> = {
  // ── 反思 / dream 轮横条 ────────────────────────────────────────────────────
  'fold.title.reflect': '记忆反思',
  'fold.title.dream': '记忆梦境任务',
  'fold.status.running': '{title}进行中…',
  'fold.hint.running': '（插话会拼进本轮）',
  'fold.status.interrupted': '{title}已中断',
  'fold.status.remembered': '{title} · 新增记忆 {n} 条',
  'fold.status.updated': '{title} · 已更新 {n} 条',
  'fold.status.nothing': '{title} · 无需记忆',

  // ── 记忆注入横条 ──────────────────────────────────────────────────────────
  'inject.bar': '已注入记忆',
  'inject.kind.first': '（长期记忆）',
  'inject.kind.hit': '（关键词命中）',
  'inject.expand': '点击展开',
  'inject.collapse': '点击收起',
  'inject.copy': '复制',
  'inject.copied': '已复制',
  'inject.result': '【结果】',

  // ── delegate 打点气泡 ─────────────────────────────────────────────────────
  'notice.reflect.running': '▸ 记忆反思任务进行中……',
  'notice.reflect.done': '▸ 记忆反思任务已完成。',
  'notice.dream.running': '▸ 梦境记忆整理任务进行中……',
  'notice.dream.done': '▸ 梦境记忆整理任务已完成。',
  'notice.dream.interrupted': '▸ 梦境记忆整理已中断，稍后自动重试。',

  // ── 会话菜单 ──────────────────────────────────────────────────────────────
  'part.menu': '记忆参与',
  'part.state.active': '参与中',
  'part.state.readonly': '免打扰',
  'part.state.exited': '已退出',
  'part.state.noConsolidation': '跳过整理',
  'part.state.noWrite': '停止写入',
  'part.state.custom': '自定义',
  'part.panel.read': '回忆（自动注入、读记忆工具）',
  'part.panel.consolidate': '自动整理（反思、梦境）',
  'part.panel.write': '主动写入（写记忆工具）',
  'part.panel.on': '打开',
  'part.panel.off': '关闭',
  'part.panel.presets': '预设',
  'part.preset.full': '参与',
  'part.preset.readonly': '免打扰',
  'part.preset.exit': '退出',

  // ── 设置页 ────────────────────────────────────────────────────────────────
  'settings.title': '喵记忆',
  'settings.summary':
    '跨会话记忆插件的全部设置。改动保存在 DSH 设置里（字段级，「恢复默认」= 回到插件出厂默认，不受 patch 装配基线影响）；生效需要热重载/重启 meow-memory 插件。',
  'settings.loading': '喵记忆配置加载中…',
  'settings.unavailable': '当前连接不支持设置写入（仅本机回环连接可编辑）。',
  'settings.readonly': '当前连接为只读（设置写入仅限本机回环连接）。',
  'settings.saved': '已保存 ✓ 热重载/重启 meow-memory 插件后生效',
  'settings.badge.override': '已覆盖',
  'settings.badge.default': '默认',
  'settings.reset': '恢复默认',
  'settings.saveFailed': '保存失败：{error}',
  'settings.saveNotApplied': '保存未生效：写入被服务器拒绝（可能未通过校验），已恢复显示服务器当前值。',
  'settings.resetFailed': '恢复默认失败：{error}',
  'settings.resetNotApplied': '恢复默认未生效，请重试。',
  'settings.suppress.format': '时段格式应为 "HH:MM-HH:MM"，收到 "{value}"',
  'settings.suppress.atLeastOne': '至少一个时段',
  'settings.group.base': '基础',
  'settings.group.inject': '注入与命中',
  'settings.group.reflect': '反思',
  'settings.group.delegate': '整理任务模型',
  'settings.group.dream': '空闲整理（dream）',
  'settings.group.language': '语言',
  'settings.group.storage': '目录与迁移',
  'settings.field.enabled.label': '总开关',
  'settings.field.enabled.hint': '关闭后注入、反思、记忆工具全部停用',
  'settings.field.projectDir.label': '记忆目录',
  'settings.field.projectDir.hint': '相对工作区的数据目录',
  'settings.field.homeDir.label': '全局数据目录',
  'settings.field.homeDir.hint': '日志等实例级数据的存放位置。切换后自动把旧目录内容迁过去（同盘移动/跨盘复制）；跨盘复制时旧目录保留，确认无误后请手动删除。若多个 dsh 实例共享同一目录，请同步修改其他实例的设置。',
  'settings.field.homeDir.preset.default': '系统用户主目录（默认）',
  'settings.field.homeDir.preset.dshStorage': 'DSH 根目录 Storage',
  'settings.field.homeDir.preset.pluginRoot': '插件本体根目录',
  'settings.field.homeDir.preset.custom': '自定义路径',
  'settings.mirrorReadonly': '当前为非本机连接：dsh 将设置页降为只读镜像，任何修改都不会被保存。请在宿主本机通过 127.0.0.1 访问 dsh 后再修改配置。',
  'settings.field.autoMigrate.label': '自动迁移旧库',
  'settings.field.autoMigrate.hint': '首次打开 v1 库时自动迁移 PROJECT.md',
  'settings.field.hitTopK.label': '每条消息命中条数上限',
  'settings.field.hitTopK.hint': '关键词命中注入的条目上限（fact/lesson/rules/topic）',
  'settings.field.titleMax.label': '导引标题截断长度',
  'settings.field.titleMax.hint': '记忆导引里项目列表的截断长度（字符）',
  'settings.field.reflect.label': '自动反思',
  'settings.field.reflect.hint': '任务结束后自动回顾记忆',
  'settings.field.reflectTurns.label': '反思触发轮数',
  'settings.field.reflectTurns.hint': '单任务内连续工具步达到该值才在结束时触发',
  'settings.field.delegateModel.label': '反思/梦境换模型',
  'settings.field.delegateModel.hint':
    "留空=全程主模型。填写后反思轮与梦境轮自动换用该模型执行，轮次结束自动换回主模型（其余对话不受影响）；'provider/model' 指定路由，'model' 只换模型名",
  'settings.field.delegateModel.placeholder': '如 zai-coding-cn/glm-5.3-flash',
  'settings.field.dreamEnabled.label': '空闲整理开关',
  'settings.field.dream.idleMinutes.label': '空闲分钟数',
  'settings.field.dream.idleMinutes.hint': '窗口空闲满该分钟数即允许 dream',
  'settings.field.dream.suppressWindows.label': '峰时抑制时段',
  'settings.field.dream.suppressWindows.hint': '"HH:MM-HH:MM" 逗号分隔；这些时段内不触发 dream',
  'settings.field.dream.suppressLeadMinutes.label': '峰时前追加抑制（分钟）',
  'settings.field.dream.checkMinutes.label': '检查周期（分钟）',
  'settings.field.dream.timeZone.label': '抑制时段时区',
  'settings.field.dream.timeZone.hint': '峰时窗口按此固定时区计算（与系统时钟无关）',
  'settings.field.dream.rulesReviewDays.label': '准则防 churn 天数',
  'settings.field.dream.rulesReviewDays.hint': 'updated_at 距今超该天数的稳定准则不进 dream 第 1 轮；0=不过滤',
  'settings.field.promptLang.label': 'prompt 与检索语言',
  'settings.field.promptLang.hint':
    "留空=默认 zh（未配置过的会话会收到一次首用引导）；'en'=内置英文语言包。界面语言与它无关——那由 DSH 的语言设置决定。语言必须与你说的话一致，否则关键词命中率下降",
  'settings.field.promptLang.placeholder': 'zh / en',

  // ── 日期时间 ──────────────────────────────────────────────────────────────
  'datetime.ymd': '{m}月{d}日',
  'datetime.ymdFull': '{y}年{m}月{d}日',
}
