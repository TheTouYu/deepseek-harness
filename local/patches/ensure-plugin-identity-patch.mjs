#!/usr/bin/env node
/**
 * dsh-plugin-identity 补丁器 — profile manifest 缺 version 不再炸请求（零依赖，独立运行）。
 *
 * 背景（2026-10-14 实录）：app-boot 的 initProfile 生成的 profile package.json 只有
 * name 没有 version；plugin-package-inventory-deepseek 的 identityFromManifest 却要求
 * name+version 双非空并抛错。profile 目录一旦挂相对 .mjs 行（dsh 文档允许），
 * 每轮请求的 dsh_plugin_packages 扩展准备必炸，Promise.all 把 cause 吞成
 * REQUEST_EXTENSION —— 全实例每轮请求失败，界面只报「本轮运行失败」零信息。
 *
 * 修复（与 fork 源码 816e974451 同构，本脚本打在 npm 安装的 lib 产物上，升级会被
 * 覆盖，故幂等 + ExecStartPre 自动重打）：
 *   1. identityFromManifest：匿名(非 bare package)路径下 version 缺失降级 "0.0.0"；
 *   2. initProfile：新建 profile manifest 模板补 version: "0.0.0"。
 *
 * 用法：
 *   node ensure-plugin-identity-patch.mjs [--check] [--root <dsh安装根>]
 *     --check  只诊断不打（OK / MISSING / STALE / target not found）
 *     --root   缺省 $DSH_INSTALL_ROOT 或 ~/.local/lib/node_modules/@deepseek-ai/dsh
 *
 * 退出码：0 = OK（已打或不需打）/ 1 = 需要打或需要修复 / 2 = 目标不存在（版本漂移，人工看）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const check = args.includes('--check')
const rootIdx = args.indexOf('--root')
const ROOT = rootIdx >= 0 ? args[rootIdx + 1]
  : process.env.DSH_INSTALL_ROOT ?? join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh')

const INVENTORY = join(ROOT, 'node_modules/@deepseek-ai/dsh-plugin-package-inventory-deepseek/lib/index.js')
const APPBOOT = join(ROOT, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')

const MARKER = '// ponytail: profile identity version-default'

// —— 补丁 1：identityFromManifest（bundled 后是单行压缩风格，锚点用完整条件表达式）——
const INV_OLD = 'if (allowAnonymous && manifest.name === void 0) return void 0;\n\tif (typeof manifest.name !== "string" || manifest.name.length === 0 || typeof manifest.version !== "string" || manifest.version.length === 0) throw new Error(`plugin-package-inventory-deepseek: ${path} must declare non-empty name and version`);'
const INV_NEW = `${MARKER}
	if (allowAnonymous && manifest.name === void 0) return void 0;
	if (allowAnonymous && (manifest.version === void 0 || manifest.version === "")) {
		if (typeof manifest.name !== "string" || manifest.name.length === 0) throw new Error(\`plugin-package-inventory-deepseek: \${path} must declare non-empty name and version\`);
		return { name: manifest.name, version: "0.0.0" };
	}
	if (typeof manifest.name !== "string" || manifest.name.length === 0 || typeof manifest.version !== "string" || manifest.version.length === 0) throw new Error(\`plugin-package-inventory-deepseek: \${path} must declare non-empty name and version\`);`

// —— 补丁 2：initProfile 模板补 version ——
const BOOT_OLD = 'const manifest = {\n\t\t\tname: `dsh-profile-${basename(dir)}`,\n\t\t\tprivate: true,'
const BOOT_NEW = 'const manifest = {\n\t\t\tname: `dsh-profile-${basename(dir)}`,\n\t\t\tversion: "0.0.0",\n\t\t\tprivate: true,'

function patchFile (path, oldText, newText, label) {
  if (!existsSync(path)) { console.log(`ensure-plugin-identity-patch: target not found: ${path}（dsh 目录布局变了？）`); process.exitCode = 2; return 'missing' }
  let text = readFileSync(path, 'utf8')
  if (text.includes(MARKER)) return 'ok'
  if (!text.includes(oldText)) {
    // 2026-10-14 in-place 手工补丁的形状（缩进/引号略异）也认作已打
    if (path === INVENTORY && /allowAnonymous[\s\S]{0,200}version === void 0 \|\| manifest\.version === ""/.test(text)) return 'ok'
    if (path === APPBOOT && /dsh-profile-\$\{basename\(dir\)\}[\s\S]{0,300}version: "0\.0\.0"/.test(text)) return 'ok'
    console.log(`ensure-plugin-identity-patch: STALE — 锚点未命中且无 marker：${label} (${path})（上游改了这段？）`)
    process.exitCode = 1
    return 'stale'
  }
  if (check) { console.log(`ensure-plugin-identity-patch: MISSING — patch needed (${path})`); process.exitCode = 1; return 'missing' }
  writeFileSync(path, text.replace(oldText, newText))
  console.log(`ensure-plugin-identity-patch: patched ${label} (${path})`)
  return 'patched'
}

const a = patchFile(INVENTORY, INV_OLD, INV_NEW, 'identityFromManifest')
const b = patchFile(APPBOOT, BOOT_OLD, BOOT_NEW, 'initProfile')
if (!check && a !== 'missing' && b !== 'missing' && process.exitCode === undefined) console.log('ensure-plugin-identity-patch: OK')
