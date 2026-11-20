/**
 * 凭据探测与持久化。
 *
 * 参考：dsh-huaweicloud-connect（MIT, Alanine-孔硕）`lib/drivers/codearts.js` 的
 *       `cliEnvKeys`（`CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` 两个键名）与
 *       `lib/credentials.js` 的「多来源逐个试，第一个真能通的才采用」策略；
 *       dsh-connect-madao（MIT, XLNC-L）`src/credentials.ts` 的
 *       「永久凭证排在登录态前面」的优先级理由。
 * 改动：① **新增 Windows 注册表读取**。这不是可选优化：Windows 上设置环境变量
 *       对**已经运行**的进程无效，而 DSH 通常先于用户配置变量启动，于是
 *       `process.env.CODEARTS_CLI_AK` 一直是 undefined —— 官方 CLI 自己也会
 *       踩这个坑（必须重开终端）。直接读 `HKCU\Environment` 能让用户改完
 *       变量后不重启 DSH 就生效。
 *       ② 去掉全部「读码道客户端登录态」的分支：M0 实测客户端 STS 走的是
 *       benefit 通道，对话必然失败，读它只会让用户困惑。
 *
 * @module dsh-connect-codearts/credentials
 */
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 与宿主一致解析主目录。CLI 在没有宿主 peer 的环境中也能使用。 */
export const resolveCodeArtsHome = (): string => {
  const configured = process.env['DSH_HOME']
  if (configured === undefined || configured.trim() === '') return join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  if (/^~[\\/]/.test(configured)) return resolve(join(homedir(), configured.slice(2)))
  return resolve(configured)
}

/** 凭据从哪来。界面要如实显示，用户才知道该去哪儿改。 */
export type CredentialSource = 'env' | 'registry' | 'file' | 'csv'

export interface CodeArtsCredentialKey {
  readonly accessKey: string
  readonly secretKey: string
  readonly source: CredentialSource
  /** 来源的具体位置（文件路径 / 注册表键名），用于界面展示与排错。 */
  readonly origin: string
}

export interface LoadResult {
  readonly key?: CodeArtsCredentialKey
  /** 探测过程中的失败记录，界面诊断页直接列出来。 */
  readonly attempts: readonly CredentialAttempt[]
}

export interface CredentialAttempt {
  readonly source: CredentialSource
  readonly origin: string
  readonly ok: boolean
  readonly reason?: string
}

/** 环境变量名，与官方 CLI 完全一致。 */
export const ENV_ACCESS_KEY = 'CODEARTS_CLI_AK'
export const ENV_SECRET_KEY = 'CODEARTS_CLI_SK'

/** 插件自己的凭据文件（设置页粘贴后写入这里）。 */
export const credentialFilePath = (dshHome: string): string =>
  join(dshHome, '.codearts-credentials.json')

/**
 * IAM 访问密钥 CSV 的候选位置。
 *
 * 用户在华为云控制台「访问密钥」里新建 AK 后只能下载一次 CSV，常见落点是
 * 浏览器默认下载目录。列几个变体是因为浏览器重名时会加 `(1)`、`(2)`。
 */
export const csvCandidatePaths = (): readonly string[] => {
  const home = homedir()
  const downloads = join(home, 'Downloads')
  return [
    join(downloads, 'credentials.csv'),
    join(downloads, 'credentials (1).csv'),
    join(downloads, 'credentials (2).csv'),
    join(home, 'Downloads', '访问密钥.csv'),
    join(home, '.codearts', 'credentials.csv'),
  ]
}

/** AK/SK 的形态校验。写死长度是因为它能挡住「只填了一半」这类最常见的输错。 */
export const looksLikeAccessKey = (value: string): boolean => /^[A-Z0-9]{16,32}$/.test(value)
export const looksLikeSecretKey = (value: string): boolean => /^[A-Za-z0-9]{32,64}$/.test(value)

/**
 * 直接读 Windows 注册表里的用户环境变量。
 *
 * 用 `[Environment]::GetEnvironmentVariable(name,'User')` 而不是 `reg query`：
 * 前者直接返回字符串，不需要解析 `REG_SZ` 文本与换行；两者的执行权限相同。
 *
 * 失败一律静默返回 undefined —— 读不到注册表不是错误（Linux/macOS 上本来
 * 就没有），上层会继续尝试下一个来源。
 */
