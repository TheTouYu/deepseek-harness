#!/usr/bin/env node
/**
 * 把 `$DSH_HOME/.agent-presets/<id>/` 这种旧目录预设，转成 0.1.7 的 bundle 形态。
 *
 * 依据：dsh-v0.1.7-rc.2 的 `packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md`
 * 「Migrate a legacy preset」一节 —— 建一个 bundle，声明里
 *   id 取目录名、name/description/order 取 preset.yml、plugins 照搬 agent.cordis.yml，
 * 并把预设目录里被相对路径引用的资产（`./xxx.mjs`）一并搬进 bundle 目录。
 *
 * 用法: node make-preset-bundle.mjs <预设目录> <输出bundle目录> <bundle包名>
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const [srcDir, outDir, pkgName] = process.argv.slice(2)
if (!srcDir || !outDir || !pkgName) {
  console.error('用法: node make-preset-bundle.mjs <预设目录> <输出bundle目录> <bundle包名>')
  process.exit(2)
}

const id = basename(srcDir.replace(/\/+$/u, ''))
const presetYml = readFileSync(join(srcDir, 'preset.yml'), 'utf8')
const cordisYml = readFileSync(join(srcDir, 'agent.cordis.yml'), 'utf8')

/** preset.yml 只承载展示元数据，键是扁平的 `name:` / `description:` / `order:`。 */
const field = (key) => {
  const m = presetYml.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))
  if (!m) return undefined
  return m[1].trim().replace(/^'(.*)'$/u, '$1').replace(/^"(.*)"$/u, '$1')
}

const displayName = field('name') ?? id
const description = field('description') ?? ''
const order = field('order')

// 旧文件里被相对路径引用的资产必须随 bundle 一起走，否则新体系下解析不到。
const relAssets = [...cordisYml.matchAll(/name:\s*'?(\.\/[^'\s]+)'?/gu)].map((m) => m[1].split('?')[0])
const uniqueAssets = [...new Set(relAssets)]

mkdirSync(outDir, { recursive: true })

const pkg = {
  name: pkgName,
  version: '1.0.0',
  private: true,
  type: 'module',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}
writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

// plugins 是 agent.cordis.yml 的**原样**内容，只整体缩进一层挂到 config.plugins 下。
const indented = cordisYml
  .replace(/\s+$/u, '')
  .split('\n')
  .map((line) => (line.trim() === '' ? '' : '        ' + line))
  .join('\n')

const header = [
  `# 由 local/patches 之外的迁移工具生成：旧目录预设 ${id} → bundle 声明。`,
  '# 生成源：$DSH_HOME/.agent-presets/' + id + '/（preset.yml + agent.cordis.yml）',
  '# 依据：dsh-v0.1.7-rc.2 packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md',
  '# 改这个文件等于改预设；改完需要重新 install_bundle。',
  '',
].join('\n')

const patch = [
  header,
  '- insert:',
  '    - id: preset-' + id,
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: ' + id,
  '        name: ' + JSON.stringify(displayName),
  ...(description ? ['        description: ' + JSON.stringify(description)] : []),
  ...(order ? ['        order: ' + order] : []),
  '        plugins:',
  indented,
  '',
].join('\n')
writeFileSync(join(outDir, 'cordis.patch.yml'), patch)

const copied = []
for (const asset of uniqueAssets) {
  const from = join(srcDir, asset)
  if (!existsSync(from)) {
    console.error(`  ⚠ 相对路径资产在预设目录里不存在，需人工处理: ${asset}`)
    continue
  }
  copyFileSync(from, join(outDir, basename(asset)))
  copied.push(asset)
}

console.log(`bundle 已生成: ${outDir}`)
console.log(`  id=${id}  name=${displayName}  order=${order ?? '(未设)'}`)
console.log(`  plugins 行数: ${indented.split('\n').filter((l) => l.trim()).length}`)
console.log(`  随迁资产: ${copied.length ? copied.join(', ') : '(无)'}`)
