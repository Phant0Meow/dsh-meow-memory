/**
 * meow-memory — 工作区记忆库信任门（issue #64）。
 *
 * 背景：.dsh-meow/ 住在工作区里 = 任何人都能预置。恶意仓库带一个造好的
 * memory.db（或 PROJECT.md，autoMigrate 会导入），受害者打开后首轮就把内容
 * 当「用户自己的长期记忆」注入——零交互、零提示（预置库非 isFresh，首建提示
 * 也不触发）。
 *
 * 信任判据（单一事实源）：本机全局目录（activeHomeDir）下的注册表，一个工作区
 * 一个 marker 文件（路径归一后 sha256 命名）。注册表在 home 目录 = 仓库作者
 * 碰不到，不可伪造。
 *
 * 登记时机（三个）：
 * 1. 插件自己建库（getDb 发现 memory.db 不存在）且当时 .dsh-meow 目录为空/不
 *    存在 → 创建即登记（空库定义上不是预置的；目录已有预置文件则不登记）；
 * 2. apply 启动时从 window-index.json 播种（升级前打开过的工作区零摩擦；
 *    该文件同样在 home 目录，不可伪造）；
 * 3. /meow-trust 命令手动登记。
 *
 * 失效方向（用户拍板 2026-10-25）：门未启用（apply 前的测试环境）一律视为已
 * 信任 = fail-open（等同 0.31.x 行为）；注册表单文件 IO 失败 fail-open 跳过，
 * 绝不因信任机制把记忆弄死。注册表目录整体被删 = 回到未信任（重新 /meow-trust，
 * 代价是一次重复提示，不是静默绕过）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { activeHomeDir } from './home-dir.js'

/** 工作区路径归一（#28 匹配口径）：斜杠统一、去尾斜杠、大小写不敏感（Windows 盘符
 *  友好）。从 index.ts 移入本模块（信任标记与停用名单共用同一口径）；index.ts
 *  re-export 保持既有导出面不变。 */
export function normalizeWorkspacePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

interface TrustMarker {
  path: string
  trustedAt?: number
  trustedSource?: 'created-empty' | 'window-index-seed' | 'meow-trust'
  noticedAt?: number
}

/** 门状态：null = 未启用（测试环境 / apply 前）→ 一切判定 fail-open。 */
let markersDir: string | null = null

/** 启用信任门（apply 期调用一次；homeDir 参数化供测试隔离）。幂等。 */
export function enableWorkspaceTrust(homeDir: string = activeHomeDir()): void {
  const dir = join(homeDir, 'trusted-workspaces')
  try {
    mkdirSync(dir, { recursive: true })
    markersDir = dir
  } catch {
    markersDir = null // 建不了注册表目录 → 门不启用（fail-open），绝不影响启动
  }
}

/** 停用信任门（测试清理用；生产不调用）。 */
export function disableWorkspaceTrust(): void {
  markersDir = null
}

function markerPath(ws: string): string {
  const hash = createHash('sha256').update(normalizeWorkspacePath(ws)).digest('hex')
  return join(markersDir as string, `${hash}.json`)
}

function readMarker(ws: string): TrustMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(ws), 'utf8')) as TrustMarker
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.path !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 原子写（tmp+rename，与 backupMemoryDb 同款）：注册表是安全边界，写坏不如不写。 */
function writeMarker(ws: string, marker: TrustMarker): void {
  const target = markerPath(ws)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(marker, null, 1), 'utf8')
  renameSync(tmp, target)
}

/** 工作区是否已信任。门未启用时 fail-open 返回 true。 */
export function isTrustedWorkspace(ws: string): boolean {
  if (markersDir === null) return true
  const marker = readMarker(ws)
  return marker !== undefined && typeof marker.trustedAt === 'number'
}

/** 工作区记忆库是否未信任（门未启用恒为 false）。 */
export function isUntrustedMemoryWorkspace(ws: string): boolean {
  return !isTrustedWorkspace(ws)
}

/** 登记信任。保留既有 noticedAt（信任后不重发外部库提示）。 */
export function trustWorkspace(ws: string, source: TrustMarker['trustedSource'] = 'meow-trust'): boolean {
  if (markersDir === null) return false
  try {
    const existing = readMarker(ws)
    if (existing !== undefined && typeof existing.trustedAt === 'number') return true
    writeMarker(ws, { ...existing, path: ws, trustedAt: Date.now(), trustedSource: source })
    return true
  } catch {
    return false
  }
}

