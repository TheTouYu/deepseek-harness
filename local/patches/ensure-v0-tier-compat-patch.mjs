#!/usr/bin/env node
/**
 * dsh v0-session "extended compaction/summary" 兼容补丁器
 *
 * 背景（2026-09-11 升级 dsh → 0.1.5-rc.2 后报错）：
 *   历史会话加载失败：
 *     failed to observe session "session-…": @deepseek-ai/dsh-session-format-v0-to-v1
 *     refuses this format v0 Session: compaction/summary <seq> data has unexpected member "tier";
 *     source v0 artifact remains unchanged
 *
 * 根因：v0→v1 迁移器用一张冻结的「已发布成员清单」严格校验事件负载
 *   （dsh-session-format-v0-to-v1/lib/index.js → RELEASED_V0_EVENT_DISPOSITIONS）。
 *   compaction/summary 只承认 7 个必备 + 5 个可选成员，而本机历史会话由带 ACP
 *   （billion-context-dsh 内核块压缩）的构建写入，额外携带 7 个成员：
 *     tier / kernelBlockId / topic / parentBlockIds /
 *     directMessageIds / effectiveMessageIds / verifiedReadings
 *   官方迁移器因此一律拒收，导致这些会话打不开（本机 542 个 v0 日志全中）。
 *
 * ⚠ 关键：必须补进【第二个参数 optional】，不能补进第三个参数 opaque。
 *   assertReleasedV0Keys 只把 required ∪ optional 当作合法成员集合
 *   （lib/index.js:271-277）；opaque 仅用于校验「该成员是合法无损 JSON」，
 *   并不授予成员资格。
 *
 * 语义：optional 成员原样保留（v1→v2 用 ...data 透传，v2→v3 只逐字段改写它自己
 *   关心的成员），所以历史数据不丢，只是不再被判为「未知成员」。
 *
 * 健康判定 = 【跑一遍真校验器】，不看注释标记：
 *   在子进程里 import 目标模块，构造一条带全 7 个 ACP 成员的 compaction/summary
 *   负载，调用 assertReleasedEventPayload(event, 0)；不抛 = 已修好。
 *   （注释/文案会被人手改，行为不会。）
 *
 * 幂等：已健康则跳过；dsh 升级覆盖后自动重打；打完再验证一次，验证不过回滚。
 * 接入：dsh-web.service 的 ExecStartPre（与 ensure-connstuck-patch.mjs 并列）。
 *
 * 用法：
 *   node ensure-v0-tier-compat-patch.mjs           # 检查并补丁（默认）
 *   node ensure-v0-tier-compat-patch.mjs --check   # 只检查（0=健康 1=需补丁）
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checkOnly = process.argv.slice(2).includes('--check')
const HOME = process.env.HOME
const FILE = `${HOME}/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js`

// 原样锚点：compaction/summary 的冻结成员清单（升级后重新下载的原始形态）。
const OLD = `\t"compaction/summary": disposition([
\t\t"compactionId",
\t\t"summary",
\t\t"shadowedRange",
\t\t"shadowedSeqs",
\t\t"shadowedTokenCount",
\t\t"provider",
\t\t"model"
\t], [
\t\t"sourceCommandId",
\t\t"maxTokens",
\t\t"usage",
\t\t"rawOutput",
\t\t"llmStreamCall"
\t]),`

const NEW = `\t"compaction/summary": disposition([
\t\t"compactionId",
\t\t"summary",
\t\t"shadowedRange",
\t\t"shadowedSeqs",
\t\t"shadowedTokenCount",
\t\t"provider",
\t\t"model"
\t], [
\t\t"sourceCommandId",
\t\t"maxTokens",
\t\t"usage",
\t\t"rawOutput",
\t\t"llmStreamCall",
\t\t// ponytail: v0 extended compaction/summary members — sessions written by the
\t\t// ACP (billion-context-dsh kernel-block compaction) build carry these seven
\t\t// members; the frozen released-v0 inventory never learned them, so every such
\t\t// session failed to load ("data has unexpected member \\"tier\\""). They must be
\t\t// admitted as OPTIONAL (the admissible set is required ∪ optional; the opaque
\t\t// slot does not grant membership) and are preserved losslessly by the identity
\t\t// edge with no nested interpretation.
\t\t"tier",
\t\t"kernelBlockId",
\t\t"topic",
\t\t"parentBlockIds",
\t\t"directMessageIds",
\t\t"effectiveMessageIds",
\t\t"verifiedReadings"
\t]),`

/** 真校验器探针：全 7 个 ACP 成员必须被承认为合法成员。 */
const PROBE = `
const V0 = await import(${JSON.stringify(FILE)})
const data = {
  compactionId: 'probe', summary: [{ type: 'text', text: 'x' }],
  shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1,
  provider: 'probe', model: 'probe',
  tier: 1, kernelBlockId: 'b1', topic: 't', parentBlockIds: ['c0'],
  directMessageIds: ['m1'], effectiveMessageIds: ['m1'], verifiedReadings: ['r'],
}
V0.assertReleasedEventPayload({ type: 'compaction/summary', seq: 1, data }, 0)
console.log('probe-ok')
`

