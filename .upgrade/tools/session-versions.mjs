#!/usr/bin/env node
/**
 * 扫描 `$DSH_HOME/sessions/` 下全部会话，按首行 header 的 `version` 字段统计分布，
 * 并列出每个版本的若干样本路径。
 *
 * 会话文件是 zstd 压缩的 JSONL（`session.jsonl.zstd`），首行形如
 * `{"type":"session","version":0,"id":"session-…","createdAt":…,"cwd":"…","delegationDepth":0}`。
 * 用流式解压只为拿首行——整份解压在大文件上没有必要。
 *
 * 用法: node session-versions.mjs [sessions 目录] [每版样本数]
 */
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

const root = process.argv[2] ?? join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'), 'sessions')
const sampleLimit = Number(process.argv[3] ?? 3)

/** 只解压到够读首行为止，避免把整个会话读进内存。 */
async function headerOf(file) {
  const stream = createReadStream(file).pipe(createZstdDecompress())
  let text = ''
  try {
    for await (const chunk of stream) {
      text += chunk.toString('utf8')
      if (text.includes('\n') || text.length > 8192) break
    }
  } catch (e) {
    return { error: String(e?.message ?? e) }
  } finally {
    stream.destroy()
  }
  const line = text.split('\n', 1)[0]
  try {
    return JSON.parse(line)
  } catch {
    return { error: 'first line not JSON' }
  }
}

const byVersion = new Map()
const errors = []
let total = 0

for (const bucket of readdirSync(root)) {
  const bucketDir = join(root, bucket)
  let entries
  try {
    if (!statSync(bucketDir).isDirectory()) continue
    entries = readdirSync(bucketDir)
  } catch {
    continue
  }
  for (const entry of entries) {
    const dir = join(bucketDir, entry)
    let files
    try {
      if (!statSync(dir).isDirectory()) continue
      files = readdirSync(dir)
    } catch {
      continue
    }
    // 两种命名并存：旧布局 `session.jsonl.zstd`（v0 时代，无代数前缀），
    // 新布局 `session.<generation>.jsonl.zstd`（如 session.v3.jsonl.zstd）。
    for (const name of files) {
      if (!name.endsWith('.jsonl.zstd')) continue
      const file = join(dir, name)
      try {
        statSync(file)
      } catch {
        continue
      }
      total += 1
      const header = await headerOf(file)
      if (header.error) {
        errors.push(`${file}: ${header.error}`)
        continue
      }
      const v = header.version
      if (!byVersion.has(v)) byVersion.set(v, { count: 0, samples: [] })
      const rec = byVersion.get(v)
      rec.count += 1
      if (rec.samples.length < sampleLimit) rec.samples.push(file.replace(root + '/', ''))
    }
  }
}

console.log(`sessions 根目录: ${root}`)
console.log(`会话总数: ${total}`)
for (const [v, rec] of [...byVersion.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  version=${v}  ${rec.count} 个`)
  for (const s of rec.samples) console.log(`      ${s}`)
}
if (errors.length) {
  console.log(`\n读不出来的 ${errors.length} 个：`)
  for (const e of errors.slice(0, 5)) console.log('  ' + e)
}