/** 建库时刻的登记判定：memory.db 不存在即将由本插件创建——当时 .dsh-meow 目录
 *  为空/不存在才算「本机从零创建」；目录里已有任何文件（预置 PROJECT.md /
 *  sessions/ / memory.db.bak / 任意伪装）都不登记 → 未信任。
 *  注意本函数在 MemoryDb 构造**之后**调用（getDb 顺序），目录里必然已有刚建的
 *  memory.db 及其 WAL/SHM 运行残留——它们全在排除集里。真正的预置 memory.db
 *  走不到这里（文件存在 → getDb 判 creating=false → 本函数不被调用）。 */
const CREATION_DIR_IGNORE = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.tmp', 'dream-debug.log'])

export function registerCreatedWorkspace(workspace: string, dir: string): void {
  if (markersDir === null) return
  if (isTrustedWorkspace(workspace)) return
  try {
    const dirPath = join(workspace, dir)
    if (existsSync(dirPath)) {
      for (const entry of readdirSync(dirPath)) {
        if (!CREATION_DIR_IGNORE.has(entry)) return // 目录非空（预置内容）→ 不登记
      }
    }
    trustWorkspace(workspace, 'created-empty')
  } catch {
    /* 判定失败不登记（fail-closed 只影响这一个新工作区，不影响既有信任） */
  }
}

/** 外部库一次性提示是否已发过（放注册表而非工作区 seen 文件——后者可预置）。 */
export function hasExternalNoticeShown(ws: string): boolean {
  if (markersDir === null) return true
  return typeof readMarker(ws)?.noticedAt === 'number'
}

export function markExternalNoticeShown(ws: string): void {
  if (markersDir === null) return
  try {
    const existing = readMarker(ws)
    if (existing === undefined) {
      // 未信任且从未登记：先落一个「仅记提示」的 marker，/meow-trust 时补 trustedAt
      writeMarker(ws, { path: ws, noticedAt: Date.now() })
    } else if (typeof existing.noticedAt !== 'number') {
      writeMarker(ws, { ...existing, noticedAt: Date.now() })
    }
  } catch {
    /* 提示记账失败 → 最坏情况下重复提示一次，不影响门本身 */
  }
}

/** 升级播种：window-index.json（home 目录，不可伪造）里出现过的每个工作区都
 *  是本机升级前实际打开过的 → 全部登记信任，老用户零摩擦。幂等。 */
export function seedTrustedWorkspaces(
  indexFile: string = join(activeHomeDir(), 'window-index.json'),
): { trusted: number; listed: number } {
  if (markersDir === null) return { trusted: 0, listed: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(indexFile, 'utf8'))
  } catch {
    return { trusted: 0, listed: 0 }
  }
  if (parsed === null || typeof parsed !== 'object') return { trusted: 0, listed: 0 }
  const workspaces = new Set<string>()
  for (const ws of Object.values(parsed as Record<string, unknown>)) {
    if (typeof ws === 'string' && ws.length > 0) workspaces.add(ws)
  }
  let trusted = 0
  for (const ws of workspaces) {
    if (trustWorkspace(ws, 'window-index-seed')) trusted += 1
  }
  return { trusted, listed: workspaces.size }
}

/** /meow-trust 用户命令（dsh 命令平面）：信任当前窗口工作区的记忆库，即刻生效
 *  （各门控是活检查，无需重启/热重载）。返回形状与 dreamCommandDefinition 同款。 */
export function trustCommandDefinition(): { name: string; description: string; handler: (invocation: unknown) => { kind: 'success' | 'error'; text: string } } {
  return {
    name: 'meow-trust',
    description: '信任当前工作区自带的记忆库（.dsh-meow 非本机创建时,meow-memory 会暂停注入/检索/整理;执行本命令恢复,即刻生效,无需重启）。',
    handler(invocation) {
      const agent = (invocation as { agent?: { session?: { header?: { cwd?: unknown } } } })?.agent
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) {
        return { kind: 'error', text: '/meow-trust 无法确定当前窗口的工作区（会话无 cwd）。' }
      }
      if (markersDir === null) {
        return { kind: 'error', text: '/meow-trust 不可用：信任门未启用（本实例未完成装配）。' }
      }
      if (isTrustedWorkspace(cwd)) return { kind: 'success', text: '此工作区的记忆库已在信任名单中，无需重复信任。' }
      const ok = trustWorkspace(cwd, 'meow-trust')
      return ok
        ? { kind: 'success', text: '已信任此工作区的记忆库：注入 / 检索 / 整理 / 写入即刻恢复，无需重启。' }
        : { kind: 'error', text: '/meow-trust 写入信任注册表失败（全局目录不可写？），请检查 meow-memory 全局目录权限。' }
    },
  }
}
