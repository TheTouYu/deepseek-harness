/**
 * 保帧截断会话文件：把 v4 会话日志截到指定 seq（含），保持「首帧恰好一行头」的格式不变式。
 * 用法： node trim-session.mjs <源文件> <目标文件> <maxSeq>
 * 背景：v4 日志的加载器要求**第一个 zstd 帧恰好是那一行 header**（否则报
 *   corrupt Zstandard session log: first frame is not exactly one header line）。
 *   因此这里写成两帧：帧1=header 行，帧2=其余事件行。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const [src, dst, maxSeqRaw] = process.argv.slice(2);
if (!src || !dst || !maxSeqRaw) { console.error("用法: trim-session.mjs <源> <目标> <maxSeq>"); process.exit(2); }
const maxSeq = Number(maxSeqRaw);
const lines = zstdDecompressSync(readFileSync(src)).toString("utf8").split("\n").filter(Boolean);
const header = lines[0];
if (!header.includes('"')) { console.error("首行不像 header:", header.slice(0, 80)); process.exit(2); }
const kept = lines.slice(1).map((l) => JSON.parse(l)).filter((e) => typeof e.seq !== "number" || e.seq <= maxSeq);
const out = Buffer.concat([
  zstdCompressSync(header + "\n"),
  zstdCompressSync(kept.map((e) => JSON.stringify(e)).join("\n") + "\n"),
]);
writeFileSync(dst, out);
console.log(`已截断：保留 ${kept.length} 个事件（最大 seq=${kept[kept.length - 1]?.seq}），写入 ${dst}（${out.length} B，两帧）`);
