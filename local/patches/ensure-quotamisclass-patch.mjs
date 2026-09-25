#!/usr/bin/env node
/**
 * dsh quota-misclass 补丁器 — 403 余额不足误报 "invalid API key" 修复（零依赖，独立运行）。
 *
 * 背景：dsh 把 401/403 一律映射为 AUTH（pi-ai 的 classifyPiAiError 提前短路；
 * deepseek 的 httpErrorCode 同）。但中转站/gpt 供应商余额不足时返回 403
 * insufficient balance / insufficient_user_quota / 预扣费额度失败——key 本身有效，
 * UI 却误报 "API key invalid"。
 *
 * 修复：401 才判 AUTH；403 中 quota/balance/额度类错误改判 QUOTA（另有真实
 * 403 禁用 key 仍判 AUTH），让 UI 显示真实原因。
 *
 * 覆盖（2026-09-25 适配 dsh 0.1.7-rc.2）：dsh 里 401/403 → AUTH 的短路点不止一处，
 * 本脚本按「分类点」逐个覆盖——
 * - pi-ai `classifyPiAiError`；
 * - deepseek `httpErrorCode`（0.1.5/0.1.6 的 chat/completions 分类点，rc.2 已删该端点）；
 * - deepseek `providerError`（0.1.6 起、rc.2 唯一的 messages transport 分类点）；
 * - deepseek `DeepSeekFilesError` 构造函数（Files API 上传路径，三版本同形）。
 * 每个分类点带 `requires` 版本门：该版本没有这个函数就跳过，有的必须命中且唯一。
 *
 * 幂等：目标含补丁标记则跳过；dsh 升级后自动重打。接入 dsh-web.service 的
 * ExecStartPre（与 ensure-connstuck-patch.mjs 并列）。
 *
 * 用法：
 *   node ensure-quotamisclass-patch.mjs            # 检查并补丁（默认）
 *   node ensure-quotamisclass-patch.mjs --check    # 只检查（0=健康 1=需补丁）
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const HOME = process.env.HOME
const base = `${HOME}/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`

const MARKER = '// ponytail: billing/quota 403s'

const QUOTA_TEST = "isQuotaExceededError(detail) || /insufficient[\\s_-]+user[\\s_-]+quota|insufficient[\\s_-]+account[\\s_-]+balance|billing_error|预扣费|剩余额度/i.test(detail)"

/**
 * 每个文件列出若干「分类点」。命中规则：
 * - `requires` 存在且在文件里找不到 → 该版本没有这个分类点，跳过（不计失败）；
 * - 否则 old 必须在文件里恰好命中一次，否则失败（阻止启动，宁可人工核对）。
 * 全部分类点都被跳过 = 这个文件不是我们认识的形态 → 失败。
 *
 * 版本差异（2026-09-25 核对 0.1.5-rc.2 / 0.1.6 / 0.1.7-rc.2 产物）：
 * - ≤0.1.6 的 messages 分类在 `httpErrorCode`；0.1.6 起新增 `providerError`（rc.2 只剩它）；
 * - `DeepSeekFilesError`（Files API）构造函数在三个版本里逐字节相同，故不需要版本门。
 */
