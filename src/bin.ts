#!/usr/bin/env node
/**
 * 命令行诊断入口。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/bin.ts` — `status` / `doctor`
 *       / `logout` 三个子命令的形状，以及「诊断命令绝不写用户的凭据文件」这条
 *       边界。
 * 改动：多一个 `models` 子命令。码道的模型目录是判断「这条链路通不通」最快
 *       的探针（一次 GET，不消耗额度），比把整个对话链路跑一遍更适合排障。
 *       另外 `doctor` 会逐级检查凭据来源，因为码道最常见的问题是「环境变量
 *       设了但 DSH 进程读不到」。
 *
 * @module dsh-connect-codearts/bin
 */
import process from 'node:process'

import { loadCredentials, clearCredentials, credentialFilePath, maskAccessKey, resolveCodeArtsHome } from './credentials.ts'
import { CodeArtsUpstreamClient } from './upstream.ts'

const USAGE = `
dsh-connect-codearts — 码道（Huawei Cloud CodeArts Agent）provider 诊断工具

用法：
  dsh-connect-codearts status     显示凭据来源、账号、积分
  dsh-connect-codearts models     列出当前可用的模型（一次 GET，不消耗积分）
  dsh-connect-codearts doctor     逐级检查凭据链路并给出可执行建议
  dsh-connect-codearts logout     删除本插件保存的凭据（不动环境变量）

退出码：0 正常，1 有问题。
`.trim()

const dshHome = resolveCodeArtsHome

const client = (): CodeArtsUpstreamClient => new CodeArtsUpstreamClient()

const toCredentials = (key: { accessKey: string; secretKey: string }) => ({
  accessKey: key.accessKey,
  secretKey: key.secretKey,
})

