#!/usr/bin/env bash
# 同一会话「上下文对齐」复现（服务端 RPC 直驱，绕开 GUI 侧栏对子代理会话的过滤）
#
# 做法（对齐到什么程度，见文件末尾「保真度」）：
#   1) 把生产原件截断到 seq<=530 = 原始失败请求(seq533)之前的**同一状态**；
#   2) 原样注入原始触发文本 —— 该回合的触发者不是用户消息，而是长上下文插件在 seq531
#      注入的 1190 字压缩提醒（original-nudge.txt，与 seq531 逐字相同）；提醒里点名的可压
#      区间正是模型随后去压的 seq 34..184；
#   3) 夹具回放录制的真分片（3477 片 / 6864 字符），观察解析→修复→真工具执行。
#
# 用法： bash repro-same-session.sh
# 前置：夹具可被本脚本自起；沙箱目录 /tmp/dsh-sbx-jr 已存在。
set -uo pipefail
HERE=/home/h/dsh-plugins/.scratch/invalidjson
SBX=/tmp/dsh-sbx-jr
PORT=3105
PARENT=session-8d8518b0-81c4-4ef1-baea-ad3d943efceb
CHILD=cc221920-20fd-4184-a52f-9f40fce68c7f
PROD=~/.dsh/sessions/--home-h-dsh-plugins--/$CHILD/session.v4.jsonl.zstd
SBXDIR=$SBX/sessions/--home-h-dsh-plugins--/$CHILD
JAR=/tmp/jar-repro-$$
TRIM=/tmp/trimmed-530.zstd

echo "── ① 截断到失败前状态（seq<=530）──"
node "$HERE/trim-session.mjs" "$PROD" "$TRIM" 530
cp -p "$TRIM" "$SBXDIR/session.v4.jsonl.zstd"; rm -f "$SBXDIR/session.lock"
rm -f "$SBX/storages/session_projcache/sessions/$CHILD.json"

echo "── ② 夹具（标记 = 原始提醒文本，脏载荷只在有标记的回合回放）──"
FPID=$(ss -tlnp 2>/dev/null | grep ':8899' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "${FPID:-}" ] && kill "$FPID" && sleep 1
( cd "$HERE" && FIXTURE_MARK="efficiency nudge to compress early" nohup node replay-fixture.mjs > /tmp/fixture-jr.log 2>&1 & )
sleep 2; curl -sk https://127.0.0.1:8899/__reset >/dev/null

echo "── ③ 沙箱重启（加载被测安装树产物）──"
( cd /home/h/dsh-plugins/dsh-preset-composer && export NODE_TLS_REJECT_UNAUTHORIZED=0 && bash scripts/sandbox-ctl.sh restart "$SBX" web "$PORT" >/dev/null 2>&1 )
TOKEN=$(cat /tmp/dsh-sbx-${PORT}-token.txt)
curl -s -c "$JAR" -o /dev/null "http://127.0.0.1:${PORT}/?token=$TOKEN" || { echo "取 cookie 失败"; exit 1; }

echo "── ④ 投递体（注入文本 = 原始 nudge 逐字）──"
node -e '
const {readFileSync,writeFileSync}=require("node:fs");
const nudge=readFileSync(process.argv[1],"utf8");
const wrap=(method,rpcId,args)=>JSON.stringify({type:"client-request",rpcId,method,payload:{args}});
writeFileSync("/tmp/repro-adopt.json",wrap("session/create","a",{request:{sessionId:process.argv[3],cwd:"/home/h/dsh-plugins"}}));
writeFileSync("/tmp/repro-deliver.json",wrap("subagents/prompt","d",{request:{requestId:"repro-"+Date.now(),parentSessionId:process.argv[3],childSessionId:process.argv[2],mode:"continuable",delivery:"queue",content:[{type:"text",text:nudge}]}}));
console.log("  注入文本 "+nudge.length+" 字");' "$HERE/original-nudge.txt" "$CHILD" "$PARENT"

RPC(){ curl -s -b "$JAR" -X POST "http://127.0.0.1:${PORT}/api/$1" -H 'content-type: application/json' -d @"$2"; }
echo "  收养父会话: $(RPC session/create /tmp/repro-adopt.json | head -c 110)"
echo "  投递到子会话: $(RPC subagents/prompt /tmp/repro-deliver.json | head -c 110)"

echo "── ⑤ 等回合跑完（30s）──"; sleep 30
echo "── 夹具记账 ──"; cat "$HERE/fixture-requests.log"
echo "── 会话判定 ──"
node -e '
const {readFileSync}=require("node:fs");const {zstdDecompressSync}=require("node:zlib");
const F="/tmp/dsh-sbx-jr/sessions/--home-h-dsh-plugins--/cc221920-20fd-4184-a52f-9f40fce68c7f/session.v4.jsonl.zstd";
const evs=zstdDecompressSync(readFileSync(F)).toString("utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));
const seg=evs.filter(e=>e.seq>530);
const call=seg.filter(e=>e.type==="tool/call").slice(-1)[0];
const end=seg.filter(e=>e.type==="turn/end").slice(-1)[0];
console.log("  tool/call:",call?`callId=${call.data.callId} args长度=${call.data.arguments.length}`:"（无）");
console.log("  llm/retry 次数:",seg.filter(e=>e.type==="llm/retry").length);
console.log("  末次 turn/end:",JSON.stringify(end?.data));
console.log("  判定:",JSON.stringify(end?.data).includes("completed")?"✅ 回合完成（未判死）":"❌ 回合未完成");'
rm -f "$JAR"
cat <<'EOF'

保真度（实测，2026-10-14）：
  相同：会话身份与历史(1..530 逐字同源) / 预设 river-acp / 41 个工具(名称·顺序·描述·schema 逐字) /
        模型配置逐字 / 触发文本逐字 / 模型响应分片逐字节(3477 片·6864 字符) / 工具 callId 逐字
  不同：①注入消息 source 由 acp-nudge 变 user（结构性：任何投递门都落 user/message）
        ②系统提示 16185 字里 1 处——运行时 GUI 地址 3080→3105（结构性：除非在 3080 跑）
        ③沙箱多一条 <system-reminder> AGENTS.md 提醒；截断处多一条合成 turn/end(interrupted)
  模型响应是录制重放而非真生成——bug 在解析侧，必须吃同一份坏 JSON。
EOF