let probeError = ''

/** 通过真校验器判定当前文件是否已修好。 */
function healthy() {
  probeError = ''
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], { stdio: 'pipe' })
    return true
  } catch (err) {
    const lines = (err.stderr?.toString() || err.message).split('\n').map((line) => line.trim()).filter(Boolean)
    const message = lines.find((line) => /^(?:[A-Za-z]*Error|SessionFormatError)/.test(line) || /Error:/.test(line))
    probeError = (message ?? lines.slice(-2).join(' ')).slice(0, 300)
    return false
  }
}

function fail(msg) {
  console.error(`ensure-v0-tier-compat-patch: ${msg}`)
  process.exit(1)
}

if (!existsSync(FILE)) fail(`target not found: ${FILE}`)

if (healthy()) {
  console.log(`ensure-v0-tier-compat-patch: OK — ACP member set accepted (verified by probe) (${FILE})`)
  process.exit(0)
}

if (checkOnly) {
  console.log(`ensure-v0-tier-compat-patch: MISSING — patch needed (${FILE})\n  probe said: ${probeError}`)
  process.exit(1)
}

let content
try {
  content = readFileSync(FILE, 'utf8')
} catch (err) {
  fail(`cannot read ${FILE}: ${err.message}`)
}

const occurrences = content.split(OLD).length - 1
if (occurrences !== 1) {
  fail(
    `anchor not unique (found ${occurrences}) in ${FILE} — dsh may have changed the disposition layout; review this script\n  probe said: ${probeError}`,
  )
}

const patched = content.replace(OLD, NEW)

// Syntax-check the patched content from a temp file before touching the real one.
const tmp = join(tmpdir(), `dsh-v0tier-check-${process.pid}.mjs`)
try {
  writeFileSync(tmp, patched, 'utf8')
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
} catch (err) {
  fail(`syntax check failed: ${err.stderr?.toString().slice(0, 400) || err.message}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${FILE}.bak-v0tier-${stamp}`
try {
  renameSync(FILE, backup)
  writeFileSync(FILE, patched, 'utf8')
} catch (err) {
  fail(`write failed: ${err.message} (backup kept at ${backup})`)
}

// 写完必须再跑一遍真校验器；不过就回滚，绝不让 dsh 带着半吊子补丁启动。
if (!healthy()) {
  try {
    renameSync(backup, FILE)
  } catch (restoreError) {
    fail(`post-patch probe failed (${probeError}) and rollback failed: ${restoreError.message} (backup: ${backup})`)
  }
  fail(`post-patch probe failed: ${probeError} — rolled back to the original file`)
}

console.log(`ensure-v0-tier-compat-patch: patched ${FILE}\n  verified by probe\n  backup: ${backup}`)
