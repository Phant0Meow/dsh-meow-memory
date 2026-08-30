/**
 * meow-memory v2 — 检索层。
 *
 * 分词（类别路由 v0.20.0，语言无关）：CJK（汉字+假名）连续段相邻 bigram + Unicode
 * 字母/数字（\p{L}\p{N}）整词；NFKC 归一化；标点/符号/emoji 丢弃。
 * en 语言包贡献（PR #6）：en 模式下对产出 tokens 追加英语归一化（停用词过滤 +
 * Porter 词干还原，见下方 EN 段）；其他语言维持基线（stemming 扩展点见 prompts/README.md）。
 * 打分：标准 BM25 × 艾宾浩斯近期权重；importance≥3 或超级匹配（≥0.85×本轮
 *       最高原始分）时豁免衰减。
 * 偏离信号：turn 文本向量 vs 各 topic 质心（title+goal+content+keywords 词频
 *       向量）的余弦相似度；top1 相似度过低 → "疑似新话题"提示。topic 数 < 3
 *       （冷启动）不提示。信号只提醒不拍板，归属判定由模型用目标句测试完成。
 */

import { getPromptLang } from './prompt-loader.js'

export interface Doc {
  id: string
  level: string
  title: string | null
  content: string
  keywords: string[]
  importance: number
  created_at: number
  /** 记忆时间戳 = 最后更新时间（艾宾浩斯按它算年龄）。 */
  updated_at: number
}

// CJK 类：汉字（\p{Script=Han} 覆盖基本区+Ext A~I）+ 假名 + 日文词内符号（々 叠字 / ー
// 长音符——script=Common，但必须随 CJK run，"人々/タワー"才能整体成词）
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u
// 字母/数字类：é ü ñ、西里尔、希腊、谚文、全角英数（NFKC 后）……一切语言的字母数字
const WORD = /[\p{L}\p{N}]/u

type CharClass = 'cjk' | 'word' | 'skip'

/** 单字符分类：CJK → bigram 路径；字母/数字 → 整词路径；其余（标点/符号/emoji）→ 丢弃。 */
function classify(cp: string): CharClass {
  if (CJK.test(cp)) return 'cjk'
  if (WORD.test(cp)) return 'word'
  return 'skip'
}

/** 切词（类别路由，v0.20.0，语言无关——promptLang 不再影响分词；唯一例外：en 语言包
 *  贡献的英语归一化（停用词+Porter）在产出后追加，见 normalizeEn）：
 * - CJK 类（汉字+假名）：连续段相邻 bigram——中文稳定零依赖，日文 n-gram 基线；
 *   run<2 单字不成词丢弃防噪音；汉字-假名交界不断 run，"行く/食べる"自然成词；
 * - 字母/数字类（\p{L}\p{N}）：连续段整词 + 小写化（café/привет/한국어/全角英数…）；
 * - 其余（标点/空白/符号/emoji）：跳过——信息量为零，不污染 IDF。
 * 文本先 NFKC 归一化（全角ＢＭ２５→bm25、半角片假名→全角）；Array.from 按 code point
 * 迭代，emoji/Ext B 汉字等 surrogate pair 不切半。其他语言的词形归一化/stemming 仍是
 * 语言包贡献者的扩展点（见 prompts/README.md）；打分本体（BM25/艾宾浩斯/余弦）语言无关。 */
export function tokenize(text: string): string[] {
  // 主语言码（'en-US' → 'en'）：只用于 en 归一化钩子，分词主干仍语言无关
  const lang = getPromptLang().toLowerCase().split(/[-_]/)[0]
  const cps = Array.from(text.normalize('NFKC'))
  const out: string[] = []
  let i = 0
  while (i < cps.length) {
    const cls = classify(cps[i])
    if (cls === 'skip') {
      i++
      continue
    }
    let j = i + 1
    while (j < cps.length && classify(cps[j]) === cls) j++
    const run = cps.slice(i, j)
    if (cls === 'cjk') {
      // 连续 CJK → 相邻 bigram（单字不成词，避免噪音）
      if (run.length >= 2) {
        for (let k = 0; k + 1 < run.length; k++) out.push(run[k] + run[k + 1])
      }
    } else {
      out.push(run.join('').toLowerCase())
    }
    i = j
  }
  return lang === 'en' ? normalizeEn(out) : out
}

