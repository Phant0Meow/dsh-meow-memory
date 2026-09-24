/**
 * 全局目录（实例级数据家）：日志四件（perf.log / perf.log.old / apply-error.log /
 * settings-register-error.log）、window-index.json、migrate-v0 状态、prompts/ 实例覆盖层。
 *
 * 唯一状态口：模块级 active。全部读写方经 activeHomeDir() 动态取，**不许**再写死
 * homedir()——设置页保存（onChange）或 apply 解析配置后调 switchHomeDir() 热切换，
 * 下一笔写即落新目录，dsh 主进程不重启、插件不重载。
 * 默认=平台用户主目录（os.homedir() 跨平台：Windows=C:\Users\<u>\.dsh-meow，
 * mac=/Users/<u>/.dsh-meow，其余类推）。
 *
 * 安全红线（用户拍板 2026-09-24）：
 * - 迁移绝不删除旧目录——跨盘复制后旧目录原样保留，提示用户确认后手动删；
 * - 目标目录非空时绝不覆盖（视为已迁过/有意为之，直接启用）；
 * - 任何一步失败留在原目录照常跑，绝不影响插件启动。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_HOME_DIR = join(homedir(), '.dsh-meow')

/**
 * 环境变量兜底入口（MEOW_MEMORY_HOME，绝对路径）：0.1.7 设置页真机断点
 * （describe 不列出 meow-memory 命名空间，写入必被拒——2026-09-25 实证）期间
 * 的替代通道，在 dsh 启动脚本里设一行即生效，不依赖设置写入链路。
 */
function envHomeDir(): string | undefined {
  const v = process.env.MEOW_MEMORY_HOME?.trim()
  if (v === undefined || v === '') return undefined
  const r = resolve(v)
  if (r === dirname(r) || r === resolve(homedir())) return undefined // 盘根/主目录本身：拒
  return r
}

let active = envHomeDir() ?? DEFAULT_HOME_DIR

/** 当前生效的全局目录（所有消费方唯一取值口）。 */
export function activeHomeDir(): string {
  return active
}

/** 直接改状态口（apply/onChange 经 switchHomeDir 走；测试用它注入临时目录）。 */
export function setActiveHomeDir(dir: string): void {
  active = dir
}

/** homeDir 配置的合法形态：'default' | 'dsh-storage' | 'plugin-root' | 自定义绝对路径。 */

/** DSH home（数据根）：migrate-v0 同款探测——env 优先，缺省回落 ~/.dsh。 */
export function dshHomeDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 插件本体根目录（bundle 位于 lib/，上一级即插件根）。 */
export function pluginRootDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 三个预设的实际落点（因机器/安装位置而异；设置页 radio 旁显示用）。 */
export function homeDirPresets(): Record<string, string> {
  return {
    default: DEFAULT_HOME_DIR,
    'dsh-storage': join(dshHomeDir(), 'storages', 'meow-memory'),
    'plugin-root': join(pluginRootDir(), 'storage'),
  }
}

/** homeDir 配置 → 绝对路径（唯一解析口）。手编 settings.yaml / 设置页 user 层都经此。
 *  优先级：显式配置（预设/自定义绝对路径）> MEOW_MEMORY_HOME env > 平台默认。
 *  非法自定义（空、相对路径、盘根、用户主目录本身）一律回落——迁移动作会把文件
 *  搬进目标，指向根级目录太危险，宁可不切。 */
export function resolveHomeDir(value: unknown): string {
  if (typeof value !== 'string') return envHomeDir() ?? DEFAULT_HOME_DIR
  const v = value.trim()
  if (v === '' || v === 'default') return envHomeDir() ?? DEFAULT_HOME_DIR
  if (v === 'dsh-storage' || v === 'plugin-root') return homeDirPresets()[v]
  if (!isAbsolute(v)) return envHomeDir() ?? DEFAULT_HOME_DIR
  const r = resolve(v)
  if (r === dirname(r)) return envHomeDir() ?? DEFAULT_HOME_DIR // 盘根（dirname(盘根)==盘根）
  if (r === resolve(homedir())) return envHomeDir() ?? DEFAULT_HOME_DIR // 用户主目录本身
  return r
}

export interface HomeDirSwitch {
  /** active 是否已切到 to。 */
  changed: boolean
  /** 是否执行了搬移（false=目标非空直接启用，或原地不动，或失败）。 */
  migrated: boolean
  mode: 'same' | 'reused-nonempty' | 'rename' | 'copy' | 'failed'
  /** 搬动的文件数（目录不计数）。 */
  files: number
  from: string
  to: string
  error?: string
}

/** 递归数文件（不含目录）。 */
function countFiles(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(join(dir, e.name))
    else n++
  }
  return n
}

/**
 * 切换全局目录（唯一入口；apply 同步走一次，设置页 onChange 异步走）：
 * ① target==当前 → 不动；
 * ② 目标非空 → 已迁过或用户有意，直接启用，绝不覆盖；
 * ③ 目标不存在或为空壳 → 搬移：先试整目录 rename（同盘瞬移，源目录随之消失），
 *    失败（跨盘 EXDEV / 源被占用）降级 cpSync 递归复制——源目录原样保留，从不在
 *    代码里删除。搬完落 home-dir.json 标记（来源/时间/方式/数量）供用户辨认。
 */
export function switchHomeDir(target: string, now = new Date().toISOString()): HomeDirSwitch {
  const from = active
  const to = resolve(target)
  if (to === from) return { changed: false, migrated: false, mode: 'same', files: 0, from, to }
  try {
    if (existsSync(to) && readdirSync(to).length > 0) {
      active = to
      return { changed: true, migrated: false, mode: 'reused-nonempty', files: 0, from, to }
    }
    let files = 0
    try {
      files = countFiles(from)
    } catch {
      /* 源不可读（本就没建过）：0 项可搬 */
    }
    // 空壳目标先拆掉，让同盘 rename 路径统一可用；拆不掉（权限）则 copy 路径原地复用
    if (existsSync(to)) {
      try {
        rmdirSync(to)
      } catch {
        /* 保留空壳，走 copy */
      }
    }
    let mode: 'rename' | 'copy' = 'copy'
    if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true })
      try {
        renameSync(from, to)
        mode = 'rename'
      } catch {
        /* 跨盘/占用：降级复制 */
      }
    }
    if (mode === 'copy') {
      mkdirSync(to, { recursive: true })
      cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
    }
    active = to
    try {
      writeFileSync(
        join(to, 'home-dir.json'),
        JSON.stringify({ migratedFrom: from, migratedAt: now, mode, files }, null, 1),
        'utf8',
      )
    } catch {
      /* 标记失败不影响切换 */
    }
    return { changed: true, migrated: true, mode, files, from, to }
  } catch (e) {
    return {
      changed: false,
      migrated: false,
      mode: 'failed',
      files: 0,
      from,
      to,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
