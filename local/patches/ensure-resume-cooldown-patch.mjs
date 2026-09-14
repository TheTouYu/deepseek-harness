#!/usr/bin/env node
/**
 * dsh resume-cooldown 补丁器 — 失败 resume 被无退避重试导致"空闲实例烧满一核"修复（零依赖，独立运行）。
 *
 * 背景（2026-09-14 实测事故）：某个 Agent 预设挂载失败后，该会话的 resume 必然失败，
 *   而 `resumeObserved` 是**先 composeAgent（整套插件组合挂载）再 agents.resume**，
 *   一次失败就释放并发去重槽位 ⇒ 客户端的每一次重试都要重挂整套组合。
 *   官方 Web UI 对失败的 RPC **无退避重试**：实测 `POST /api/commands/list` 80 req/s、
 *   单次失败代价 0.47 s CPU（重预设）/ 56 ms（轻预设）⇒ 空闲实例
 *   825.1 s CPU / 805 s 墙钟 = 102.5% 一核，持续 13 分钟（同 unit 基线 0.9–4.3%），
 *   且**日志零行**（ctx.logger 在该部署无 sink，终局分支也不打日志）。
 *
 * 修复：同一会话的 resume 失败在 1 秒窗口内**复用同一结论**（不再重挂组合），
 *   窗口内被抑制的重试只计数、折叠进下一次真实失败的报告；成功路径清记录。
 *   `session/not-found` 与 subagent ownership 两类**故意不进闸门**（便宜且可能立即恢复）。
 *
 * 幂等：健康判定**不看注释标记**（与 ensure-v0-tier-compat-patch.mjs 同哲学）——
 *   判据 = 文件里存在 `RESUME_FAILURE_COOLDOWN_MS` + `resumeFailures`，且该模块能被真正 import。
 *   已打过（无论是本脚本还是等价的手工补丁）即 OK。
 *
 * ⚠ 与另外三个补丁器的**唯一一处刻意不同**：本脚本在"上游布局已变、无法安全套用"时
 *   **不返回非 0**（默认），只打印醒目警告并落一个 status 文件 —— 因为 ExecStartPre 非 0
 *   会**阻止 dsh 启动**，而"布局变了"不是我们能盲目修补的状态：可用性优先于补丁。
 *   做闸门用 `--check`（0=健康 / 1=缺失或无法套用），要阻止启动用 `--strict`。
 *
 * 用法：
 *   node ensure-resume-cooldown-patch.mjs                     # 检查并补丁（默认，永不阻止启动）
 *   node ensure-resume-cooldown-patch.mjs --check             # 只检查：0=健康 1=缺失/无法套用
 *   node ensure-resume-cooldown-patch.mjs --target <file>     # 指向副本（测试用）
 *   node ensure-resume-cooldown-patch.mjs --strict            # 无法套用时返回 1
 */
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const strict = args.includes('--strict')
const targetFlag = args.indexOf('--target')
const HOME = process.env.HOME

const TARGET = targetFlag >= 0 ? args[targetFlag + 1]
  : `${HOME}/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`

/** 本补丁器的标记（只用于标识"是这份脚本打的"；健康判定不依赖它）。 */
const MARKER = '// ponytail: resume-failure cooldown'
/** 行为签名：健康判定看这两个标识 + 真 import。 */
const SIGNATURES = ['RESUME_FAILURE_COOLDOWN_MS', 'resumeFailures']
const STATUS_FILE = '/var/tmp/dsh-resume-cooldown-patch.status'

const COOLDOWN_BLOCK = `/**
 * 失败重试闸门（ponytail patch，2026-09-14）：同一会话的 resume 失败在 1s 窗口内复用
 * 同一结论，不再重挂整套 Agent 预设（resumeObserved 先 composeAgent 再 agents.resume）。
 * 事故读数：客户端 80 req/s 无退避重试 × 单次失败 0.47s CPU ⇒ 空闲实例 102.5% 一核 13 分钟。
 */
const RESUME_FAILURE_COOLDOWN_MS = 1000;
`

