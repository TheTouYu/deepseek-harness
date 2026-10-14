// 事故会话真载荷重放夹具：把 2026-10-14 会话 cc221920 里录制的 tool-call 分片序列
// （3477 片 / 6864 字符，与 block-end 最终串逐字节相等）按 Messages 线协议逐片发出。
// 用途：让真 dsh 实例（沙箱、独立端口）在**同一个会话**上复现当时的失败路径。
//   ① 历史里还没有工具结果 → 回放事故载荷（compress 调用，模型漏转义内层引号）
//   ② 已有工具结果 → 回一句正常文本收尾
// 每次请求都记账（请求序号/是否带工具结果/attempt），重试次数即证据（D45：mock 请求数 = 2 + maxRetries）。
import { createServer } from "node:https";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";

const HERE = "/home/h/dsh-plugins/.scratch/invalidjson";
const PORT = Number(process.env.FIXTURE_PORT ?? 8899);
const LOG = `${HERE}/fixture-requests.log`;
const payloads = JSON.parse(readFileSync(`${HERE}/incident-payloads.json`, "utf8"));
const CASE = process.env.FIXTURE_CASE ?? "seq533";
const spec = payloads.find((p) => (CASE === "seq533" ? p.attemptSeq === 533 : p.attemptSeq === 546 && p.tool === "compress"))
  ?? payloads.find((p) => p.tool === "compress" && !p.parses);
writeFileSync(LOG, "");

const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

function replaySse() {
  const out = [];
  out.push(frame("message_start", { type: "message_start", message: { usage: { input_tokens: 4321 } } }));
  out.push(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: spec.toolId, name: spec.tool, input: {} } }));
  for (const piece of spec.pieces) {
    out.push(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: piece } }));
  }
  out.push(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
  out.push(frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2100 } }));
  out.push(frame("message_stop", { type: "message_stop" }));
  return out.join("");
}

function doneSse(text) {
  return [
    frame("message_start", { type: "message_start", message: { usage: { input_tokens: 100 } } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

let n = 0;
let replayed = false; // 每次「复现实验」标记的回合只回放一次载荷，其后回文本收尾
const server = createServer({ key: readFileSync(`${HERE}/tls/key.pem`), cert: readFileSync(`${HERE}/tls/cert.pem`) }, (req, res) => {
  if (req.method === "GET" && req.url === "/__reset") { replayed = false; writeFileSync(LOG, ""); res.writeHead(200); res.end("reset\n"); console.log("-- 已复位（下次带标记的回合重新回放载荷）"); return; }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    n += 1;
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const msgs = body.messages ?? [];
    const hasToolResult = msgs.some((m) => (Array.isArray(m.content) ? m.content.some((b) => b.type === "tool_result") : false));
    // 判据：标记命中，且**该 callId 还没产生 tool_result** → 回放真载荷。
    // 这样重试永远再吃到坏载荷（纯净产物会一路撞到重试耗尽），而修好后的第一次调用执行完工具，
    // 下一次请求里就带着该 callId 的 tool_result → 改回文本收尾。
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const marked = JSON.stringify(lastUser?.content ?? "").includes(process.env.FIXTURE_MARK ?? "复现实验");
    const ourCallRan = msgs.some((m) => Array.isArray(m.content)
      && m.content.some((b) => b.type === "tool_result" && (b.tool_use_id === spec.toolId || b.toolUseId === spec.toolId)));
    const replay = marked && !ourCallRan;
    const line = `#${n} ${new Date().toISOString()} 消息${msgs.length}条 带工具结果=${hasToolResult} 工具数=${body.tools?.length ?? 0} 标记=${marked} 动作=${replay ? "回放真载荷" : "文本收尾"}`;
    console.log(line);
    appendFileSync(LOG, line + "\n");
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replay
        ? { id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: spec.toolId, name: spec.tool, input: {} }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } }
        : { id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text: "已收尾。" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
      return;
    }
    const sse = replay ? replaySse() : doneSse("已完成压缩并收尾。");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(sse);
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`夹具已起 https://127.0.0.1:${PORT}/v1/messages  载荷=${spec.tool}/${spec.chars}字符/${spec.pieces.length}片  记账→${LOG}`));
