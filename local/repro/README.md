# local/repro —— MALFORMED_RESPONSE 复现与验收台

针对「工具入参漏转义 ⇒ 整个 turn 被判死」的复现/验收资产。补丁本体见 `local/patches/ensure-tooljsonrepair-patch.mjs`。

## 病与两层修复

- **病**：`dsh-llm-deepseek` 在 `message_stop` 处对 tool-call 入参做 `JSON.parse`，失败即抛
  `MALFORMED_RESPONSE: DeepSeek Messages stream: tool input is invalid JSON`，整个 turn 被判死（历史里那 41 次工具调用白跑）。
  根因在「block-end 收口」——`block.json` 累积的分片直接当 `arguments` 用，模型把 `"` 漏转义时无补救。
- **修复 A（源码）**：`ensure-tooljsonrepair-patch.mjs` 在 block-end 之前插入收窄的转义修复（只认
  `Expected ',' or '}' after property value in JSON at position N`，候选引号须未转义且无闭合引号，上限 8 轮）。
- **修复 B（配置）**：profile 的 `llm-deepseek` 条目把 `MALFORMED_RESPONSE` 并入 `retryPolicy.retryableCodes`
  （注意：显式给码表即**整表替换**，默认五码必须列全）。纯重试救不了确定性生成错，但能让瞬态情况自愈。

## 资产

| 文件 | 作用 |
|---|---|
| `repro-same-session.sh` | **端到端**：把事故会话截断到失败前状态 → 原样注入原始触发文本 → 经服务端 RPC 投递 → 读夹具记账与会话判定。已实跑验证 |
| `trim-session.mjs` | 保帧截断 v4 会话日志（首帧必须恰好一行 header，故写成两帧） |
| `replay-fixture.mjs` | https 夹具，按标记回放录制的真分片（`/__reset` 复位；判据=该 callId 是否已产生 tool_result） |
| `incident-payloads.json` | 录制的坏载荷：3477 片 / 6864 字符，join 后与 `block-end.arguments` 逐字节相等 |
| `original-nudge.txt` | 原始失败请求的**真实触发者**：长上下文插件注入的 1190 字压缩提醒（点名 seq 34..184） |
| `verify-config-accept.mjs` | 配置级验收：走真实 `Config → plainOptions → resolveRetryPolicy` 三段链，16/16 |
| `test-repair-algorithm.mjs` | 修复算法语料回归 22/22（含 11 个负面案，确保不会静默改写合法入参） |
| `test-adapter-e2e.mjs` | 真 TLS + 真 adapter 端到端 16/16（自签证书需自备，见下） |

## 跑法

```bash
# 配置级（只读 profile 真文件，需 dsh 安装树在位）
node local/repro/verify-config-accept.mjs

# 算法级
node local/repro/test-repair-algorithm.mjs
node local/repro/test-adapter-e2e.mjs        # 需 local/repro/tls/{cert,key}.pem

# 端到端（同一会话 A/B；需沙箱与夹具）
bash local/repro/repro-same-session.sh
```

自签证书（3 天期，故不入库）：

```bash
openssl req -x509 -newkey rsa:2048 -days 3 -nodes -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1" -keyout tls/key.pem -out tls/cert.pem
```

`test-adapter-e2e.mjs` 必须带 `NODE_TLS_REJECT_UNAUTHORIZED=0`：`freshConnectionFetch` 走
node:https + `agent:false`，不接受 CA 注入。

## 保真度（实测 2026-10-14）

**相同**：会话身份与历史（1..530 逐字）· 预设 river-acp · 41 个工具（名称/顺序/描述/schema 逐字）·
模型配置逐字 · 触发文本逐字 · 模型响应分片逐字节（3477 片/6864 字符）· 工具 callId 逐字。

**不同**：①注入消息 `source` 由 `acp-nudge` 变 `user`（任何投递门都会落 user/message）；②系统提示
16185 字里 1 处——运行时 GUI 地址 `3080 → 3105`；③沙箱多一条 AGENTS.md `<system-reminder>`，
截断处多一条合成 `turn/end(interrupted)`。

**模型响应是录制重放而非现场生成**——bug 在解析侧，必须吃同一份坏 JSON。

## 结论性数字

- 纯净上游：夹具 9 次请求全回放坏载荷 → `turn/end` 全 `MALFORMED_RESPONSE`，`llm/retry`×8，**零 tool/call**。
- 打补丁后：`tool/call` callId `call_00_WiZ7cDIAcLQUp0FnhWvh0535`、`args=6866`（原 6864 + 转义 2 处）→
  `tool/result`「Compressed 4 block(s), ~34627 tokens reclaimed … seqs 34..184」→ `turn/end completed`，**0 retry**。