const readWindowsRegistryVariable = async (name: string): Promise<string | undefined> => {
  if (process.platform !== 'win32') return undefined
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { timeout: 5_000, windowsHide: true },
    )
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 再读一次「机器级」环境变量。
 *
 * 用户把变量建在「系统变量」而不是「用户变量」下时，`User` 作用域读不到。
 * 两个作用域都试，成本只是多一次 powershell 调用，但能省掉用户一轮排查。
 */
const readWindowsRegistryVariableMachine = async (name: string): Promise<string | undefined> => {
  if (process.platform !== 'win32') return undefined
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `[Environment]::GetEnvironmentVariable('${name}','Machine')`],
      { timeout: 5_000, windowsHide: true },
    )
    const value = stdout.trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** 解析华为云 IAM 导出的 credentials.csv。表头是 `User Name,Access Key Id,Secret Access Key`。 */
export const parseCredentialCsv = (text: string): { accessKey: string; secretKey: string } | undefined => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 2) return undefined

  const header = (lines[0] ?? '').split(',').map((cell) => cell.trim().toLowerCase())
  const akIndex = header.findIndex((cell) => cell === 'access key id' || cell === 'ak')
  const skIndex = header.findIndex((cell) => cell === 'secret access key' || cell === 'sk')
  if (akIndex < 0 || skIndex < 0) return undefined

  const cells = (lines[1] ?? '').split(',').map((cell) => cell.trim())
  const accessKey = cells[akIndex] ?? ''
  const secretKey = cells[skIndex] ?? ''
  if (!looksLikeAccessKey(accessKey) || !looksLikeSecretKey(secretKey)) return undefined
  return { accessKey, secretKey }
}

/** 插件自己存的凭据文件形状。 */
interface StoredCredentials {
  readonly version: 1
  readonly accessKey: string
  readonly secretKey: string
  readonly savedAt: string
}

const readOwnCredentialFile = async (
  dshHome: string,
): Promise<{ key: { accessKey: string; secretKey: string }; origin: string } | undefined> => {
  const path = credentialFilePath(dshHome)
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const accessKey = record['accessKey']
    const secretKey = record['secretKey']
    if (typeof accessKey !== 'string' || typeof secretKey !== 'string') return undefined
    if (!looksLikeAccessKey(accessKey) || !looksLikeSecretKey(secretKey)) return undefined
    return { key: { accessKey, secretKey }, origin: path }
  } catch {
    return undefined
  }
}

/**
 * 按优先级探测凭据。
 *
 * 顺序与理由：
 *   1. 环境变量 —— 官方 CLI 的推荐方式，用户配上就全平台通用
 *   2. Windows 注册表 —— 环境变量的「无需重启」版本，本机唯一可用路径
 *   3. 插件设置页粘贴的文件 —— 环境变量配不动时的兜底，也是多账号的唯一入口
 *   4. CSV 文件 —— 用户刚在控制台下载、还没来得及配置时的顺手路径
 *
 * **不用**码道客户端的登录态：那条路拿到的是临时 STS，走的是 benefit 通道，
 * M0 与三份参考实现都证实它对话必然失败。
 */