// ── 英语归一化（en 分支） ────────────────────────────────────────────────────
//
// 检索命中要求 query 与记忆条目走同一套分词，所以归一化只做在 tokenize 里，
// 写入侧与检索侧天然一致（关键词原文照旧原样存库，只有匹配时才归一）。
//
// 两步，都是英语特有、中文不需要的：
// 1. 停用词过滤：英语功能词（the/of/is…）在每条记忆里都出现，BM25 的 idf 已经压得很低，
//    但命中链路的覆盖率分母（keywordHitScore 的 coverage）会被它们稀释，且撇号切分
//    （"user's" → user + s）会漏出 s/t/ll 这类碎片，一并在此丢弃。
// 2. Porter 词干还原：英语有屈折变化，caches/caching/cached 必须归到同一词干，
//    否则用户 prompt 写复数、记忆条目写单数就永远命中不了（中文无屈折，故 zh 分支不做）。
//    含数字的 token（2024 / v0 / sha256）跳过——词干规则只对纯字母词有意义。

/** 英语停用词（含撇号切分碎片 s/t/d/ll/ve/re/m）。功能词不承载检索意义。 */
const EN_STOPWORDS = new Set<string>([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'cannot', 'could', 'd', 'did', 'do', 'does', 'doing', 'don', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers',
  'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'just', 'll', 'm', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  're', 's', 'same', 'she', 'should', 'so', 'some', 'such', 't', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 've', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
])

/** 停用词丢弃 + 词干还原（纯字母词才还原；数字/混合 token 原样保留）。 */
function normalizeEn(tokens: string[]): string[] {
  const out: string[] = []
  for (const t of tokens) {
    if (EN_STOPWORDS.has(t)) continue
    out.push(/^[a-z]+$/.test(t) ? stemEn(t) : t)
  }
  return out
}

// Porter stemmer（Porter 1980 原始算法，零依赖移植）。词干只用于匹配，不入库、不展示，
// 所以"cach"这类非词形态无所谓——两侧同函数即可命中。
const PORTER_STEP2: Record<string, string> = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize', bli: 'ble',
  alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize', ation: 'ate',
  ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful', ousness: 'ous', aliti: 'al',
  iviti: 'ive', biliti: 'ble', logi: 'log',
}
const PORTER_STEP3: Record<string, string> = {
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '',
}

