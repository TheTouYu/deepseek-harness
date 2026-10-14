#!/usr/bin/env node
/**
 * ensure-identity-dedup-patch.mjs 的验收脚本（可重跑，无副作用——不碰真实安装树）。
 *
 * 覆盖：
 *   A. 真实安装树 `--check` 必须 exit 0（四处 persona 身份句已是空串）。
 *   B. 负向 A/B：把 mock 安装树里的空串**还原成上游原样**（下面 PRISTINE 块，逐字节取自
 *      0.2.0-rc.2 npm tarball，sha512-pCIMPLfTKVfY942dP4eJSDVw7iUw86pemzfOr/e5DWP7CdCKTfvA82kP0RJAKJcyKJd8s679hqtCue/p4P20Dg==）
 *      ⇒ `--check` 必须 MISSING×4 / exit 1；apply 后必须 exit 0；
 *      apply 产物与真实安装树**YAML 语义逐键相等**（两个独立解析器都验），
 *      且与真实安装树的字节差**只有新增的 marker 注释行**。
 *   C. STALE：把身份句改写成别的句子（站点还在、锚点形状变了） ⇒ exit 1 且不写盘。
 *   D. SKIP：整块删掉 persona prefix（站点不存在） ⇒ exit 1 且不写盘。
 *   E. 幂等：连打两次，第二次不得再写盘（mtime/内容不变）。
 *
 * 用法：node local/patches/verify/identity-dedup/test-identity-dedup.mjs
 * 退出码：0 = 全部通过；1 = 有失败（逐条打印 FAIL）。
 */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, '..', '..', 'ensure-identity-dedup-patch.mjs')
const HOME = process.env.HOME
const ROOT = process.env.DSH_INSTALL_ROOT ?? `${HOME}/.local/lib/node_modules`
const LIVE_PKG = `${ROOT}/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app`

// 两个独立 YAML 解析器（都用安装树里的真实依赖，避免自写 YAML 子集解析器）
const req = createRequire(import.meta.url)
let yamlLib, jsYamlLib
try {
  yamlLib = req(`${ROOT}/@deepseek-ai/dsh/node_modules/yaml`)
  jsYamlLib = req(`${ROOT}/@deepseek-ai/dsh/node_modules/js-yaml`)
} catch (e) {
  console.error(`无法加载 YAML 解析器（需要 ${ROOT}/@deepseek-ai/dsh/node_modules/{yaml,js-yaml}）：${e.message}`)
  process.exit(1)
}
// 上游 patch yml 里大量用 `!!js <表达式>`（dsh 自己的 tag）。两个解析器都不会求值：
//   · yaml 默认 warn + 保留原串（这里静音）；
//   · js-yaml 默认抛「unknown tag」⇒ 注册一个原样保留的 Type。
const JS_TYPE = new jsYamlLib.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true })
const JS_SCHEMA = jsYamlLib.DEFAULT_SCHEMA.extend([JS_TYPE])
const parseYaml = (text) => yamlLib.parse(text, { logLevel: 'silent' })
const parseJsYaml = (text) => jsYamlLib.load(text, { schema: JS_SCHEMA })

/** 递归收集某个 key 的全部 [路径, 值]（用来断言「全文件只有一处、且值为空串」）。 */
function findKey (node, key, path = '$', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findKey(v, key, `${path}[${i}]`, out))
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push([`${path}.${k}`, v])
      findKey(v, key, `${path}.${k}`, out)
    }
  }
  return out
}

/** 上游原样（0.2.0-rc.2 tarball，逐字节）——与补丁器脚本里的 anchor 相互独立。 */
const PRISTINE = {
  'cordis.patch.yml': {
    empty: "    personaPrefix: ''\n",
    upstream: '    personaPrefix: >-\n      You are a coding agent powered by the {{model}} model.\n',
    stale: '    personaPrefix: >-\n      You are a helpful coding agent for the {{model}} model.\n',
    key: 'personaPrefix',
  },
  'presets/cordis.patch.yml': {
    empty: "              prefix: ''\n",
    upstream: '              prefix: >-\n                You are a coding agent powered by the {{model}} model.\n',
    stale: '              prefix: >-\n                You are a helpful coding agent for the {{model}} model.\n',
    key: 'prefix',
  },
  'presets/ptc.patch.yml': {
    empty: "              prefix: ''\n",
    upstream: '              prefix: You are a coding agent powered by the {{model}} model.\n',
    stale: '              prefix: You are a helpful coding agent for the {{model}} model.\n',
    key: 'prefix',
  },
  'presets/standard.patch.yml': {
    empty: "              prefix: ''\n",
    upstream: '              prefix: You are a coding agent powered by the {{model}} model.\n',
    stale: '              prefix: You are a helpful coding agent for the {{model}} model.\n',
    key: 'prefix',
  },
}
const MARKER_LINE = '# ponytail: persona-identity-dedup'