const EDITS = [
  {
    file: `${base}/dsh-llm-pi-ai/lib/index.js`,
    sites: [
      {
        what: 'classifyPiAiError 403',
        old: '\tif (/\\b(?:401|403)\\b/.test(message)) return "AUTH";\n\tif (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;',
        new: `\tif (/\\b401\\b/.test(message)) return "AUTH";
\tif (/\\b403\\b/.test(message)) {
\t\t// ponytail: billing/quota 403s (insufficient balance, 预扣费/剩余额度, new-api
\t\t// insufficient_user_quota) are NOT bad keys; map them to QUOTA so the UI
\t\t// stops reporting "invalid API key" for a healthy key that is out of credit.
\t\tif (isQuotaExceededError(message) || /insufficient[\\s_-]+user[\\s_-]+quota|insufficient[\\s_-]+account[\\s_-]+balance|billing_error|预扣费|剩余额度/i.test(message)) return QUOTA_EXCEEDED_CODE;
\t\treturn "AUTH";
\t}
\tif (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;`
      }
    ]
  },
  {
    file: `${base}/dsh-llm-deepseek/lib/index.js`,
    sites: [
      {
        what: 'httpErrorCode 403（0.1.5/0.1.6 的 chat/completions 分类点）',
        requires: 'function httpErrorCode(',
        old: 'function httpErrorCode(status, error) {\n\tif (status === 401 || status === 403) return "AUTH";\n\tif (status === 413) return "INVALID_REQUEST";\n\tconst detail = [\n\t\terror?.code,\n\t\terror?.type,\n\t\terror?.message\n\t].filter(Boolean).join(" ");\n\tif (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;',
        new: `function httpErrorCode(status, error) {
\tconst detail = [
\t\terror?.code,
\t\terror?.type,
\t\terror?.message
\t].filter(Boolean).join(" ");
\tif (status === 401) return "AUTH";
\tif (status === 403) {
\t\t// ponytail: billing/quota 403s are NOT bad keys; map to QUOTA so the UI
\t\t// stops reporting "invalid API key" for a healthy key out of credit.
\t\tif (${QUOTA_TEST}) return QUOTA_EXCEEDED_CODE;
\t\treturn "AUTH";
\t}
\tif (status === 413) return "INVALID_REQUEST";
\tif (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;`
      },
      {
        what: 'providerError 403（0.1.6 起的 messages transport 分类点，rc.2 唯一入口）',
        requires: 'function providerError(',
        old: '\tif (status === 401 || status === 403 || ["authentication_error", "permission_error"].includes(type)) code = "AUTH";\n\telse if (isQuotaExceededError(detail) || status === 402) code = "QUOTA";',
        new: `\tif (status === 403) {
\t\t// ponytail: billing/quota 403s (insufficient balance, 预扣费/剩余额度, new-api
\t\t// insufficient_user_quota) are NOT bad keys; map them to QUOTA so the UI
\t\t// stops reporting "invalid API key" for a healthy key that is out of credit.
\t\tif (${QUOTA_TEST}) code = "QUOTA";
\t\telse code = "AUTH";
\t} else if (status === 401 || ["authentication_error", "permission_error"].includes(type)) code = "AUTH";
\telse if (isQuotaExceededError(detail) || status === 402) code = "QUOTA";`
      },
      {
        what: 'DeepSeekFilesError 403（Files API 分类点，三版本同形）',
        old: '\t\tsuper(message, status === 401 || status === 403 ? "AUTH" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : "FILES_API", { status });',
        new: `\t\t// ponytail: billing/quota 403s (insufficient balance, 预扣费/剩余额度, new-api
\t\t// insufficient_user_quota) are NOT bad keys; map them to QUOTA so the UI
\t\t// stops reporting "invalid API key" for a healthy key that is out of credit.
\t\tconst billingQuota403 = status === 403 && (${QUOTA_TEST});
\t\tsuper(message, status === 401 || status === 403 && !billingQuota403 ? "AUTH" : billingQuota403 ? "QUOTA" : status === 429 ? "RATE_LIMIT" : status >= 500 ? "SERVER" : "FILES_API", { status });`
      }
    ]
  }
]

function fail(msg) {
  console.error(`ensure-quotamisclass-patch: ${msg}`)
  process.exit(1)
}

for (const e of EDITS) {
  if (!existsSync(e.file)) fail(`target not found: ${e.file}`)
  let content
  try { content = readFileSync(e.file, 'utf8') } catch (err) { fail(`cannot read ${e.file}: ${err.message}`) }
  if (content.includes(MARKER)) {
    console.log(`ensure-quotamisclass-patch: OK — patch already present (${e.file})`)
    continue
  }
  if (checkOnly) {
    console.log(`ensure-quotamisclass-patch: MISSING — patch needed (${e.file})`)
    process.exit(1)
  }
  const applied = []
  const skipped = []
  for (const site of e.sites) {
    if (site.requires !== void 0 && !content.includes(site.requires)) {
      skipped.push(`${site.what} — 本版本没有 \`${site.requires}\``)
      continue
    }
    const n = content.split(site.old).length - 1
    if (n !== 1) fail(`anchor not unique (found ${n}) for [${site.what}] in ${e.file} — dsh may have changed layout; review this script`)
    content = content.replace(site.old, site.new)
    applied.push(site.what)
  }
  if (applied.length === 0) fail(`no recognized error-classification site in ${e.file} — dsh may have changed layout; review this script`)
  const patched = content
  try {
    execFileSync(process.execPath, ['--check', e.file], { stdio: 'pipe' })
    // syntax-check the patched content via a temp file (--check reads the file on disk; patch first to temp)
    const os = await import('node:os')
    const { join } = await import('node:path')
    const tmp = join(os.tmpdir(), `dsh-quota-check-${process.pid}.js`)
    writeFileSync(tmp, patched, 'utf8')
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  } catch (err) {
    fail(`syntax check failed: ${err.stderr?.toString().slice(0, 300) || err.message}`)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${e.file}.bak-quotafix-${stamp}`
  try {
    renameSync(e.file, backup)
    writeFileSync(e.file, patched, 'utf8')
  } catch (err) {
    fail(`write failed: ${err.message} (backup kept at ${backup})`)
  }
  console.log(`ensure-quotamisclass-patch: patched ${e.file}\n  sites: ${applied.join('; ')}${skipped.length === 0 ? '' : `\n  skipped: ${skipped.join('; ')}`}\n  backup: ${backup}`)
}
