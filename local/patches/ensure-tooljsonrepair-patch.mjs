#!/usr/bin/env node
/**
 * dsh-tooljson-repair 补丁器 — 工具入参漏转义双引号不再判死整个 turn（零依赖，独立运行）。
 *
 * 背景（2026-10-14 生产事故 / 2026-09 旧案同族，统计见记忆河 D119/D120/D122）：
 * 模型偶发在 tool_use 的 partial_json 里漏转义内层引号（如 {"command":"echo "hi""}）。
 * 0.1.5 的主循环 parseArguments 容忍非法 JSON（catch 后透传原文，让工具自己报错、模型自纠）；
 * 0.1.7 起的 Messages 适配器在 message_stop 抢先预校验，直接抛
 * MALFORMED_RESPONSE（"DeepSeek Messages stream: tool input is invalid JSON"）⇒ 整个 turn 判死。
 * 宿主全史实测发生率 ≈ 1/3500 次工具调用（39/139,329），但一次即打断会话。
 *
 * 修复（内容级，与 retryPolicy 兜底互补）：在 tool-call 块收口处（block-end 快照之前）
 * 改调 repairToolCallJson() —— 错误位置驱动的迭代修复，收窄到「字符串提前闭合、丢了一个
 * 转义反斜杠」这一类，每步都要 V8 自己确认（详见注入代码里的口径注释）；上限 8 轮。
 * 任一条不满足 → **原样返回**（绝不输出未验证的猜测结果），下游照旧抛 MALFORMED_RESPONSE，
 * 交给 provider retryPolicy 兜底重发。
 * 无损伤：合法 JSON 首次 parse 即返回，逐字节恒等（构造上恒等，另有验收脚本逐案断言）。
 *
 * 为什么打在这里：源码是 `block.content.arguments = block.json`（content_block_stop 收口），
 * 而 block-end 事件带的是 `{...block.content}` 快照，下游 dsh-llm 的 BlockAssembler.push
 * 又优先用该快照（压过逐片累积的 tool-call-delta）——在 message_stop 处再改已经晚了。
 *
 * 用法：
 *   node ensure-tooljsonrepair-patch.mjs [--check] [--root <dsh安装根>]
 *     --check  只诊断不打（0=健康 / 1=需打或 STALE / 2=目标不存在）
 *     --root   缺省 $DSH_INSTALL_ROOT 或 ~/.local/lib/node_modules/@deepseek-ai/dsh
 *
 * 注意：上游源码同构病仍在 fork 的 packages/llm/llm-deepseek/src/translate.ts（message_stop
 * 的预校验）；本补丁只覆盖**安装树产物**（真正在跑的那份），走上游通道需另开。
 * 三层验收脚本见 README「2026-10-14 新增第 7 个补丁器」节。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const check = args.includes('--check')
const rootIdx = args.indexOf('--root')
const ROOT = rootIdx >= 0 ? args[rootIdx + 1]
  : process.env.DSH_INSTALL_ROOT ?? join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh')

const TARGET = join(ROOT, 'node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js')
const MARKER = '// ponytail: tooljson-unescaped-quote-repair'

// —— 注入点 1：translate() 收口前挂修复器（function deltaChunk 之前，同 region）——
const ANCHOR_INSERT = 'function deltaChunk(block, raw) {'
const HELPER = `${MARKER}
// 模型漏转义内层引号 ⇒ message_stop 预校验判死 turn（0.1.5 是容忍原文让工具报错，属行为回归）。
// 错误位置驱动的迭代修复：parse 失败 → V8 的 "at position N" → 往回跳空白找最近未转义 " → 转义 → 重 parse。
// 刻意收窄到「字符串提前闭合、丢了一个转义反斜杠」这一类，且每一步都要 V8 自己确认：
//   · 只在报错为 "Expected ',' or '}' after property value" 时动手。**数组**漏逗号报的是
//     "after array element"，不同类 ⇒ 直接被排除（否则会把 ["a" "b"] 悄悄并成一个元素）；
//   · 报错位置的字符是引号时，只在这条引号连闭合引号都没有（不可能是新成员键）时才断定
//     「前面的引号才是漏转义的那个」；有闭合引号就语义不明（漏逗号/漏冒号都可能）⇒ 不猜；
//   · 候选引号必须未被转义（前面反斜杠个数为偶）。
// 任一条不满足、或 8 轮内仍不合法 ⇒ 原样返回，下游照旧抛 MALFORMED_RESPONSE，由 provider
// retryPolicy（retryableCodes 里的 MALFORMED_RESPONSE）兜底重发 —— 绝不把猜出来的参数交给工具。
// 合法 JSON 首次 parse 即返回原文，逐字节恒等（构造上恒等，另有验收脚本逐案断言）。
function repairToolCallJson(raw) {
\tif (typeof raw !== "string" || raw.length === 0) return raw;
\tlet text = raw;
\tlet error;
\ttry {
\t\tJSON.parse(text);
\t\treturn text;
\t} catch (firstParseError) {
\t\terror = firstParseError;
\t}
\tfor (let round = 1; round <= 8; round++) {
\t\tconst at = /^Expected ',' or '}' after property value in JSON at position (\\d+)/.exec(String(error?.message ?? ""));
\t\tif (at === null) return raw;
\t\tconst pos = Number(at[1]);
\t\tif (!(pos > 0 && pos < text.length)) return raw;
\t\tif (text[pos] === "\\"") {
\t\t\tlet closing = pos + 1;
\t\t\twhile (closing < text.length && text[closing] !== "\\"") {
\t\t\t\tif (text[closing] === "\\\\") closing++;
\t\t\t\tclosing++;
\t\t\t}
\t\t\tif (closing < text.length) return raw;
\t\t}
\t\tlet q = pos - 1;
\t\twhile (q >= 0 && /\\s/.test(text[q])) q--;
\t\tif (q < 0 || text[q] !== "\\"") return raw;
\t\tlet backslashes = 0;
\t\tfor (let k = q - 1; k >= 0 && text[k] === "\\\\"; k--) backslashes++;
\t\tif (backslashes % 2 === 1) return raw;
\t\ttext = \`\${text.slice(0, q)}\\\\\${text.slice(q)}\`;
\t\ttry {
\t\t\tJSON.parse(text);
\t\t\tconsole.warn(\`[tooljson-repair] escaped \${round} unescaped quote(s) in tool arguments; payload now parses (\${raw.length} chars)\`);
\t\t\treturn text;
\t\t} catch (nextParseError) {
\t\t\terror = nextParseError;
\t\t}
\t}
\treturn raw;
}
${ANCHOR_INSERT}`

// —— 注入点 2：收口处改调修复器（原本是裸 block.json）——
const ANCHOR_CALL = 'if (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = block.json;'
const CALL_PATCHED = 'if (block.content.type === "tool-call" && block.json.length > 0) block.content.arguments = repairToolCallJson(block.json);'

if (!existsSync(TARGET)) {
  console.log(`ensure-tooljsonrepair-patch: target not found: ${TARGET}（dsh 目录布局变了？）`)
  process.exit(2)
}
const text = readFileSync(TARGET, 'utf8')

if (text.includes(MARKER)) {
  // marker 在也要验两个注入点都在位（防半打/被手改坏）
  const helperOk = text.includes('function repairToolCallJson(raw) {')
  const callOk = text.includes(CALL_PATCHED)
  if (helperOk && callOk) {
    console.log(check ? 'ensure-tooljsonrepair-patch: OK (already patched)' : 'ensure-tooljsonrepair-patch: OK')
    process.exit(0)
  }
  console.log(`ensure-tooljsonrepair-patch: STALE — marker 在但注入点不全 (helper=${helperOk} call=${callOk})：${TARGET}`)
  process.exit(1)
}

if (!text.includes(ANCHOR_INSERT) || !text.includes(ANCHOR_CALL)) {
  console.log(`ensure-tooljsonrepair-patch: STALE — 锚点未命中（insert=${text.includes(ANCHOR_INSERT)} call=${text.includes(ANCHOR_CALL)}）：${TARGET}（上游改了 translate 收口？先核对上游是否已自行修复）`)
  process.exit(1)
}
if (text.split(ANCHOR_INSERT).length !== 2 || text.split(ANCHOR_CALL).length !== 2) {
  console.log(`ensure-tooljsonrepair-patch: STALE — 锚点不唯一：${TARGET}`)
  process.exit(1)
}
if (check) {
  console.log(`ensure-tooljsonrepair-patch: MISSING — patch needed (${TARGET})`)
  process.exit(1)
}

const patched = text.replace(ANCHOR_INSERT, HELPER).replace(ANCHOR_CALL, CALL_PATCHED)
if (!patched.includes(MARKER) || !patched.includes(CALL_PATCHED)) {
  console.log('ensure-tooljsonrepair-patch: 内部错误——替换后校验失败，未写盘')
  process.exit(1)
}
writeFileSync(TARGET, patched)
console.log(`ensure-tooljsonrepair-patch: patched translate() tool-call settlement (${TARGET})`)
