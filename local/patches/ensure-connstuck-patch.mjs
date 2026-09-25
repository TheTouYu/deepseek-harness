#!/usr/bin/env node
/**
 * dsh-connstuck 补丁器 — 网络波动后 deepseek-official 重连卡死修复（零依赖，独立运行）。
 *
 * 背景：dsh-llm-deepseek（deepseek-official 适配器）所有出站请求走 undici 全局
 * keep-alive 连接池。一次网络抖动会让池里留下"半死" socket；此后每次重试都复用
 * 该 socket，请求发出后一个字节都收不到，直到 300s idle watchdog 掐断，重试又
 * 复用同一条死连接 → 永远卡死（外部新连接一切正常）。
 *
 * 修复（v2）：把所有出站请求改为每次全新连接（`agent: false` + 10s connect 超时），
 * 死连接不可能跨请求存活，网络恢复后下一次重试即成功。
 *
 * v1 回归（2026-09-08 定位）：v1 虽然自己发起 httpsRequest，却漏了 `agent: false`，
 * 仍复用 Node 全局 keep-alive 池。复用 socket 的 'connect' 事件早已触发，那个 10s
 * connect 超时定时器永远等不到清除 → 10s 后 `req.destroy()` 把正在读的响应体砍断。
 * 表现：思考/输出超过 ~10s 的请求必现 TRANSPORT（"DeepSeek API stream from ... failed"），
 * 短请求一切正常——所以看起来像"思考久一点就误报错"。v2 补上 `agent: false`，
 * 并加 `if (socket.connecting === false) return` 防御（已连接的 socket 没有连接超时可言）。
 *
 * v2 回归（2026-09-08 定位，真正的首凶）：v1/v2 的插入文本把
 * `import { brandString } from "@deepseek-ai/dsh-brand";` 整行替换掉了（它恰好是 anchor
 * 的一部分）。translate 生成 tool-call-delta 时调 brandString → ReferenceError → 被包成
 * TRANSPORT。表现：每次模型**开始调用工具**就报错（与思考时长无关，与上下文无关），
 * 日志里能看到 `ReferenceError: brandString is not defined`。v3 把 import 补回来。
 *
 * 锚点适配（2026-09-25，dsh 0.1.7-rc.2）：rc.2 删掉了 Chat Completions 端点，唯一出站
 * fetch 变成 `${messagesApiRoot(baseURL)}/messages`，import 头里的 brandString 也换成
 * getOrCreateAnonymousUserId。锚点因此改为**多版本变体**：老变体原样保留（live 0.1.5-rc.2
 * 与本机 0.1.6 重装后仍能重打），新增 rc.2 变体覆盖这个新的唯一调用点。注入文本与
 * helper 未变，MARKER 仍是 v3。
 *
 * 幂等：目标文件已含补丁标记（v3）则直接退出（0）；检测到 v1/v2 产物则按 REPAIRS
 * 清单就地补齐（缺 brandString import / agent: false / connecting 守卫），marker 归一为
 * v3；dsh 升级覆盖 node_modules 后，下次运行本脚本会自动重打。接入 dsh-web.service 的
 * ExecStartPre，每次重启都自动保证补丁在场。
 *
 * 用法：
 *   node ensure-connstuck-patch.mjs            # 检查并补丁（默认）
 *   node ensure-connstuck-patch.mjs --check    # 只检查不写（0=健康/v3 在场 1=需补丁或待修复）
 *   node ensure-connstuck-patch.mjs --target <path>   # 指定目标文件（测试用）
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const targetFlag = args.indexOf('--target')
const TARGET = targetFlag >= 0 ? args[targetFlag + 1]
  : `${process.env.HOME}/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`

const MARKER = '// ponytail: keep-alive pool reuse fix. v3'
const LEGACY_MARKER = '// ponytail: keep-alive pool reuse fix.'
/**
 * 已打补丁产物的就地修复清单：按「缺失特征 + 唯一 anchor」逐项补齐，不依赖版本号。
 * - brandString import：v1/v2 的插入文本把它整行替换掉了 → translate 生成
 *   tool-call-delta 时 ReferenceError，每次模型开始调用工具就 TRANSPORT（真凶）。
 * - agent: false：v1 仍复用 keep-alive 池。
 * - socket.connecting 守卫：已连接的 socket 不该再挂 connect 超时定时器。
 */
const REPAIRS = [
  {
    what: 'brandString import',
    missing: 'import { brandString } from "@deepseek-ai/dsh-brand";',
    old: 'import { EventSourceParserStream } from "eventsource-parser/stream";\nimport { request as httpsRequest } from "node:https";',
    new: 'import { EventSourceParserStream } from "eventsource-parser/stream";\nimport { brandString } from "@deepseek-ai/dsh-brand";\nimport { request as httpsRequest } from "node:https";'
  },
  {
    what: 'agent: false',
    missing: 'agent: false',
    old: '\t\t\theaders\n\t\t}, (res) => {',
    new: '\t\t\theaders,\n\t\t\tagent: false\n\t\t}, (res) => {'
  },
  {
    what: 'socket.connecting guard',
    missing: 'if (socket.connecting === false) return;',
    old: '\t\treq.on("socket", (socket) => {\n\t\t\tconst timer =',
    new: '\t\treq.on("socket", (socket) => {\n\t\t\tif (socket.connecting === false) return;\n\t\t\tconst timer ='
  }
]

