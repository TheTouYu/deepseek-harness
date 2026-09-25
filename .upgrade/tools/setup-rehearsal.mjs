#!/usr/bin/env node
/**
 * 搭建演练用的 `DSH_HOME` 副本——**完全不碰运行中的 `~/.dsh`**（只读源、只写沙箱）。
 *
 * 拷贝策略：配置全要（settings.yaml + profiles + .agent-presets），会话只挑**内容最多**的
 * 若干条（v0 与 v3 各 N 条），因为要验证的是"这两种旧代能不能被 0.1.7 正确读取与迁移"，
 * 而不是把 1.3G 会话全搬一遍。attachments / memo-river 语料不拷（体积大且与迁移无关）。
 *
 * 用法: node setup-rehearsal.mjs <源 DSH_HOME> <目标 DSH_HOME> [每版挑几条]
 */
import { createReadStream, readdirSync, statSync, mkdirSync, copyFileSync, cpSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

const src = process.argv[2] ?? join(process.env.HOME ?? '', '.dsh')
const dst = process.argv[3] ?? join(import.meta.dirname, '..', 'rehearsal', 'DSH_HOME')
const perVersion = Number(process.argv[4] ?? 3)

async function headerOf(file) {
  const stream = createReadStream(file).pipe(createZstdDecompress())
  let text = ''
  try {
    for await (const chunk of stream) {
      text += chunk.toString('utf8')
      if (text.includes('\n') || text.length > 8192) break
    }
  } catch {
    return null
  } finally {
    stream.destroy()
  }
  try {
    return JSON.parse(text.split('\n', 1)[0])
  } catch {
    return null
  }
}

console.log(`源: ${src}\n目标: ${dst}\n`)
mkdirSync(dst, { recursive: true })

// ── 1. 配置类：整份要 ──────────────────────────────────────────────
for (const item of ['settings.yaml', 'profiles', '.agent-presets']) {
  const from = join(src, item)
  if (!existsSync(from)) {
    console.log(`  跳过（源不存在）: ${item}`)
    continue
  }
  cpSync(from, join(dst, item), { recursive: true, dereference: false })
  console.log(`  已拷: ${item}`)
}

// ── 2. 会话：按版本各挑最大的 N 条 ─────────────────────────────────
const sessionsRoot = join(src, 'sessions')
const byVersion = new Map()
if (existsSync(sessionsRoot)) {
  for (const bucket of readdirSync(sessionsRoot)) {
    const bucketDir = join(sessionsRoot, bucket)
    let dirs
    try {
      if (!statSync(bucketDir).isDirectory()) continue
      dirs = readdirSync(bucketDir)
    } catch {
      continue
    }
    for (const dir of dirs) {
      const sessionDir = join(bucketDir, dir)
      let files
      try {
        if (!statSync(sessionDir).isDirectory()) continue
        files = readdirSync(sessionDir)
      } catch {
        continue
      }
      for (const name of files) {
        if (!name.endsWith('.jsonl.zstd')) continue
        const file = join(sessionDir, name)
        const header = await headerOf(file)
        if (!header || typeof header.version !== 'number') continue
        const rec = { file, bucket, dir, size: statSync(file).size, version: header.version }
        if (!byVersion.has(rec.version)) byVersion.set(rec.version, [])
        byVersion.get(rec.version).push(rec)
      }
    }
  }
}

for (const [version, recs] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
  recs.sort((a, b) => b.size - a.size)
  const picked = recs.slice(0, perVersion)
  console.log(`\n  version=${version}：共 ${recs.length} 条，挑 ${picked.length} 条最大的`)
  for (const rec of picked) {
    const target = join(dst, 'sessions', rec.bucket, rec.dir)
    mkdirSync(target, { recursive: true })
    const name = rec.file.split('/').pop()
    copyFileSync(rec.file, join(target, name))
    console.log(`      ${(rec.size / 1024).toFixed(0)}KB  ${rec.bucket}/${rec.dir}/${name}`)
  }
}

console.log(`\n完成。演练用 DSH_HOME = ${dst}`)
console.log('启动方式（示例）：DSH_HOME=' + dst + ' <沙箱 dsh> --profile web --port 3199 --no-open')
