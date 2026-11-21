/**
 * 插件自己的小状态文件。
 *
 * 存的都是「用户在本机做的选择」，不是凭据、也不是上游数据：
 *   - `hiddenModelIds`：在模型页签里勾掉的模型（选择器里不再显示）
 *   - `autoCheckin`：在签到页保存的开关
 *   - `lastCheckin`：上一次自动签到成功的本地日期与金额
 *
 * 模型可见性、签到开关与签到记录沿用本机偏好文件。账号页的快捷配置由宿主保存到 profile。
 *
 * 写入用「先写临时文件再改名」：中途崩掉不会留下半个 JSON 把插件卡死。
 *
 * @module dsh-connect-codearts/local-state
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 状态文件名。放在 `$DSH_HOME` 下，与凭据文件同级。 */
export const LOCAL_STATE_FILENAME = '.codearts-state.json'

/** 磁盘上的形状。字段全部可选 —— 老版本写过的文件要能继续读。 */
interface StateFile {
  version?: number
  /** 用户在模型页签里勾掉的模型 id。 */
  hiddenModelIds?: string[]
  autoCheckin?: boolean
  /** 上一次自动签到成功的本地日期（`YYYY-MM-DD`）与金额。 */
  lastCheckin?: { date: string; amount?: number; at: number }
}

/** 内存里的形状。两侧都按已归一化的值处理，不做 undefined 判断散落各处。 */
export interface LocalState {
  readonly hiddenModelIds: readonly string[]
  readonly autoCheckin?: boolean
  readonly lastCheckin: { readonly date: string; readonly amount?: number; readonly at: number } | undefined
}

/** 状态文件路径。 */
export const localStatePath = (dshHome: string): string => join(dshHome, LOCAL_STATE_FILENAME)

/** 本地日期键。用本地时区而不是 UTC —— 「今天签过了」对用户是本地日界。 */
export const localDateKey = (now: Date = new Date()): string => {
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const entry of value) {
    // 去重同时保序：`indexOf` 在几十个元素的量级上完全够用，而 Set 会丢顺序。
    if (typeof entry === 'string' && entry !== '' && !result.includes(entry)) result.push(entry)
  }
  return result
}

/** 把磁盘上的原始 JSON 归一成 `LocalState`。任何畸形都退化成空状态而不是抛。 */
export const normalizeState = (raw: unknown): LocalState => {
  if (raw === null || typeof raw !== 'object') {
    return { hiddenModelIds: [], lastCheckin: undefined }
  }
  const record = raw as StateFile
  const hidden = readStringArray(record.hiddenModelIds)

  let lastCheckin: LocalState['lastCheckin']
  const saved = record.lastCheckin
  if (saved !== undefined && saved !== null && typeof saved === 'object') {
    const date = saved.date
    const at = saved.at
    if (typeof date === 'string' && date !== '' && typeof at === 'number' && Number.isFinite(at)) {
      lastCheckin =
        typeof saved.amount === 'number' && Number.isFinite(saved.amount)
          ? { date, amount: saved.amount, at }
          : { date, at }
    }
  }

  return {
    hiddenModelIds: hidden,
    lastCheckin,
    ...(typeof record.autoCheckin === 'boolean' ? { autoCheckin: record.autoCheckin } : {}),
  }
}

/**
 * 读状态文件。
 *
 * 文件不存在（第一次装）与文件损坏都返回空状态 —— 调用方不需要区分：两者
 * 的正确反应都是「按默认来」。真正的读错误（权限、磁盘）也吞掉，因为状态
 * 丢失只影响「选择器多显示几个模型」，不该让整个插件起不来。
 */
export const loadLocalState = async (dshHome: string): Promise<LocalState> => {
  if (dshHome === '') return { hiddenModelIds: [], lastCheckin: undefined }
  try {
    const text = await readFile(localStatePath(dshHome), { encoding: 'utf8' })
    return normalizeState(JSON.parse(text) as unknown)
  } catch {
    return { hiddenModelIds: [], lastCheckin: undefined }
  }
}

/** 写状态文件（原子）。 */
export const saveLocalState = async (dshHome: string, state: LocalState): Promise<void> => {
  if (dshHome.trim() === '') throw new Error('无法保存码道状态：DSH 主目录为空。')
  const path = localStatePath(dshHome)
  await mkdir(dirname(path), { recursive: true })
  const payload: StateFile = {
    version: 1,
    hiddenModelIds: [...state.hiddenModelIds],
    ...(state.autoCheckin === undefined ? {} : { autoCheckin: state.autoCheckin }),
    ...(state.lastCheckin === undefined ? {} : { lastCheckin: { ...state.lastCheckin } }),
  }
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/**
 * 从完整目录里剔掉用户勾掉的模型。
 *
 * ## 为什么是「隐藏」而不是 WorkBuddy 那种「勾选保留」
 *
 * WorkBuddy 存 `enabledModelIds`（**要**哪些），空数组表示「没配过，给全部」。
 * 我们存 `hiddenModelIds`（**不要**哪些），空数组表示「一个都不用藏」。两者对
 * 「没配过」的处理一致，但增量行为不同：
 *
 *   - 上游今天新上一个模型。勾选式：用户没勾它 ⇒ **默认不出现在选择器里**，
 *     想用得先去设置页找。隐藏式：默认出现。
 *   - 上游下架一个模型。勾选式：选集里那条变成死 id，需要 `deriveCatalog`
 *     退回完整目录兜底（WorkBuddy 的 issue #32 就是踩了这个空选区）。
 *     隐藏式：隐藏表里那条自然失效，**不需要兜底逻辑**。
 *
 * 码道的目录是活接口、随时会加模型，所以「默认出现」是正确的默认值；弱化
 * 兜底也让这里少一条分支。代价是用户没法「只留两个」—— 想只留两个得藏十个，
 * 但那是一次性动作，而新模型自动可见是每天都受益的。
 *
 * ## 边界：藏光了怎么办
 *
 * 用户把 12 个全藏掉 ⇒ 结果为空。宿主动作正确地隐藏这个 provider 分组
 * （`models.length > 0` 是它显示分组的条件），这正是用户表达的意思，不兜底。
 */
export const applyHidden = <T extends { readonly id: string }>(
  models: readonly T[],
  hidden: ReadonlySet<string>,
): readonly T[] =>
  hidden.size === 0 ? models : models.filter((model) => !hidden.has(model.id))