const EDITS = [
  {
    what: '常量 + 失败记录表字段',
    old: '/** Owns every operation that may create, resume, or configure a Web Agent. */\n'
      + 'var ApiSessionAgentController = class {\n'
      + '\tctx;\n'
      + '\tresumes = /* @__PURE__ */ new Map();',
    new: COOLDOWN_BLOCK
      + '/** Owns every operation that may create, resume, or configure a Web Agent. */\n'
      + 'var ApiSessionAgentController = class {\n'
      + '\tctx;\n'
      + '\tresumes = /* @__PURE__ */ new Map();\n'
      + '\t' + MARKER + ': sessionId → { message, at, suppressed }\n'
      + '\tresumeFailures = /* @__PURE__ */ new Map();',
  },
  {
    what: 'resolve() 窗口内复用失败结论',
    old: '\t\tif (attached !== void 0 && hasApiSessionSubagentOwner(this.ctx, attached, void 0)) return { error: apiSessionSubagentOwnershipError(sessionId) };\n'
      + '\t\tlet resume = this.resumes.get(sessionId);',
    new: '\t\tif (attached !== void 0 && hasApiSessionSubagentOwner(this.ctx, attached, void 0)) return { error: apiSessionSubagentOwnershipError(sessionId) };\n'
      + '\t\t// ' + MARKER + '\n'
      + '\t\tconst recentFailure = this.resumeFailures.get(sessionId);\n'
      + '\t\tif (recentFailure !== void 0 && Date.now() - recentFailure.at < RESUME_FAILURE_COOLDOWN_MS) {\n'
      + '\t\t\trecentFailure.suppressed += 1;\n'
      + '\t\t\treturn { error: new RemoteError("gateway/internal", recentFailure.message, {}) };\n'
      + '\t\t}\n'
      + '\t\tlet resume = this.resumes.get(sessionId);',
  },
  {
    what: '成功路径清记录',
    old: '\t\ttry {\n\t\t\treturn { agent: await resume };\n\t\t} catch (error) {',
    new: '\t\ttry {\n'
      + '\t\t\tconst agent = await resume;\n'
      + '\t\t\tthis.resumeFailures.delete(sessionId);\n'
      + '\t\t\treturn { agent };\n'
      + '\t\t} catch (error) {',
  },
  {
    what: '终局失败：记录 + 赋名（logger + console.error 双通道）',
    old: '\t\t\treturn { error: new RemoteError("gateway/internal", `resume failed for session "${sessionId}": ${String(error)}`, {}) };',
    new: '\t\t\tconst message = `resume failed for session "${sessionId}": ${String(error)}`;\n'
      + '\t\t\tconst previous = this.resumeFailures.get(sessionId);\n'
      + '\t\t\tthis.resumeFailures.set(sessionId, { message, at: Date.now(), suppressed: 0 });\n'
      + '\t\t\t// ' + MARKER + ' — 失败必须被赋名（事故里 13 分钟 100% CPU 而日志零行）：\n'
      + '\t\t\t// ctx.logger 的 sink 取决于 profile（实测 sbx profile 无 sink），console.error 一定能到进程输出。\n'
      + '\t\t\tconst line = `[session-controller] ${message}` + (previous === void 0 ? "" : ` (${previous.suppressed} retried inside the previous cooldown)`);\n'
      + '\t\t\tthis.ctx.logger?.warn?.(line);\n'
      + '\t\t\tconsole.error(line);\n'
      + '\t\t\treturn { error: new RemoteError("gateway/internal", message, {}) };',
  },
]

function note(text) {
  try { writeFileSync(STATUS_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8') } catch { /* 状态文件写不了不影响判定 */ }
}
function clearNote() {
  try { rmSync(STATUS_FILE, { force: true }) } catch { /* 同上 */ }
}
/** 无法安全套用：默认放行启动（可用性优先），--strict 才返回 1。 */
function cannotApply(msg) {
  console.error(`ensure-resume-cooldown-patch: STALE — ${msg}`)
  note(msg)
  process.exit(strict ? 1 : 0)
}
function fail(msg) {
  console.error(`ensure-resume-cooldown-patch: ${msg}`)
  process.exit(1)
}

/** 真判定：行为签名在位 + 该模块能被真正 import（能挡住"文件被写坏"这类假健康）。
 *  返回 'ok' | 'unknown'（探针不可达，例如对副本跑：依赖解析不到，不代表内容坏）| false。 */
function healthy(content, file) {
  if (!SIGNATURES.every(s => content.includes(s))) return false
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch {
    return false // 语法不过 = 内容坏了
  }
  try {
    execFileSync(process.execPath, ['-e', `import(${JSON.stringify('file://' + file)}).then(() => process.exit(0), (e) => { console.error(String(e)); process.exit(3) })`], { stdio: 'pipe', timeout: 60_000 })
    return 'ok'
  } catch (err) {
    const detail = String(err.stderr ?? err.message ?? '')
    // 副本路径/无 node_modules 时依赖解析不到 —— 探针不可达，不能据此判"损坏"。
    if (/Cannot find package|ERR_MODULE_NOT_FOUND|Cannot find module/i.test(detail)) return 'unknown'
    console.error(`ensure-resume-cooldown-patch: import 探针失败：${detail.slice(0, 300)}`)
    return false
  }
}

if (!existsSync(TARGET)) cannotApply(`target not found: ${TARGET}（dsh 目录布局变了？）`)
let content
try { content = readFileSync(TARGET, 'utf8') } catch (err) { cannotApply(`cannot read ${TARGET}: ${err.message}`) }

const verdict = healthy(content, TARGET)
if (verdict === 'ok' || verdict === 'unknown') {
  console.log(`ensure-resume-cooldown-patch: OK — resume 失败闸门在位（签名 + ${verdict === 'ok' ? '真 import' : '语法（探针不可达，例如对副本运行）'} 双验） (${TARGET})`)
  clearNote()
  process.exit(0)
}
if (checkOnly) {
  console.log(`ensure-resume-cooldown-patch: MISSING — 需要补丁 (${TARGET})`)
  process.exit(1)
}

let patched = content
for (const edit of EDITS) {
  const n = patched.split(edit.old).length - 1
  if (n !== 1) cannotApply(`anchor not unique (found ${n}) for [${edit.what}] — dsh 换版后布局变了；先人工核对再改本脚本`)
  patched = patched.replace(edit.old, edit.new)
}
// 写盘前先语法预检（--check 读盘上的文件，故先落到临时文件验）
const tmp = join(tmpdir(), `dsh-resume-cooldown-${process.pid}.js`)
try {
  writeFileSync(tmp, patched, 'utf8')
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
} catch (err) {
  cannotApply(`syntax check failed: ${err.stderr?.toString().slice(0, 300) || err.message}`)
} finally {
  try { rmSync(tmp, { force: true }) } catch { /* 尽力清理 */ }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${TARGET}.bak-resumecool-${stamp}`
try {
  renameSync(TARGET, backup)
  writeFileSync(TARGET, patched, 'utf8')
} catch (err) {
  fail(`write failed: ${err.message} (backup kept at ${backup})`)
}
const after = healthy(readFileSync(TARGET, 'utf8'), TARGET)
if (after === false) fail('补丁写入后自检未通过 —— 请恢复备份')
clearNote()
console.log(`ensure-resume-cooldown-patch: patched ${TARGET}\n  backup: ${backup}`)
