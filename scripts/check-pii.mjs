#!/usr/bin/env node
/**
 * 本仓库或 npm tarball 里，有没有能还原到一个真实的人、账号或机器的痕迹？
 *
 *   node scripts/check-pii.mjs            # 仓库 + 待发布文件
 *   node scripts/check-pii.mjs --quiet    # 只报失败
 *
 * ## 为什么这是个脚本而不是一条纪律
 *
 * 它的参考实现（`dsh-connect-workbuddy/scripts/check-pii.mjs`，MIT, LaoDing）
 * 的注释里记着一次事故：5.20.2 发布后审计发现设计稿里有五个完整手机号、
 * CHANGELOG 里还有两个（随 npm 包一起发出了）、截图里打码后的账号名旁边就是
 * 昵称。**typecheck、测试、`npm pack` 一个都没失败** —— 因为没人检查这件事。
 *
 * 本项目当前踩到的版本更朴素：`README.md` 写了一整个真实账号名，`src/bin.ts`
 * 的注释里又写了一遍。注释会进 `lib/`，`lib/` 会进 tarball，于是它跟着包一起
 * 发到了公网。加这个脚本就是为了让下一次同类改动**必须过一道闸**。
 *
 * ## 检查什么
 *
 *   1. `package.json` 的 `files` 白名单里的每个文件（用户真正下载的东西）。
 *   2. 仓库里每个文本文件 ——「不在 tarball 里」不等于「不公开」，仓库是公开的。
 *   3. 每个文件的**文件名**（一个以账号数字命名的截图，泄露程度和它的像素一样）。
 *
 * ## 两条被现实教出来的设计规则
 *
 * **不做整文件豁免。** 豁免一旦存在，下一次泄露就长在豁免范围内。所以这里的
 * 豁免是**值级**的（`ALLOW` 数组里写具体字符串），不是文件级、目录级。
 *
 * **先规范化再匹配。** 针对一种拼法写的规则会漏掉同一个东西的所有其它拼法。
 * 输入先做全角→半角、去掉零宽字符。
 *
 * ## 检查不到什么
 *
 * 它只读文本，不读像素。一张截图里如果账号名清晰可见，这个脚本一定会放它过去。
 * 那是人工审查的活（见 README 的隐私章节），脚本不假装自己能做。
 *
 * 只读。不联网、不写文件。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, extname, join, relative, resolve } from 'node:path'

const QUIET = process.argv.includes('--quiet')
const ROOT = resolve(import.meta.dirname, '..')

/** 只扫文本后缀。二进制文件由图片元数据那条规则另管（本仓库目前没有截图）。 */
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.html', '.css', '.sh', '.py', '', '.patch',
])

/** 永不扫描的目录。注意这里**没有** `lib/` —— 它是 tarball 的主体。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode', 'dist', '.turbo'])

/**
 * 值级豁免：这些字符串本身不是泄露。
 *
 * 只放「看起来像泄露但其实不是」的东西，每条都要能说清为什么。**不要**为了
 * 让扫描通过而往这里加真实值 —— 那是把闸门自己拆掉。
 */
const ALLOW = [
  // 上游作者署名，MIT 归属义务要求保留，不是本机信息。
  'XLNC-L',
  // SHA-256 空串常量，长得像 64 位十六进制但它是公开常量。
  'e3b0c44298fc1c149afbf4c8996fb924',
  '27ae41e4649b934ca495991b7852b855',
  // 官方文档里的示例域名。
  'example.com',
]

/**
 * 规则表。每条是 `[名字, 正则, 说明]`。
 *
 * 写规则时的原则：宁可宽一点、多报几条由人工判断，也不要窄到漏掉真东西。
 * 误报的代价是看一眼，漏报的代价是发到公网。
 */