/**
 * 注入文本拆两段：`IMPORT_TAIL` + `FRESH_FETCH_HELPER`，两个 import 变体共用尾部。
 * ≤0.1.6 变体的产物必须与历史补丁逐字节一致（live 0.1.5-rc.2 已打过，只有重装才重跑）。
 */
const IMPORT_TAIL = 'import { request as httpsRequest } from "node:https";\nimport { Readable } from "node:stream";\n'
const FRESH_FETCH_HELPER = `// ponytail: keep-alive pool reuse fix. v3. The undici global fetch pool can keep
// half-dead sockets across a network blip; every retry then reuses the dead
// socket and hangs until the idle watchdog fires, forever. Each DeepSeek
// request therefore opens a fresh connection (agent: false, connect timeout
// 10s) so a blip can never wedge the provider. v1 forgot agent: false, so it
// still shared Node's global keep-alive pool: the reused socket's 'connect' had
// already fired, the 10s timer never cleared, and req.destroy() cut every
// stream older than 10s. Ceiling: one TLS handshake per request; no env proxy
// support here; dsh runs proxy-free. Revisit if proxies become needed.
function freshConnectionFetch(url, init = {}) {
\treturn new Promise((resolve, reject) => {
\t\tconst target = new URL(url);
\t\tconst headers = {};
\t\tif (init.headers !== void 0) {
\t\t\tconst entries = init.headers instanceof Headers ? init.headers.entries() : Object.entries(init.headers);
\t\t\tfor (const [k, v] of entries) if (v !== void 0) headers[k] = String(v);
\t\t}
\t\tconst req = httpsRequest({
\t\t\thostname: target.hostname,
\t\t\tport: target.port === "" ? 443 : Number(target.port),
\t\t\tpath: target.pathname + target.search,
\t\t\tmethod: init.method ?? "GET",
\t\t\theaders,
\t\t\tagent: false
\t\t}, (res) => {
\t\t\tconst readText = async () => {
\t\t\t\tlet out = "";
\t\t\t\tfor await (const chunk of res) out += chunk;
\t\t\t\treturn out;
\t\t\t};
\t\t\tresolve({
\t\t\t\tok: res.statusCode >= 200 && res.statusCode < 300,
\t\t\t\tstatus: res.statusCode,
\t\t\t\theaders: new Headers(res.headers),
\t\t\t\tbody: Readable.toWeb(res),
\t\t\t\ttext: readText,
\t\t\t\tjson: async () => JSON.parse(await readText())
\t\t\t});
\t\t});
\t\treq.on("error", reject);
\t\tconst abort = () => req.destroy(new Error("The operation was aborted"));
\t\tif (init.signal !== void 0) {
\t\t\tif (init.signal.aborted) {
\t\t\t\tabort();
\t\t\t\treturn;
\t\t\t}
\t\t\tinit.signal.addEventListener("abort", abort, { once: true });
\t\t}
\t\treq.on("socket", (socket) => {
\t\t\tif (socket.connecting === false) return;
\t\t\tconst timer = setTimeout(() => req.destroy(new Error("connect timeout after 10000ms")), 1e4);
\t\t\tsocket.once("connect", () => clearTimeout(timer));
\t\t});
\t\treq.end(init.body);
\t});
}
`

/** 「保留原 import 头，追加 IMPORT_TAIL + helper」——两个版本变体共用注入正文。 */
function injectAfter(head) {
  return { old: head, new: `${head}\n${IMPORT_TAIL}${FRESH_FETCH_HELPER}` }
}

/**
 * 版本变体锚点（2026-09-25 增补 0.1.7-rc.2）。每个 edit 的 variants 里，
 * **恰好一个变体必须在文件里恰好命中一次**：0 命中 = 上游布局变了（fail，阻止启动），
 * 2 命中 = 只会改一处、留下半补丁（同样 fail）。老变体一律保留，live 0.1.5-rc.2
 * 与本机 0.1.6 仍可重打。
 *
 * rc.2 的差异（已核对 pristine 产物）：
 * - import 头：`brandString` 整包消失，改为 next 行的 `getOrCreateAnonymousUserId`；
 * - 出站调用点：Chat Completions 端点被删除（`chat/completions` 全产物 0 命中），
 *   唯一 fetch 变成 `${messagesApiRoot(connection.baseURL)}/messages`。
 */
