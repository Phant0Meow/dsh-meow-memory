/**
 * meow-memory — 指令菜单 dream 行换官方脸（client 端，用户拍板 2026-09-23）。
 *
 * 目标：0.1.7 的 composer `/` 指令菜单里，官方指令（压缩/权限/模型…）每行都是
 * 「图标 + 中文名 + 右对齐一句话描述」，而 dream 是宿主目录行，官方只给它
 * 「名字 + 注册时的 description 全文」——没图标、描述一长串被截断，一枝独秀。
 *
 * 为什么走 DOM 装饰而不是正规注册口：0.1.7 的行脸来源是封闭映射——图标只发给
 * 内置指令（ui-commands presentation.ts 的 HOST_FACES，按名查死表）；客户端
 * contribution 同名会与宿主目录行撞车直接 throw；decoration 只换行为不发行脸。
 * 插件侧唯一 conform 的路就是把自家行描一遍（meow 家传手艺，同 dream 小月牙）。
 *
 * 0.1.6 免疫（用户拍板「旧版本的别改」）：装饰只认 0.1.7 菜单的 DOM 结构特征
 * （容器 [data-trigger-menu] + command 源行 id 前缀 dsh-slash-option-command-），
 * 0.1.6 菜单 DOM 长得不一样，天然不命中、一个字节不动。服务端注册的
 * description 原样保留（0.1.6 菜单吃的就是它），短描述只在本装饰器里换给
 * 0.1.7 的行。
 *
 * 误伤防线：只扫 command 源的行（@ 提文件走 reference 源、技能走 skill 源，
 * 同一容器不同 source，id 段不同，文件名碰巧叫 dream 也不会中）。
 *
 * 幂等与自愈：不写行级标记，按「条件不满足才动手」重涂——月亮 span 已在名字
 * 前面 ⇒ 不再插；描述已不是长文 ⇒ 不再换。React 重渲染冲掉涂装时
 * MutationObserver 会再涂一轮；自己的改动也会触发自己，靠条件幂等收敛。
 *
 * 文本安全：只对叶子 span 做 textContent 覆写（React 对失联文本节点的
 * nodeValue 写入是无害空转，区别于 removeChild 撞 NotFoundError 的子节点
 * 窃取——见 client-dream-icon.ts 头注）；月亮 span 是全新自有节点。
 */

/** 菜单容器特征（0.1.7 input-trigger MenuView 独有）。 */
const MENU_SELECTOR = '[data-trigger-menu]'
/** command 源行 id 前缀（optionId('command', index) 的产物）。 */
const ROW_ID_PREFIX = 'dsh-slash-option-command-'
/** dream 行的短描述（对齐官方一句话的体量）。 */
const DREAM_SHORT = '手动唤起一次记忆整理'
/** dream 行的长描述开头（注册全文；用来认出要换的描述 span）。 */
const DREAM_LONG_PREFIX = '手动唤起一次记忆整理（dream）'
/** FA 月亮（regular 空心，与官方行图标线风格一致；路径=FA 5.15.4 svgs/regular/moon.svg），fill currentColor 随行配色。 */
const MOON_SVG = '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path fill="currentColor" d="M279.135 512c78.756 0 150.982-35.804 198.844-94.775 28.27-34.831-2.558-85.722-46.249-77.401-82.348 15.683-158.272-47.268-158.272-130.792 0-48.424 26.06-92.292 67.434-115.836 38.745-22.05 28.999-80.788-15.022-88.919A257.936 257.936 0 0 0 279.135 0c-141.36 0-256 114.575-256 256 0 141.36 114.576 256 256 256zm0-464c12.985 0 25.689 1.201 38.016 3.478-54.76 31.163-91.693 90.042-91.693 157.554 0 113.848 103.641 199.2 215.252 177.944C402.574 433.964 344.366 464 279.135 464c-114.875 0-208-93.125-208-208s93.125-208 208-208z"/></svg>'

/** 找 command 源里的 dream 行：名字 span 恰为 dream 的行。 */
function findDreamRow(menu: ParentNode): HTMLButtonElement | null {
  const rows = menu.querySelectorAll<HTMLButtonElement>(`button[id^="${ROW_ID_PREFIX}"]`)
  for (const row of rows) {
    for (const span of row.querySelectorAll(':scope > span')) {
      if (span.textContent === 'dream') return row
    }
  }
  return null
}

/** 官方行的图标 span 样式类（哈希类名从现成行抄，拿到就与官方像素级同款）。 */
function officialIconClass(menu: ParentNode): string | null {
  const svg = menu.querySelector(`button[id^="${ROW_ID_PREFIX}"] > span > svg`)
  const span = svg?.parentElement
  if (span === null || span === undefined || span.className.length === 0) return null
  return span.className
}

/** 给 dream 行上脸：名字前插月亮 span + 描述换短句。条件已满足则一尘不动。 */
function decorateRow(row: HTMLButtonElement, iconClass: string | null): void {
  const spans = row.querySelectorAll(':scope > span')
  let nameSpan: Element | null = null
  let descriptionSpan: Element | null = null
  for (const span of spans) {
    if (span.textContent === 'dream') nameSpan = span
    else if ((span.textContent?.length ?? 0) > 4 && span !== nameSpan) descriptionSpan = span
  }
  if (nameSpan === null) return
  // 月亮：名字前的兄弟不是自有月亮 span 才插（插在名字 span 之前，flex gap 自动给间距）。
  const prev = nameSpan.previousElementSibling
  if (prev === null || !prev.hasAttribute('data-meow-dream-face')) {
    const icon = document.createElement('span')
    icon.setAttribute('data-meow-dream-face', '1')
    if (iconClass !== null) icon.className = iconClass
    else icon.style.cssText = 'display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;'
    icon.innerHTML = MOON_SVG
    nameSpan.parentElement?.insertBefore(icon, nameSpan)
  }
  // 描述：还是长文才换（React 冲回长文时这里会再命中；短文重复写无意义）。
  if (descriptionSpan !== null && descriptionSpan !== nameSpan
    && descriptionSpan.textContent?.startsWith(DREAM_LONG_PREFIX) === true) {
    descriptionSpan.textContent = DREAM_SHORT
  }
}

/** 启动指令菜单 dream 行装饰（幂等重涂；返回 disposer）。 */
export function startMenuDreamFace(): () => void {
  if (typeof document === 'undefined') return () => {}
  let scheduled = false
  const decorate = (): void => {
    scheduled = false
    try {
      const menu = document.querySelector(MENU_SELECTOR)
      if (menu === null) return
      const row = findDreamRow(menu)
      if (row === null) return
      decorateRow(row, officialIconClass(menu))
    } catch { /* 菜单装饰失败不影响任何功能 */ }
  }
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(decorate)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()
  return () => { observer.disconnect() }
}
