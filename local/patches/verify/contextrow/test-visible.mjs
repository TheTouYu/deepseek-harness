/**
 * 直接执行「安装树里真实字节」的 isVisibleChatNode，对真实会话数据造的节点做 A/B。
 * 用法： node test-visible.mjs <已补丁 client.js> <纯净 client.js.bak-*>
 */
import { readFileSync } from 'node:fs'

function extract(file) {
  const text = readFileSync(file, 'utf8')
  const start = text.indexOf('function isVisibleChatNode(node) {')
  if (start < 0) throw new Error(`找不到 isVisibleChatNode：${file}`)
  const end = text.indexOf('\n\t\t}', start)
  if (end < 0) throw new Error(`找不到函数结尾：${file}`)
  const src = text.slice(start, end + 4)
  return { src, fn: new Function(`${src}\nreturn isVisibleChatNode;`)() }
}

const patched = extract(process.argv[2])
const pristine = extract(process.argv[3])
console.log(`补丁版函数体 ${patched.src.split('\n').length} 行 / 纯净版 ${pristine.src.split('\n').length} 行\n`)

// 用真实会话里的注入内容造节点（与 ui-chat 的 contextMessage() 同形）
const node = (kind, content, extra = {}) => ({
  kind, visibility: 'visible', seq: 1, time: 0, content: [], source: {}, producer: {}, form: null,
  data: { content, ...extra },
})
const txt = [{ type: 'text', text: '⟨memo-river·被动召回⟩\n[记忆河流·被动召回 | 本桶=dsh-plugins | Ω=0.844 dense]' }]
const instructions = [{ type: 'text', text: '<system-reminder>\nUpdated instructions from: $DSH_HOME/AGENTS.md' }]
const toolAdd = [{ type: 'tool-addition', toolName: 'compress' }]

const cases = [
  ['记忆召回注入（context）', node('context', txt), true],
  ['AGENTS.md 指令更新（context）', node('context', instructions), true],
  ['工具变更通知（context + tool-addition）', node('context', toolAdd), true],
  ['system-prompt 行', node('system-prompt', txt), false],
  ['permission 命令行', node('command', txt, { name: 'permission' }), false],
  ['普通命令行', node('command', txt, { name: 'other' }), true],
  ['用户消息', node('user', txt), true],
  ['工具结果', { kind: 'tool-result', visibility: 'visible', data: {} }, true],
  ['被显式标 hidden 的注入', { ...node('context', txt), visibility: 'hidden' }, false],
]

let ok = 0
let before = 0
for (const [name, n, expect] of cases) {
  const p = patched.fn(n)
  const b = pristine.fn(n)
  const good = p === expect
  if (good) ok++
  if (p !== b) before++
  console.log(`  ${good ? '✅' : '❌'} ${name.padEnd(34)} 补丁后=${String(p).padEnd(5)} (期望 ${String(expect).padEnd(5)}) 补丁前=${b}`)
}
console.log(`\n结果：${ok}/${cases.length} PASS；行为发生变化的 ${before} 项（应=2：召回与指令更新由隐藏转可见；tool 变更本就是例外）`)
process.exit(ok === cases.length && before === 2 ? 0 : 1)