const CONS = '[^aeiou]'
const VOW = '[aeiouy]'
const CONS_SEQ = `${CONS}[^aeiouy]*`
const VOW_SEQ = `${VOW}[aeiou]*`
const MGR0 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}`)
const MEQ1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}(${VOW_SEQ})?$`)
const MGR1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}${VOW_SEQ}${CONS_SEQ}`)
const HAS_VOWEL = new RegExp(`^(${CONS_SEQ})?${VOW}`)

/** Porter 词干还原（小写纯字母词；长度 ≤2 原样返回）。 */
export function stemEn(word: string): string {
  let w = word
  if (w.length <= 2) return w

  // Step 1a — 复数
  if (/(ss|i)es$/.test(w)) w = w.replace(/(ss|i)es$/, '$1')
  else if (/([^s])s$/.test(w)) w = w.replace(/([^s])s$/, '$1')

  // Step 1b — 过去式/进行时
  if (/eed$/.test(w)) {
    const stem = w.slice(0, -3)
    if (MGR0.test(stem)) w = w.slice(0, -1)
  } else if (/(ed|ing)$/.test(w)) {
    const stem = w.replace(/(ed|ing)$/, '')
    if (HAS_VOWEL.test(stem)) {
      w = stem
      if (/(at|bl|iz)$/.test(w)) w += 'e'
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1) // 双写辅音还原
      else if (new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(w)) w += 'e' // *o 条件
    }
  }

  // Step 1c — y → i
  if (/y$/.test(w)) {
    const stem = w.slice(0, -1)
    if (HAS_VOWEL.test(stem)) w = `${stem}i`
  }

  // Step 2 / 3 — 派生后缀归并
  for (const [suffix, repl] of Object.entries(PORTER_STEP2)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length)
      if (MGR0.test(stem)) w = stem + repl
      break
    }
  }
  for (const [suffix, repl] of Object.entries(PORTER_STEP3)) {
    if (w.endsWith(suffix)) {
      const stem = w.slice(0, -suffix.length)
      if (MGR0.test(stem)) w = stem + repl
      break
    }
  }

  // Step 4 — 剥离剩余派生后缀（m>1）
  const step4 = /(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/
  if (step4.test(w)) {
    const stem = w.replace(step4, '')
    if (MGR1.test(stem)) w = stem
  } else if (/(s|t)(ion)$/.test(w)) {
    const stem = w.replace(/(s|t)(ion)$/, '$1')
    if (MGR1.test(stem)) w = stem
  }

  // Step 5 — 收尾 e / 双写 l
  if (/e$/.test(w)) {
    const stem = w.slice(0, -1)
    if (MGR1.test(stem) || (MEQ1.test(stem) && !new RegExp(`^${CONS_SEQ}${VOW}[^aeiouwxy]$`).test(stem))) w = stem
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1)

  return w
}

function docText(d: Doc): string {
  return [d.title ?? '', d.content, ...d.keywords].join(' ')
}

/** 艾宾浩斯复习间隔分桶（年龄天数 → 权重）。 */
export function recencyWeight(ageMs: number): number {
  const days = ageMs / 86_400_000
  if (days < 1) return 1.0
  if (days < 2) return 0.9
  if (days < 4) return 0.8
  if (days < 7) return 0.65
  if (days < 15) return 0.5
  if (days < 30) return 0.35
  if (days < 60) return 0.25
  if (days < 180) return 0.15
  return 0.08
}

export interface RankedHit {
  id: string
  level: string
  title: string | null
  content: string
  importance: number
  updated_at: number
  score: number
}

export interface SearchOptions {
  k?: number
  /** 相对当前时间；null 表示不衰减（测试/手动检索可关）。 */
  now?: number | null
}

/**
 * BM25 × 近期权重检索。docs 中 importance≥3 或原始分 ≥0.85×本轮最高分的
 * 条目豁免衰减。返回按最终分降序。
 */
export function search(query: string, docs: Doc[], opts: SearchOptions = {}): RankedHit[] {
  const k = opts.k ?? 5
  const now = opts.now === undefined ? Date.now() : opts.now
  const q = tokenize(query)
  if (q.length === 0 || docs.length === 0) return []

  const n = docs.length
  const docToks = docs.map((d) => tokenize(docText(d)))
  const avgdl = docToks.reduce((s, t) => s + t.length, 0) / n || 1

  const df = new Map<string, number>()
  const tf: Array<Map<string, number>> = []
  for (const toks of docToks) {
    const m = new Map<string, number>()
    const seen = new Set<string>()
    for (const t of toks) {
      m.set(t, (m.get(t) ?? 0) + 1)
      if (!seen.has(t)) {
        seen.add(t)
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    }
    tf.push(m)
  }

  const k1 = 1.5
  const b = 0.75
  const raw: number[] = docs.map((_, di) => {
    let s = 0
    const len = docToks[di].length
    for (const term of q) {
      const f = tf[di].get(term)
      if (!f) continue
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5))
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgdl)))
    }
    return s
  })

  const maxRaw = Math.max(...raw)
  const hits: RankedHit[] = []
  for (let di = 0; di < docs.length; di++) {
    if (raw[di] <= 0) continue
    let w = 1
    if (now !== null && docs[di].importance < 3 && !(raw[di] >= 0.85 * maxRaw)) {
      w = recencyWeight(now - docs[di].updated_at) // 艾宾浩斯按记忆时间戳（最后更新时间）
    }
    hits.push({
      id: docs[di].id,
      level: docs[di].level,
      title: docs[di].title,
      content: docs[di].content,
      importance: docs[di].importance,
      updated_at: docs[di].updated_at,
      score: raw[di] * w,
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}

/**
 * 关键词命中打分（每消息命中链路专用）：
 *   score = 交集分 × 覆盖率 × 艾宾浩斯(updated_at) × importance 权重 × title 加成
 * - 匹配面 = 调用方准备的 docs.content（记忆 keywords 串，或旧条目回退的内容片段）+ title；
 *   query = 用户消息全文 bigram；
 * - 交集分 = Σ(命中的词条 × query 词频 × idf)——稀有词命中含金量高；
 * - 覆盖率 = 命中词条数 / 该记忆匹配面词条总数——防"一个词碰瓷上榜"；
 * - 艾宾浩斯按记忆时间戳（updated_at）衰减，importance≥3 或超级匹配（≥0.85×本轮最高交集分）豁免；
 * - importance 权重 = 1 + (importance-1)×0.25（3 星 ×1.5）；title 被命中 ×1.2。
 */
export function keywordHitScore(query: string, docs: Doc[], opts: SearchOptions = {}): RankedHit[] {
  const k = opts.k ?? 2
  const now = opts.now === undefined ? Date.now() : opts.now
  const q = tokenize(query)
  if (q.length === 0 || docs.length === 0) return []
  const qTf = new Map<string, number>()
  for (const t of q) qTf.set(t, (qTf.get(t) ?? 0) + 1)

  const n = docs.length
  const docToks = docs.map((d) => tokenize([d.content, d.title ?? ''].join(' ')))
  const df = new Map<string, number>()
  const tf: Array<Map<string, number>> = []
  for (const toks of docToks) {
    const m = new Map<string, number>()
    const seen = new Set<string>()
    for (const t of toks) {
      m.set(t, (m.get(t) ?? 0) + 1)
      if (!seen.has(t)) {
        seen.add(t)
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    }
    tf.push(m)
  }
  const idf = (t: string): number =>
    Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))

  const raw: number[] = docs.map((_, di) => {
    let s = 0
    for (const [t, f] of qTf) {
      if (tf[di].has(t)) s += idf(t) * f
    }
    return s
  })
  const maxRaw = Math.max(...raw)
  const out: RankedHit[] = []
  for (let di = 0; di < docs.length; di++) {
    if (raw[di] <= 0) continue
    const len = docToks[di].length
    let overlap = 0
    for (const t of qTf.keys()) if (tf[di].has(t)) overlap++
    const coverage = len > 0 ? overlap / len : 0
    let w = 1
    if (now !== null && docs[di].importance < 3 && !(raw[di] >= 0.85 * maxRaw)) {
      w = recencyWeight(now - docs[di].updated_at)
    }
    const impW = 1 + (docs[di].importance - 1) * 0.25
    const titleHit = tokenize(docs[di].title ?? '').some((t) => qTf.has(t))
    out.push({
      id: docs[di].id,
      level: docs[di].level,
      title: docs[di].title,
      content: docs[di].content,
      importance: docs[di].importance,
      updated_at: docs[di].updated_at,
      score: raw[di] * coverage * w * impW * (titleHit ? 1.2 : 1),
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, k)
}

// ── topic 偏离信号 & find_similar ─────────────────────────────────────────

function tfVector(toks: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const v of a.values()) na += v * v
  for (const v of b.values()) nb += v * v
  if (na === 0 || nb === 0) return 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = big.get(k)
    if (w) dot += v * w
  }
  return dot / Math.sqrt(na * nb)
}

export interface SimilarHit {
  id: string
  level: string
  title: string | null
  content: string
  similarity: number
}

/**
 * find_similar：按条目 id 找内容相似的条目（bigram 词频向量余弦）。
 * 实时计算：全库 ~百条、每条几百字，<5ms——数据量小，不做预处理；
 * 等条目上千后再考虑"写入时增量更新向量缓存"（也是写入同步，不做定时任务，
 * 定时任务会有数据一致性窗口）。
 */
export function findSimilar(target: string, docs: Doc[], k = 5): SimilarHit[] {
  const targetVec = tfVector(tokenize(target))
  if (targetVec.size === 0) return []
  const scored: SimilarHit[] = []
  for (const d of docs) {
    const v = tfVector(tokenize(docText(d)))
    const s = cosine(targetVec, v)
    if (s <= 0) continue
    scored.push({
      id: d.id,
      level: d.level,
      title: d.title,
      content: d.content,
      similarity: Math.round(s * 1000) / 1000,
    })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, k)
}

export interface DriftSignal {
  /** 最相关 topic（若有）。 */
  topTopic: Doc | null
  /** 与 topTopic 的余弦相似度。 */
  topScore: number
  /** 是否提示"疑似新话题"。 */
  suggestsNew: boolean
  /** 冷启动（topic 太少）时信号不可靠。 */
  coldStart: boolean
}

const DRIFT_THRESHOLD = 0.3

/** turn 文本 vs 各 active topic 质心。只提醒不拍板。 */
export function topicDrift(turnText: string, topics: Doc[]): DriftSignal {
  if (topics.length === 0) return { topTopic: null, topScore: 0, suggestsNew: false, coldStart: true }
  const coldStart = topics.length < 3
  const q = tfVector(tokenize(turnText))
  if (q.size === 0) return { topTopic: null, topScore: 0, suggestsNew: false, coldStart }
  let best: Doc | null = null
  let bestScore = 0
  for (const t of topics) {
    const v = tfVector(tokenize(docText(t)))
    const s = cosine(q, v)
    if (s > bestScore) {
      bestScore = s
      best = t
    }
  }
  return {
    topTopic: best,
    topScore: bestScore,
    suggestsNew: !coldStart && bestScore < DRIFT_THRESHOLD,
    coldStart,
  }
}
