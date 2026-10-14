#!/usr/bin/env node
/**
 * identity-dedup 补丁器 —— 删掉 persona 里与宿主 `harness:identity` 重复的第二句身份（零依赖，独立运行）。
 *
 * 背景（用户 2026-10-14 裁决）：宿主 `harness:identity` 已经给出身份行
 * （"You are an AI agent powered by DeepSeek Harness"），而 dsh-web-app 的 patch 配置又往 persona
 * 追加一句同义身份 "You are a coding agent powered by the {{model}} model." —— 两句重复，
 * 后一句冗余，删。persona 的 suffix（`Your working directory is {{cwd}}.`）保持不动。
 *
 * 落点（4 处，全在安装树的 `@deepseek-ai/dsh-web-app` 里；npm 升级会整体覆盖 ⇒ 本补丁器幂等重打）：
 *   1. `cordis.patch.yml`            → `system-prompt.personaPrefix`（块标量 `>-` 两行）
 *   2. `presets/cordis.patch.yml`    → `persona.prefix`（块标量 `>-` 两行）
 *   3. `presets/ptc.patch.yml`       → `persona.prefix`（单行标量）
 *   4. `presets/standard.patch.yml`  → `persona.prefix`（单行标量）
 * 四处都改成空串（`''`）。锚点与替换串逐字节取自 0.2.0-rc.2 的 npm tarball（从 ~/.npm/_cacache
 * 还原的纯净件，见 README 该节「验收」），不是凭记忆写的。
 *
 * 三态语义（`--check` 只诊断、绝不写盘）：
 *   替换结果在（该行已是空串）  → OK      exit 0
 *   锚点在                      → MISSING exit 1（非 `--check` 时执行替换）
 *   站点在但锚点形状变了        → STALE   exit 1（上游改了那句身份句 ⇒ 先人工核对再更新锚点）
 *   站点整块都不在              → SKIP    exit 1（上游可能已自行移除 persona prefix；人工确认后可摘掉本条）
 *   目标文件不存在              → exit 2  （dsh 目录布局变了）
 *
 * 用法：
 *   node ensure-identity-dedup-patch.mjs [--check] [--root <安装根>]
 *     --root  缺省 $DSH_INSTALL_ROOT 或 ~/.local/lib/node_modules
 *             （脚本内部接 `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/`）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const check = args.includes('--check')
const rootIdx = args.indexOf('--root')
const ROOT = rootIdx >= 0 ? args[rootIdx + 1]
  : process.env.DSH_INSTALL_ROOT ?? join(homedir(), '.local/lib/node_modules')

const PKG = join(ROOT, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app')
const MARKER = '# ponytail: persona-identity-dedup'
const WHY = '宿主 harness:identity 已给身份句，本句重复冗余（用户 2026-10-14 裁决）'

/** 值已是空串即视为已打（容忍 '' / "" 以及行尾注释两种写法）。 */
const empty = (key) => new RegExp(`^[ \\t]*${key}:[ \\t]*(?:''|"")[ \\t]*(?:#.*)?$`, 'm')
/** 站点是否还在（该 key 有非空值）——用来区分「形状变了」（STALE）与「整块没了」（SKIP）。 */
const siteOf = (key) => new RegExp(`^[ \\t]*${key}:[ \\t]*\\S`, 'm')

const EDITS = [
  {
    file: join(PKG, 'cordis.patch.yml'),
    what: 'system-prompt.personaPrefix',
    anchor: "    personaPrefix: >-\n      You are a coding agent powered by the {{model}} model.\n",
    patched: `    ${MARKER} — ${WHY}\n    personaPrefix: ''\n`,
    patchedRe: empty('personaPrefix'),
    siteRe: siteOf('personaPrefix'),
  },
  {
    file: join(PKG, 'presets/cordis.patch.yml'),
    what: 'presets/cordis.persona.prefix',
    anchor: "              prefix: >-\n                You are a coding agent powered by the {{model}} model.\n",
    patched: `              ${MARKER} — ${WHY}\n              prefix: ''\n`,
    patchedRe: empty('prefix'),
    siteRe: siteOf('prefix'),
  },
  {
    file: join(PKG, 'presets/ptc.patch.yml'),
    what: 'presets/ptc.persona.prefix',
    anchor: '              prefix: You are a coding agent powered by the {{model}} model.\n',
    patched: `              ${MARKER} — ${WHY}\n              prefix: ''\n`,
    patchedRe: empty('prefix'),
    siteRe: siteOf('prefix'),
  },
  {
    file: join(PKG, 'presets/standard.patch.yml'),
    what: 'presets/standard.persona.prefix',
    anchor: '              prefix: You are a coding agent powered by the {{model}} model.\n',
    patched: `              ${MARKER} — ${WHY}\n              prefix: ''\n`,
    patchedRe: empty('prefix'),
    siteRe: siteOf('prefix'),
  },
]

const tally = { ok: 0, patched: 0, missing: 0, stale: 0, skip: 0, absent: 0 }
let worst = 0 // 0 = 健康；1 = 需要打或需要人看；2 = 目标不存在（版本漂移）

for (const e of EDITS) {
  if (!existsSync(e.file)) {
    console.log(`ensure-identity-dedup-patch: target not found: ${e.file}（dsh 目录布局变了？）`)
    tally.absent++
    worst = 2
    continue
  }
  const text = readFileSync(e.file, 'utf8')

  if (e.patchedRe.test(text)) {
    console.log(`ensure-identity-dedup-patch: OK — ${e.what} 已是空串 (${e.file})`)
    tally.ok++
    continue
  }

  const hits = text.split(e.anchor).length - 1
  if (hits === 1) {
    if (check) {
      console.log(`ensure-identity-dedup-patch: MISSING — patch needed [${e.what}] (${e.file})`)
      tally.missing++
      worst = Math.max(worst, 1)
      continue
    }
    const patched = text.replace(e.anchor, e.patched)
    if (!e.patchedRe.test(patched)) {
      console.log(`ensure-identity-dedup-patch: 内部错误——替换后校验失败，未写盘 [${e.what}] (${e.file})`)
      worst = Math.max(worst, 1)
      continue
    }
    writeFileSync(e.file, patched)
    console.log(`ensure-identity-dedup-patch: patched ${e.what} (${e.file})`)
    tally.patched++
    continue
  }

  if (hits > 1) {
    console.log(`ensure-identity-dedup-patch: STALE — 锚点不唯一（命中 ${hits} 次）[${e.what}] (${e.file})`)
    tally.stale++
    worst = Math.max(worst, 1)
    continue
  }

  if (e.siteRe.test(text)) {
    console.log(`ensure-identity-dedup-patch: STALE — 站点还在但锚点未命中 [${e.what}] (${e.file})：上游改写了那句身份句？先人工核对（是否已自行删除/改写），再更新本脚本的 anchor`)
    tally.stale++
    worst = Math.max(worst, 1)
    continue
  }

  console.log(`ensure-identity-dedup-patch: SKIP — 站点整块不在 [${e.what}] (${e.file})：上游可能已自行移除 persona prefix；人工确认后可从 apply-all.sh 摘掉本条`)
  tally.skip++
  worst = Math.max(worst, 1)
}

console.log(`ensure-identity-dedup-patch: ok=${tally.ok} patched=${tally.patched} missing=${tally.missing} stale=${tally.stale} skip=${tally.skip} absent=${tally.absent}`)
if (worst === 0 && !check) console.log('ensure-identity-dedup-patch: OK — 四处 persona 身份句均为空串')
process.exit(worst)