let fails = 0
const ok = (msg) => console.log(`PASS  ${msg}`)
const bad = (msg) => { fails++; console.log(`FAIL  ${msg}`) }
const assert = (cond, msg) => cond ? ok(msg) : bad(msg)

function run (args) {
  try {
    const stdout = execFileSync(process.execPath, [PATCH, ...args], { encoding: 'utf8' })
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function mockRoot () {
  const base = mkdtempSync(join(tmpdir(), 'identity-dedup-'))
  const pkg = join(base, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app')
  mkdirSync(pkg, { recursive: true })
  return { base, pkg }
}

/** 四份真实文件铺进 mock；`name` 那份用 `mutate` 改造，其余保持已打状态（OK）。 */
function mockWithOne (name, mutate) {
  const { base, pkg } = mockRoot()
  for (const n of Object.keys(PRISTINE)) {
    mkdirSync(dirname(join(pkg, n)), { recursive: true })
    const live = readFileSync(join(LIVE_PKG, n), 'utf8')
    writeFileSync(join(pkg, n), n === name ? mutate(live, PRISTINE[n]) : live)
  }
  return { base, pkg }
}
const tally = (out) => /ok=\d+ patched=\d+ missing=\d+ stale=\d+ skip=\d+ absent=\d+/.exec(out)?.[0] ?? '(无 tally 行)'
const sem = (doc) => JSON.stringify(doc)

// 真实安装树必须存在且处于已打状态
if (!existsSync(LIVE_PKG)) {
  console.error(`真实安装树不存在：${LIVE_PKG}`)
  process.exit(1)
}

// —— A. 真实安装树 --check = 0 ——
const liveCheck = run(['--check'])
assert(liveCheck.code === 0, `A 真实安装树 --check exit=0（实际 ${liveCheck.code}）`)
assert(/ok=4 patched=0 missing=0 stale=0 skip=0 absent=0/.test(liveCheck.out),
  'A 真实安装树四处全 OK（tally 行匹配）')

// —— B. 负向 A/B：还原上游 ⇒ MISSING ⇒ apply ⇒ OK + 语义等价 ——
{
  const { base, pkg } = mockRoot()
  for (const name of Object.keys(PRISTINE)) {
    mkdirSync(dirname(join(pkg, name)), { recursive: true })
    const live = readFileSync(join(LIVE_PKG, name), 'utf8')
    const p = PRISTINE[name]
    if (!live.includes(p.empty)) { bad(`B 真实文件里找不到空串锚点（${name}）`); continue }
    writeFileSync(join(pkg, name), live.replace(p.empty, p.upstream))
  }
  const chk = run(['--check', '--root', base])
  assert(chk.code === 1 && /missing=4/.test(chk.out), `B 还原上游后 --check MISSING×4 / exit=1（实际 ${chk.code}：${/ok=\d+ patched=\d+ missing=\d+ stale=\d+ skip=\d+ absent=\d+/.exec(chk.out)?.[0]}）`)

  const app = run(['--root', base])
  assert(app.code === 0 && /patched=4/.test(app.out), `B apply 后 exit=0 且 patched=4（实际 ${app.code}）`)

  const chk2 = run(['--check', '--root', base])
  assert(chk2.code === 0 && /ok=4/.test(chk2.out), 'B apply 后 --check OK×4（幂等态）')

  for (const name of Object.keys(PRISTINE)) {
    const applied = readFileSync(join(pkg, name), 'utf8')
    const live = readFileSync(join(LIVE_PKG, name), 'utf8')
    const p = PRISTINE[name]
    // 语义：两个解析器都说「与真实安装树逐键相等」
    let same = false, detail = ''
    try {
      const j1 = parseJsYaml(applied); const j2 = parseJsYaml(live)
      same = sem(parseYaml(applied)) === sem(parseYaml(live)) && sem(j1) === sem(j2)
      if (!same) detail = ` yaml=${sem(parseYaml(applied)) === sem(parseYaml(live))} js-yaml=${sem(j1) === sem(j2)}`
    } catch (e) { detail = ` 解析失败：${e.message}` }
    assert(same, `B ${name}：apply 产物与真实安装树 YAML 语义相等（yaml + js-yaml 双解析器）${detail}`)
    // 语义：全文件该 key 恰好一处，且解析结果为空串
    let hits = []
    try { hits = findKey(parseYaml(applied), p.key) } catch (e) { hits = [['<解析失败>', e.message]] }
    assert(hits.length === 1 && hits[0][1] === '', `B ${name}：${p.key} 全文件唯一且解析为空串（实际 ${JSON.stringify(hits)}）`)
    // 字节：把 marker 注释行去掉后与真实安装树逐字节相等
    const stripped = applied.split('\n').filter((l) => !l.includes(MARKER_LINE)).join('\n')
    const added = applied.split('\n').length - live.split('\n').length
    assert(stripped === live && added === 1, `B ${name}：字节差仅一行 marker 注释（多出 ${added} 行，去 marker 后相等=${stripped === live}）`)
  }
  rmSync(base, { recursive: true, force: true })
}

// —— C. STALE：站点在、锚点形状变了 ⇒ exit 1 且不写盘 ——
{
  const name = 'presets/ptc.patch.yml'
  const { base, pkg } = mockWithOne(name, (live, p) => live.replace(p.empty, p.stale))
  const fixture = readFileSync(join(pkg, name), 'utf8')
  const r = run(['--check', '--root', base])
  assert(r.code === 1 && /ok=3 patched=0 missing=0 stale=1 skip=0 absent=0/.test(r.out), `C STALE 形状变了 ⇒ exit=1 / stale=1（实际 ${r.code}：${tally(r.out)}）`)
  const rw = run(['--root', base])
  assert(rw.code === 1 && readFileSync(join(pkg, name), 'utf8') === fixture, 'C STALE 时非 --check 也不写盘')
  rmSync(base, { recursive: true, force: true })
}

// —— D. SKIP：整块没有 persona prefix ⇒ exit 1 ——
{
  const name = 'presets/standard.patch.yml'
  const { base, pkg } = mockWithOne(name, (live, p) => live.replace(p.empty, ''))
  const fixture = readFileSync(join(pkg, name), 'utf8')
  const r = run(['--check', '--root', base])
  assert(r.code === 1 && /ok=3 patched=0 missing=0 stale=0 skip=1 absent=0/.test(r.out), `D SKIP 站点整块不在 ⇒ exit=1 / skip=1（实际 ${r.code}：${tally(r.out)}）`)
  assert(readFileSync(join(pkg, name), 'utf8') === fixture, 'D SKIP 不改文件')
  rmSync(base, { recursive: true, force: true })
}

// —— E. 目标不存在 ⇒ exit 2（版本漂移） ——
{
  const { base } = mockRoot()
  const r = run(['--check', '--root', base])
  assert(r.code === 2 && /absent=4/.test(r.out), `E 目标文件不存在 ⇒ exit=2（实际 ${r.code}）`)
  rmSync(base, { recursive: true, force: true })
}

// —— F. 幂等：打过的 mock 上连打两次，第二次内容不变 ——
{
  const { base, pkg } = mockRoot()
  for (const name of Object.keys(PRISTINE)) {
    mkdirSync(dirname(join(pkg, name)), { recursive: true })
    const live = readFileSync(join(LIVE_PKG, name), 'utf8')
    writeFileSync(join(pkg, name), live.replace(PRISTINE[name].empty, PRISTINE[name].upstream))
  }
  run(['--root', base])
  const before = Object.keys(PRISTINE).map((n) => readFileSync(join(pkg, n), 'utf8'))
  const r = run(['--root', base])
  const after = Object.keys(PRISTINE).map((n) => readFileSync(join(pkg, n), 'utf8'))
  assert(r.code === 0 && sem(before) === sem(after), 'F 连打两次内容不变（幂等）')
  rmSync(base, { recursive: true, force: true })
}

console.log(fails === 0 ? '\nidentity-dedup 验收：全部通过' : `\nidentity-dedup 验收：${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