/** `status`：凭据是谁、从哪来、还剩多少积分。 */
const runStatus = async (): Promise<number> => {
  const loaded = await loadCredentials(dshHome())
  if (loaded.key === undefined) {
    console.error('没有读到凭据。')
    for (const attempt of loaded.attempts) {
      console.error(`  ${attempt.ok ? '✓' : '✗'} ${attempt.source.padEnd(8)} ${attempt.origin}${attempt.reason === undefined ? '' : ` — ${attempt.reason}`}`)
    }
    console.error('\n运行 `dsh-connect-codearts doctor` 看具体该怎么修。')
    return 1
  }

  const { accessKey, secretKey, source, origin } = loaded.key
  console.log(`凭据        ${maskAccessKey(accessKey)}（来源 ${source}：${origin}）`)

  const upstream = client()
  const credentials = toCredentials({ accessKey, secretKey })

  try {
    const account = await upstream.currentUser(credentials)
    const label = account.userName ?? account.domainName ?? '未知'
    // 账号名是 `hw` 加一串数字，不是昵称：显示后 6 位足够区分，也不会把完整
    // 账号名贴到日志里。
    console.log(`账号        ${label.length > 6 ? `…${label.slice(-6)}` : label}`)
  } catch (error) {
    console.log(`账号        读取失败：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const credit = await upstream.credit(credentials)
    if (credit === undefined) {
      console.log('积分        接口没有返回积分字段（可能是 Token 计费账号）')
    } else {
      console.log(`积分        ${credit.remain ?? '未知'} 可用 / ${credit.total ?? '未知'} 总额`)
      if (credit.expiringAmount !== undefined && credit.expiringAmount > 0) {
        console.log(`            其中 ${credit.expiringAmount} 即将到期`)
      }
    }
  } catch (error) {
    console.log(`积分        读取失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return 0
}

/** `models`：只打目录接口，不消耗额度。 */
const runModels = async (): Promise<number> => {
  const loaded = await loadCredentials(dshHome())
  if (loaded.key === undefined) {
    console.error('没有读到凭据，无法列出模型。')
    return 1
  }

  const upstream = client()
  const entries = await upstream.listModels(
    toCredentials(loaded.key as { accessKey: string; secretKey: string }),
  )

  if (entries.length === 0) {
    console.error('网关返回了空目录。')
    return 1
  }

  const idWidth = Math.max(4, ...entries.map((entry) => entry.id.length))
  const nameWidth = Math.max(4, ...entries.map((entry) => entry.name.length))

  console.log(`${'model_id'.padEnd(idWidth)}  ${'名称'.padEnd(nameWidth)}  上下文     上限    图片  倍率`)
  for (const entry of entries) {
    console.log(
      [
        entry.id.padEnd(idWidth),
        entry.name.padEnd(nameWidth),
        String(entry.contextWindow).padStart(8),
        String(entry.maxTokens).padStart(6),
        entry.supportsImages ? '  👁 ' : '    ',
        entry.ratioDisplay ?? '',
      ].join('  '),
    )
  }
  console.log(`\n共 ${entries.length} 个模型。`)
  return 0
}

/**
 * `doctor`：逐级检查。
 *
 * 顺序就是 `credentials.ts` 的探测顺序，这样用户能直接看出断在第几级。特意
 * 把「环境变量存在但本进程读不到」单独列出来 —— 这是 Windows 上最常见的一种，
 * 用户明明设好了却一直失败。
 */
const runDoctor = async (): Promise<number> => {
  console.log('码道 CodeArts 链路诊断\n')

  console.log('1. 环境变量（当前进程）')
  const envAk = process.env['CODEARTS_CLI_AK']
  const envSk = process.env['CODEARTS_CLI_SK']
  if (envAk !== undefined && envAk !== '' && envSk !== undefined && envSk !== '') {
    console.log(`   ✓ 已读到 ${maskAccessKey(envAk)}`)
  } else {
    console.log('   ✗ 本进程读不到 CODEARTS_CLI_AK / CODEARTS_CLI_SK')
    console.log('     若你刚在「系统属性 → 环境变量」里设过，那是正常的：')
    console.log('     环境变量不会注入已在运行的进程。本插件的凭据层会直接读注册表绕过这一限制。')
  }

  console.log('\n2. 凭据探测（四级）')
  const loaded = await loadCredentials(dshHome())
  for (const attempt of loaded.attempts) {
    const mark = attempt.ok ? '✓' : '✗'
    const reason = attempt.reason === undefined ? '' : ` — ${attempt.reason}`
    console.log(`   ${mark} ${attempt.source.padEnd(8)} ${attempt.origin}${reason}`)
  }

  if (loaded.key === undefined) {
    console.log('\n没有任何来源可用。三种修法（任选其一）：')
    console.log('   a) 华为云控制台 → 我的凭证 → 访问密钥 → 新建 → 立即下载 CSV')
    console.log('      把 CSV 放到「下载」文件夹，本插件会自动捡到（文件名需含 credentials）')
    console.log('   b) 系统属性 → 高级 → 环境变量，新建 CODEARTS_CLI_AK / CODEARTS_CLI_SK')
    console.log('   c) 在 DSH 主目录配置 .codearts-credentials.json，包含 accessKey 和 secretKey')
    return 1
  }

  console.log(`\n   最终采用：${maskAccessKey(loaded.key.accessKey)}（${loaded.key.source}）`)

  const upstream = client()
  const credentials = toCredentials({
    accessKey: loaded.key.accessKey,
    secretKey: loaded.key.secretKey,
  })

  console.log('\n3. 网关连通性')
  try {
    const account = await upstream.currentUser(credentials)
    console.log(`   ✓ 签名有效，账号 ${(account.userName ?? '').slice(-6).padStart(6, '…')}`)
  } catch (error) {
    console.log(`   ✗ ${error instanceof Error ? error.message : String(error)}`)
    console.log('     若是签名错，检查：AK/SK 是否抄错、系统时间是否偏差超过 15 分钟。')
    return 1
  }

  console.log('\n4. 模型目录')
  try {
    const entries = await upstream.listModels(credentials)
    console.log(`   ✓ ${entries.length} 个模型可用`)
  } catch (error) {
    console.log(`   ✗ ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  console.log('\n5. 积分')
  try {
    const credit = await upstream.credit(credentials)
    if (credit === undefined) {
      console.log('   - 接口没有返回积分字段（Token 计费账号可能如此），不影响对话')
    } else {
      console.log(`   ✓ ${credit.remain ?? '未知'} 可用 / ${credit.total ?? '未知'} 总额`)
      if (credit.remain === 0) {
        console.log('     余额为 0，对话会被拒绝。到控制台做每日签到或购买套餐。')
      }
    }
  } catch (error) {
    console.log(`   ✗ ${error instanceof Error ? error.message : String(error)}（不影响对话）`)
  }

  console.log('\n全部检查通过。')
  return 0
}

/** `logout`：只删本插件保存的凭据。环境变量归用户自己管。 */
const runLogout = async (): Promise<number> => {
  await clearCredentials(dshHome())
  console.log(`已删除 ${credentialFilePath(dshHome())}（若不存在则无变化）。`)
  console.log('环境变量 CODEARTS_CLI_AK / CODEARTS_CLI_SK 不受影响，需要的话请自行在系统设置里删除。')
  return 0
}

const main = async (): Promise<number> => {
  const command = process.argv[2] ?? 'status'

  switch (command) {
    case 'status':
      return runStatus()
    case 'models':
      return runModels()
    case 'doctor':
      return runDoctor()
    case 'logout':
      return runLogout()
    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE)
      return 0
    default:
      console.error(`未知子命令：${command}\n`)
      console.error(USAGE)
      return 1
  }
}

void main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  },
)