const RULES = [
  [
    '华为云账号名',
    /hw\d{10,}/g,
    '网关返回的 user_name / domain_name 形如 hw + 一串数字。这是真实账号标识。',
  ],
  [
    '华为云 AK',
    /HPUA[A-Z0-9]{8,}/g,
    'Access Key Id 的前缀。泄露即可被用来签名请求。',
  ],
  [
    '华为云 domain id',
    /\b0[0-9a-f]{31}\b/g,
    '32 位十六进制，形如网关返回的 domain_id / user_id。',
  ],
  [
    '本机绝对路径里的用户名',
    /[A-Za-z]:[\\/]+Users[\\/]+(?!<|%|\$)[A-Za-z0-9._-]+/g,
    '会把开发者机器的用户名带进公开仓库。写 C:\\Users\\<you>\\... 或 <repo>。',
  ],
  [
    'POSIX 家目录里的用户名',
    /\/(?:Users|home)\/(?!<|\$)[A-Za-z0-9._-]+\//g,
    '同上，macOS/Linux 版本。',
  ],
  [
    '中国大陆手机号',
    /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    '完整手机号，无条件禁止（含维护者本人的）。',
  ],
  [
    '电子邮箱',
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    '写 someone@example.com。',
  ],
  [
    '会话 id / 设备指纹',
    /\bses_[A-Za-z0-9]{16,}\b|\bmsg_[A-Za-z0-9]{16,}\b/g,
    '真实会话标识。写 <session-id>。',
  ],
  [
    '疑似 bearer / security token',
    /\b(?:Bearer|securityToken|security_token)["'\s:=]+([A-Za-z0-9._-]{20,})/g,
    '真实凭据值。举例写 at-fixture / token-alpha-old。',
  ],
]

/** 全角→半角、去掉零宽字符。不规范化就会漏掉同一个号码的其它拼法。 */
const normalize = (text) =>
  text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')

const isAllowed = (hit) => ALLOW.some((value) => hit.includes(value))

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
      if (SKIP_DIRS.has(entry.name)) continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/**
 * 算出「哪些文件会真的随 npm 包发出去」。
 *
 * 三个坑，本项目全踩过：
 *
 *   1. 读 `package.json` 的 `files` 自己展开 —— **错**。展开规则由 npm 定，自己
 *      模拟一定有偏差，而偏差方向通常是「少算」，也就是漏扫。
 *   2. `npm pack --dry-run --json` —— 默认会先跑 `prepack`，而 `prepack` 里就会
 *      调这个脚本，于是无限递归。加 `--ignore-scripts` 才安全。
 *   3. `execSync` 走 shell，Windows 上 npm 路径带空格会
 *      `'C:\Program' is not recognized`。用 `execFileSync(..., { shell: false })`。
 *
 * ## 一条更重要的设计约束
 *
 * **扫描范围永远是整个仓库，不是发布清单的子集。** 发布清单只用来给报告加
 * 「[发布包]」标记。理由：全仓库扫描是发布清单的严格超集，方向是安全的（多扫
 * 不会漏）；反过来用清单当过滤条件，一旦清单算错就直接漏扫，而漏扫不会报错。
 *
 * 清单拿不到时**降级而不是失败**：降级后仍然全仓库扫描，只是标记消失。让闸门
 * 因为一个纯装饰性信息而整体罢工，结果是有人把它从 CI 里去掉。
 */
const publishedFiles = async () => {
  try {
    const { execFileSync } = await import('node:child_process')
    // 不走 shell，也不走 `npm.cmd`：
    //   · `execSync('npm ...')` 走 shell，npm 装在 `C:\Program Files\` 时被空格
    //     切成 `C:\Program`（本项目实测 `'C:\Program' is not recognized`）。
    //   · `execFileSync('npm.cmd', ..., {shell:false})` 在 Node ≥20.12 被
    //     CVE-2024-27980 的修复挡住，直接 `spawnSync npm.cmd EINVAL`。
    //   · `shell:true` 又把问题绕回空格。
    // 所以用当前这个 node 去执行 npm 自己的 cli.js —— 路径全由 process.execPath
    // 推出，没有 shell、没有 .cmd、没有空格解析。
    const npmCli = join(
      dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    )
    const raw = execFileSync(
      process.execPath,
      [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
      },
    )
    const list = JSON.parse(raw)?.[0]?.files
    if (!Array.isArray(list) || list.length === 0) throw new Error('打包清单为空')
    return new Map(list.map((f) => [join(ROOT, f.path), true]))
  } catch (error) {
    console.warn(
      `⚠ 无法确定发布清单（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）`,
    )
    console.warn('  已退化为「全仓库扫描」—— 范围更大，结论仍然安全，但没有 [发布包] 标记。')
    return new Map()
  }
}

const problems = []

const scanFile = (file, origin) => {
  const ext = extname(file).toLowerCase()
  if (!TEXT_EXT.has(ext)) return

  // 文件名本身也可能是泄露（一个以账号数字命名的截图）。
  const nameProbe = normalize(file.slice(ROOT.length + 1))
  for (const [label, pattern] of RULES) {
    pattern.lastIndex = 0
    const hit = nameProbe.match(pattern)?.[0]
    if (hit !== undefined && !isAllowed(hit)) {
      problems.push({ file: relative(ROOT, file), origin, label, hit, where: '文件名' })
    }
  }

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const lines = normalize(text).split('\n')

  lines.forEach((line, index) => {
    for (const [label, pattern, why] of RULES) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(line)) !== null) {
        const hit = match[0]
        if (isAllowed(hit)) continue
        problems.push({
          file: relative(ROOT, file),
          origin,
          label,
          hit,
          where: `${index + 1} 行`,
          why,
        })
      }
    }
  })
}

const main = async () => {
  const published = await publishedFiles()
  const files = walk(ROOT)
  let publishedCount = 0

  for (const file of files) {
    const inTarball = published.has(file)
    if (inTarball) publishedCount += 1
    scanFile(file, inTarball ? '发布包' : '仓库')
  }

  if (problems.length === 0) {
    if (!QUIET) {
      console.log('✓ 未发现可还原到真实人/账号/机器的内容')
      console.log(
        publishedCount > 0
          ? `  扫描了 ${files.length} 个文件，其中 ${publishedCount} 个会随 npm 包发布`
          : `  扫描了 ${files.length} 个文件（发布清单不可用，已退化为全仓库扫描）`,
      )
    }
    process.exitCode = 0
    return
  }

  console.error(`✗ 发现 ${problems.length} 处疑似泄露\n`)
  for (const p of problems) {
    console.error(`  ${p.file}  ${p.where}  [${p.origin}]`)
    console.error(`    ${p.label}：${p.hit}`)
    if (p.why !== undefined) console.error(`    ${p.why}`)
  }
  console.error(`
修法：把真实值换成占位符（\`hw\` 加一串数字就去掉数字；路径写
\`C:\\\\Users\\\\<you>\\\\...\` 或 \`<repo>\`）。若确认某条不是泄露，往
scripts/check-pii.mjs 的 ALLOW 里加**那个具体字符串**并写清理由 ——
不要加整文件豁免。`)
  process.exitCode = 1
}

await main()
