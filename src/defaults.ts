/**
 * meow-memory — 出厂默认值的单一来源（纯数据模块，host 与 client 共用）。
 *
 * 两个消费者：
 *  ①host：config 解析兜底 + 设置页 base（预填层）的默认部分（index.ts）；
 *  ②client：设置页「恢复默认」按钮的写入目标 + 「已覆盖」徽章的判定基准（settings-page.ts）。
 *
 * 为什么要共用：设置页原来的「恢复默认」只做"删掉 user 层字段、显示回落 base"，
 * 而 base = 出厂默认 + patch 基线（cordis.patch.yml），于是 patch 里手编的非默认值
 * 会被当成"默认"还给用户——2026-09-10 猫猫实证踩到（3080 patch 写死的
 * zai-coding-cn/glm-5.3-flash 成了「反思/梦境换模型」的恢复默认结果）。
 * 现在语义统一为：**恢复默认 = 回到插件出厂默认**。
 *
 * 约束：本文件不得 import 任何 host 依赖（node/DB/prompts/React）——它会被打进
 * client bundle。
 */

/** rulesReviewDays 的单一默认来源：zod schema / resolveConfig 兜底 / 各运行时函数默认参数
 *  统一引用此处（dream.ts re-export）——改默认值只动这一行。 */
export const DEFAULT_RULES_REVIEW_DAYS = 2

/** 出厂默认值（设置页 base 的默认层）。promptLang 刻意缺席=未设置语义（默认 zh+首用引导）。 */
export const CONFIG_DEFAULTS = {
  enabled: true,
  projectDir: '.dsh-meow',
  hitTopK: 2,
  titleMax: 40,
  reflect: true,
  reflectTurns: 7,
  autoMigrate: true,
  dream: {
    enabled: true,
    idleMinutes: 180,
    suppressWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
    suppressLeadMinutes: 15,
    checkMinutes: 15,
    timeZone: 'Asia/Shanghai',
    rulesReviewDays: DEFAULT_RULES_REVIEW_DAYS,
  },
  delegate: { model: '' },
}

/** 字段形状（settings-page 的 FieldSpec 子集：sub 缺省=顶层标量，给定=dream/delegate 子键）。 */
export interface DefaultFieldSpec {
  key: string
  sub?: string
}

/**
 * 读某字段的出厂默认值：不在默认表里的字段（如 promptLang）返回 undefined
 * ——调用方据此区分"有出厂默认"与"语义=未设置"两条分支。
 */
export function factoryDefaultOf(spec: DefaultFieldSpec): unknown {
  const scope: unknown = spec.sub === undefined
    ? CONFIG_DEFAULTS as unknown
    : (CONFIG_DEFAULTS as unknown as Record<string, unknown>)[spec.sub]
  if (scope === undefined || scope === null || typeof scope !== 'object') return undefined
  return (scope as Record<string, unknown>)[spec.key]
}
