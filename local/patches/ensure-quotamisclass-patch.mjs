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

const EDITS = [
  {
    file: `${base}/dsh-llm-pi-ai/lib/index.js`,
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
  },
  {
    file: `${base}/dsh-llm-deepseek/lib/index.js`,
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
  const n = content.split(e.old).length - 1
  if (n !== 1) fail(`anchor not unique (found ${n}) in ${e.file} — dsh may have changed layout; review this script`)
  const patched = content.replace(e.old, e.new)
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
  console.log(`ensure-quotamisclass-patch: patched ${e.file}\n  backup: ${backup}`)
}