export const loadCredentials = async (dshHome: string): Promise<LoadResult> => {
  const attempts: CredentialAttempt[] = []

  // 1. 进程环境变量
  {
    const accessKey = process.env[ENV_ACCESS_KEY]
    const secretKey = process.env[ENV_SECRET_KEY]
    if (accessKey !== undefined && secretKey !== undefined) {
      const ok = looksLikeAccessKey(accessKey) && looksLikeSecretKey(secretKey)
      attempts.push({
        source: 'env',
        origin: `${ENV_ACCESS_KEY} / ${ENV_SECRET_KEY}`,
        ok,
        ...(ok ? {} : { reason: '环境变量存在但形态不对（AK 应为 16–32 位大写字母数字，SK 应为 32–64 位）' }),
      })
      if (ok) return { key: { accessKey, secretKey, source: 'env', origin: `${ENV_ACCESS_KEY} / ${ENV_SECRET_KEY}` }, attempts }
    } else {
      attempts.push({
        source: 'env',
        origin: `${ENV_ACCESS_KEY} / ${ENV_SECRET_KEY}`,
        ok: false,
        reason: '进程环境变量里没有这两个变量',
      })
    }
  }

  // 2. Windows 注册表（用户级优先，再机器级）
  if (process.platform === 'win32') {
    for (const [scope, read] of [
      ['HKCU\\Environment', readWindowsRegistryVariable],
      ['HKLM 系统变量', readWindowsRegistryVariableMachine],
    ] as const) {
      const accessKey = await read(ENV_ACCESS_KEY)
      const secretKey = await read(ENV_SECRET_KEY)
      if (accessKey !== undefined && secretKey !== undefined) {
        const ok = looksLikeAccessKey(accessKey) && looksLikeSecretKey(secretKey)
        attempts.push({
          source: 'registry',
          origin: scope,
          ok,
          ...(ok ? {} : { reason: '注册表里有这两个变量但形态不对' }),
        })
        if (ok) {
          return {
            key: { accessKey, secretKey, source: 'registry', origin: `${scope} → ${ENV_ACCESS_KEY}` },
            attempts,
          }
        }
      } else {
        attempts.push({ source: 'registry', origin: scope, ok: false, reason: '读不到这两个变量' })
      }
    }
  }

  // 3. 插件自己的凭据文件
  {
    const stored = await readOwnCredentialFile(dshHome)
    attempts.push({
      source: 'file',
      origin: credentialFilePath(dshHome),
      ok: stored !== undefined,
      ...(stored === undefined ? { reason: '文件不存在或内容不符合预期' } : {}),
    })
    if (stored !== undefined) {
      return { key: { ...stored.key, source: 'file', origin: stored.origin }, attempts }
    }
  }

  // 4. IAM 控制台导出的 CSV
  for (const path of csvCandidatePaths()) {
    try {
      const text = await readFile(path, 'utf8')
      const parsed = parseCredentialCsv(text)
      attempts.push({
        source: 'csv',
        origin: path,
        ok: parsed !== undefined,
        ...(parsed === undefined ? { reason: '文件存在但表头或字段不是 IAM 访问密钥格式' } : {}),
      })
      if (parsed !== undefined) {
        return { key: { ...parsed, source: 'csv', origin: path }, attempts }
      }
    } catch {
      // 文件不存在是常态，不记录，避免诊断页被 5 条 ENOENT 淹没。
    }
  }

  return { attempts }
}

/**
 * 保存用户粘贴的 AK/SK。
 *
 * 写入 `$DSH_HOME/.codearts-credentials.json`，用「先写临时文件再改名」保证
 * 不会留下半个文件。不加密：AK/SK 与用户自己存在 `~/.aws/credentials` 里的
 * 是同一敏感级别，而 DPAPI 之类的手段会把插件绑死在 Windows 上。文件权限靠
 * 用户目录本身的隔离。
 */
export const saveCredentials = async (
  dshHome: string,
  accessKey: string,
  secretKey: string,
): Promise<void> => {
  const path = credentialFilePath(dshHome)
  await mkdir(dirname(path), { recursive: true })
  const payload: StoredCredentials = {
    version: 1,
    accessKey: accessKey.trim(),
    secretKey: secretKey.trim(),
    savedAt: new Date().toISOString(),
  }
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/** 清除插件自己存的凭据。**不动**用户的环境变量 —— 那是用户自己的配置。 */
export const clearCredentials = async (dshHome: string): Promise<void> => {
  const { rm } = await import('node:fs/promises')
  await rm(credentialFilePath(dshHome), { force: true })
}

/** 把 AK 打码成 `HST…3F2A` 形式，用于界面展示。绝不回传完整值。 */
export const maskAccessKey = (accessKey: string): string => {
  if (accessKey.length <= 8) return '*'.repeat(accessKey.length)
  return `${accessKey.slice(0, 4)}…${accessKey.slice(-4)}`
}