const EDITS = [
  {
    what: 'import 头 + freshConnectionFetch 注入',
    variants: [
      injectAfter('import { EventSourceParserStream } from "eventsource-parser/stream";\nimport { brandString } from "@deepseek-ai/dsh-brand";'),
      injectAfter('import { EventSourceParserStream } from "eventsource-parser/stream";\nimport { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";')
    ]
  },
  {
    what: 'fetchImpl → freshConnectionFetch',
    variants: [
      { old: 'this.fetchImpl = options.fetch ?? globalThis.fetch;', new: 'this.fetchImpl = options.fetch ?? freshConnectionFetch;' }
    ]
  },
  {
    what: '出站 fetch 调用点 → freshConnectionFetch',
    variants: [
      {
        old: 'response = await fetch(`${connection.baseURL}/chat/completions`, {',
        new: 'response = await freshConnectionFetch(`${connection.baseURL}/chat/completions`, {'
      },
      {
        old: 'response = await fetch(`${messagesApiRoot(connection.baseURL)}/messages`, {',
        new: 'response = await freshConnectionFetch(`${messagesApiRoot(connection.baseURL)}/messages`, {'
      }
    ]
  }
]

/**
 * 选出该 edit 在本文件里唯一命中的变体。
 * @param content - 待补丁的产物全文。
 * @param edit - `{ what, variants }`。
 * @returns 命中的 `{ old, new }`。
 */
function pickVariant(content, edit) {
  const hits = edit.variants.map((v) => ({ v, n: content.split(v.old).length - 1 }))
  const matched = hits.filter((h) => h.n > 0)
  if (matched.length !== 1 || matched[0].n !== 1) {
    const detail = hits.map((h) => `${h.n}× ${JSON.stringify(h.v.old.slice(0, 70))}`).join(' | ')
    fail(`anchor not unique (found ${matched.length === 1 ? matched[0].n : 0}) for [${edit.what}] — variant hits: ${detail} — dsh may have changed layout; review and update this script`)
  }
  return matched[0].v
}

function fail(msg) {
  console.error(`ensure-connstuck-patch: ${msg}`)
  process.exit(1)
}

if (!existsSync(TARGET)) fail(`target not found: ${TARGET}`)
let content
try {
  content = readFileSync(TARGET, 'utf8')
} catch (e) {
  fail(`cannot read target: ${e.message}`)
}

if (content.includes(MARKER)) {
  console.log(`ensure-connstuck-patch: OK — patch already present (${TARGET})`)
  process.exit(0)
}

// 旧版本补丁（v1/v2）就地修复：缺什么补什么，再把 marker 归一为 v3。
if (content.includes(LEGACY_MARKER)) {
  const missing = REPAIRS.filter(r => !content.includes(r.missing))
  if (checkOnly) {
    console.log(`ensure-connstuck-patch: STALE — legacy patch present, repairs needed: ${missing.map(r => r.what).join(', ') || '(marker only)'} (${TARGET})`)
    process.exit(1)
  }
  for (const r of missing) {
    const n = content.split(r.old).length - 1
    if (n !== 1) fail(`repair anchor not unique (found ${n}) for ${r.what} — review and update this script`)
    content = content.replace(r.old, r.new)
  }
  const markerV2 = '// ponytail: keep-alive pool reuse fix. v2. The undici'
  const markerV1 = '// ponytail: keep-alive pool reuse fix. The undici'
  const markerV3 = '// ponytail: keep-alive pool reuse fix. v3. The undici'
  if (content.includes(markerV2)) content = content.replace(markerV2, markerV3)
  else if (content.includes(markerV1)) content = content.replace(markerV1, markerV3)
  else fail('legacy marker comment line not found verbatim')
  writePatched(content, `upgraded legacy patch → v3 (${missing.map(r => r.what).join(', ') || 'marker only'})`)
  process.exit(0)
}

if (checkOnly) {
  console.log(`ensure-connstuck-patch: MISSING — patch needed (${TARGET})`)
  process.exit(1)
}

// 应用前先为每个 edit 选出唯一命中的版本变体；全部选完再落盘，避免半补丁。
const chosen = EDITS.map((e) => ({ e, v: pickVariant(content, e) }))
for (const { v } of chosen) content = content.replace(v.old, v.new)
writePatched(content, `patched (${chosen.map(({ e }) => e.what).join('; ')})`)

/** 备份 + 写入 + 语法校验（失败回滚到备份）。 */
function writePatched(next, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${TARGET}.bak-connstuckfix-${stamp}`
  try {
    renameSync(TARGET, backup)
    writeFileSync(TARGET, next, 'utf8')
  } catch (e) {
    fail(`write failed: ${e.message} (backup kept at ${backup})`)
  }
  try {
    execFileSync(process.execPath, ['--check', TARGET], { stdio: 'pipe' })
  } catch (e) {
    try { renameSync(backup, TARGET) } catch { /* 回滚尽力而为 */ }
    fail(`syntax check failed after ${label}, rolled back: ${e.stderr?.toString().slice(0, 300) || e.message}`)
  }
  console.log(`ensure-connstuck-patch: ${label} → ${TARGET}\n  backup: ${backup}`)
}
