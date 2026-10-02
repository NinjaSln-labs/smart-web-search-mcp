#!/usr/bin/env node
// smart-web-search-mcp-server.mjs — 跨工具 MCP stdio 入口（Node 内置 TS strip-only 直跑，免 esbuild）
//
// 把 smart-web-search 的 5-provider 搜索逻辑以标准 MCP stdio 服务暴露给
// zcode / cursor / qodercli / reasonix / opencode / commandcode / codex 等客户端。
//
// 核心逻辑（clients / routing / L1-L3 级联）在同目录 smart-web-search-mcp.ts，
// 本文件只做 2 件事：
//   1. 复刻 MCP stdio JSON-RPC 循环（LSP Content-Length 帧 + 裸 JSON 行双 framing，按首帧对称回包）
//   2. 每个 tools/call 独立 spawn `node smart-web-search-mcp.ts '{...}'` 子进程跑一次搜索后退出
//      （spawn-per-call）——L1 wigolo/HTTP client 随子进程回收，跨调用零累积，无常驻 pi 依赖。
//      核心 .ts 自带 CLI 检测（argv[2]=JSON 参数），本 server 不 import 核心。
//
// 关键约束（改核心 .ts 时必须遵守，否则 strip-only 跑不起来）：
//   - 不用 TS parameter property（constructor(private x)）
//   - 不用 TS enum / namespace（只有 transform 模式支持）
//   - 保持显式字段声明风格（同 8c0152e 的修复）
//
// 用法（任意支持 MCP 的客户端，stdio 形式）：
//   command: node
//   args:    [ <绝对路径>/agent-tools/smart-web-search/smart-web-search-mcp-server.mjs ]
// 各客户端配置示例见本仓 smart-web-search/README.md「MCP 跨工具接入」节。
//
// 凭据：与各端 pi 扩展共用同一套 env/vault 单源（SERPER/TINYFISH/TAVILY/KEENABLE_API_KEY）；
//       config 读 pi 扩展的 ~/.pi/agent/extensions/smart-web-search-mcp.config.json（热重载同 pi 端）。
// 日志：遥测仍写 ~/.pi/log/smart_web_search.jsonl（与 pi 端共享）；本 server 自身诊断走 stderr。
// 依赖：Node ≥22.7（内置 TS strip-only）；L1 wigolo 需已安装（npm i -g wigolo），缺失时自动降级。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 注：核心 smart-web-search-mcp.ts 自带 CLI 检测（argv[2] 为 JSON 参数时跑一次搜索并输出 JSON）——
// 本 server 的 spawn-per-call 直接 `node smart-web-search-mcp.ts '{...}'`，无需此文件再做 CLI 分支。

// ─── stdout 日志保护（必须先于一切 import/工厂调用）──────────
// MCP stdio 下 stdout 是协议通道：核心工厂的 console.log 横幅若进 stdout 会污染流。
// 统一把 console.log 重定向到 stderr；协议帧 send() 直接写 process.stdout，不经 console。
function diagLog(...a) { process.stderr.write(a.join(" ") + "\n"); }
console.log = diagLog;


// ─── 工具描述与 schema（与核心 SearchInput 一致；改核心入参需同步此处）────
// spawn-per-call：本 server 不 import 核心（避免 pi 内常驻 client 累积），
// 而是每次 tools/call 起独立子进程。工具描述/schema 在 server 侧内联维护。
const TOOL_NAME = "smart_web_search";
let toolDescription = "";

function runCoreOnce(searchParams) {
	return new Promise((resolve, reject) => {
		const cp = spawn(process.execPath, [join(__dirname, "smart-web-search-mcp.ts"), JSON.stringify(searchParams)], {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env, // 透传宿主 env：vault 软链的 SERPER/TINYFISH/TAVILY/KEENABLE_API_KEY 由此可见
		});
		let stdout = "";
		let stderr = "";
		cp.stdout.on("data", (d) => { stdout += d; });
		cp.stderr.on("data", (d) => { stderr += d; });
		cp.on("error", reject);
		cp.on("close", (code) => {
			if (code !== 0) {
				return reject(new Error(`core exited ${code}: ${stderr.slice(-300)}`));
			}
			try {
				resolve(JSON.parse(stdout));
			} catch (e) {
				reject(new Error(`core stdout not JSON: ${stdout.slice(0, 200)} (${e.message})`));
			}
		});
	});
}

// 工具描述：首跑时从核心 schema 取（tools/call 之前先跑一次空参数拿 description）——
// 简化：description 写死（与核心一致），避免多一次 spawn
toolDescription =
	"5-provider web search with cascade routing. L1 wigolo (free, 18 engines) + keenable (100K/mo free, independent index) in parallel → L2 tinyfish → tavily (serial; AI-optimized, 1000/mo free) → L3 serper (Google, 2500 free then paid). " +
	"Returns search results as readable blocks (Title/URL/Snippet) with a one-line routing footer; output_format=json gives a structured envelope. Use this as the DEFAULT web search tool.";

function toJsonSchema() {
	// 与核心 SearchInput 一致的 JSON schema（手工维护，改核心入参时同步）
	return {
		type: "object",
		required: ["query"],
		properties: {
			query: { type: "string", description: "Search query", minLength: 1, maxLength: 2000 },
			max_results: { type: "integer", description: "Max results (default 5)", minimum: 1, maximum: 50 },
			intent: { type: "string", enum: ["general", "news", "paper", "code", "research"], description: "Query intent — influences routing (general = auto-detect)" },
			recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Time filter (forwarded to all layers)" },
			include_domains: { type: "string", description: "Comma-separated domain whitelist" },
			exclude_domains: { type: "string", description: "Comma-separated domain blacklist" },
			depth: { type: "string", enum: ["basic", "advanced"], description: "Search depth — basic=cheap, advanced=more thorough" },
			location: { type: "string", description: "Geo bias (e.g. US, CN)" },
			output_format: { type: "string", enum: ["text", "json"], description: "Output format: text (default) = readable result blocks; json = structured envelope (query/results/meta/chain)" },
		},
	};
}

const TOOLS = [
	{
		name: TOOL_NAME,
		description: toolDescription,
		inputSchema: toJsonSchema(),
	},
];

// ─── MCP stdio 协议处理 ─────────────────────────────────────
// 帧格式："Content-Length: N" + 换行组 + N 字节 UTF-8 JSON body。双 LSP 头变体兼容：
//   A. "Content-Length: N\r\n\r\n"（标准双 CRLF）——cursor/zcode/opencode/commandcode/codex
//   B. "Content-Length: N\r\n"   （单 CRLF 后直接 body）——部分 rust/go 客户端
// 判定：头部数字 + 第一个换行组之后的字节，若为 '{'（body 起始）= 变体 B（1 换行），
//      否则 = 变体 A（还有第二个换行组）。粘滞（一 chunk 多帧 / body 尾粘下一帧头）
//      靠 rawBuf subarray 循环消费天然支持。
// 裸 JSON 行（无 LSP 头的极简/测试客户端）：按换行切行直接 parse；粘滞行
// "{...body}Content-Length: N" 解析失败后按头分段（前段裸 JSON 重试 + 后段回 LSP 流）。
const PROTOCOL_VERSION = "2025-03-26";
const SERVER_INFO = { name: "smart-web-search", version: "1.1.0" };

// 输出 framing：由收到的首帧探测决定（客户端发什么 framing，server 对称回包）。
//   LSP 头式（主流：cursor/zcode/opencode/commandcode/codex）→ "Content-Length: N\r\n\r\n" + body
//   裸 JSON 行式（reasonix 等 Rust rmcp 系客户端）→ 每行一个 JSON + \n
let outFraming = "lsp";
let firstFrameSeen = false;
function noteFrameStyle(style) {
	if (!firstFrameSeen) { outFraming = style; firstFrameSeen = true; }
}

function send(msg) {
	const body = Buffer.from(JSON.stringify(msg), "utf8");
	if (outFraming === "lsp") {
		process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
		process.stdout.write(body);
	} else {
		process.stdout.write(body.toString("utf8") + "\n");
	}
}

function handle(msg) {
	const method = msg?.method;
	const id = msg?.id;
	switch (method) {
		case "initialize": {
			send({
				jsonrpc: "2.0", id,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: SERVER_INFO,
				},
			});
			break;
		}
		case "notifications/initialized":
		case "notifications/cancelled":
		case "notifications/progress":
			break;
		case "ping":
			if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
			break;
		case "tools/list":
			send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			break;
		case "tools/call": {
			const params = msg.params ?? {};
			if (params.name !== TOOL_NAME) {
				send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${params.name}` } });
				return;
			}
			// 每次调用独立 spawn 子进程跑核心（避免 pi 内 client 累积）
			runCoreOnce(params.arguments ?? {})
				.then((out) => {
					send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false } });
				})
				.catch((e) => {
					send({
						jsonrpc: "2.0", id,
						result: {
							content: [{ type: "text", text: `smart_web_search failed: ${e?.message ?? e}` }],
							isError: true,
						},
					});
				});
			break;
		}
		case "resources/list":
			send({ jsonrpc: "2.0", id, result: { resources: [] } });
			break;
		case "prompts/list":
			send({ jsonrpc: "2.0", id, result: { prompts: [] } });
			break;
		default:
			// 未知 method：有 id 回 -32601，无 id（notification）静默
			if (id !== undefined) {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
			}
			break;
	}
}

// ─── 帧解析：直接读 stdin 原始字节流 ────────────────────────
// 不用 readline（拆行再拼行丢字节精度；LSP Content-Length 按字节计）。
let rawBuf = Buffer.alloc(0);

// 在 buf 头部解析 LSP 头 "Content-Length: N" + 换行组，返回 { n, headerBytes }；
// 无法解析（数字未收全 / 无头）返回 null。
// 兼容双换行组变体：
//   A. "Content-Length: N\r\n\r\n" + N 字节 body（标准 LSP：头行 + 空行）
//   B. "Content-Length: N\r\n" + N 字节 body（单换行组：body 紧跟）
// 判定：数字后第 2 个换行组存在 → 变体 A（headerBytes 含 2 组）；只有 1 组 → 变体 B。
// 按字节精确计算（不用正则 \s*——贪婪会错位）。
function parseLspHeader(buf) {
	const s = buf.toString("utf8");
	const m = s.match(/^Content-Length:\s*(\d+)/i);
	if (!m) return null;
	const n = parseInt(m[1], 10);
	// "Content-Length: " + 数字 的字节数（header 数字前的固定前缀 + 数字本身）
	const numEnd = Buffer.byteLength(m[0], "utf8");
	// 数字后的换行组：第 1 组必须有（没有 = 头未收全）
	if (numEnd >= buf.length) return null;
	let g1 = 0;
	if (buf[numEnd] === 0x0d && numEnd + 1 < buf.length && buf[numEnd + 1] === 0x0a) g1 = 2;
	else if (buf[numEnd] === 0x0a) g1 = 1;
	else if (buf[numEnd] === 0x0d) g1 = 1; // 单独的 \r（罕见）；按 1 字节处理
	else return null; // 数字后无换行：头未收全，等更多数据
	// 第 2 个换行组（变体 A 的空行）
	let g2 = 0;
	const p2 = numEnd + g1;
	if (p2 < buf.length) {
		if (buf[p2] === 0x0d && p2 + 1 < buf.length && buf[p2 + 1] === 0x0a) g2 = 2;
		else if (buf[p2] === 0x0a) g2 = 1;
		else if (buf[p2] === 0x0d) g2 = 1;
	}
	const headerBytes = numEnd + g1 + g2;
	// 换行组在 chunk 边界没收全（headerBytes 超出当前 buf）：等更多数据
	if (headerBytes > buf.length) return null;
	return { n, headerBytes };
}

function processRawBuf() {
	while (true) {
		if (rawBuf.length === 0) return;
		const s = rawBuf.toString("utf8");

		// ── LSP 模式：缓冲以 "Content-Length:" 开头 ──
		if (s.startsWith("Content-Length:")) {
			noteFrameStyle("lsp");
			const h = parseLspHeader(rawBuf);
			if (!h) {
				// 两种情况：数字未收全 / 数字后换行组未收全 → 等更多数据
				// （裸 JSON 粘滞场景的 "Content-Length:" 段也由此路径自然处理）
				return;
			}
			if (rawBuf.length - h.headerBytes < h.n) return; // body 未收全
			const body = rawBuf.subarray(h.headerBytes, h.headerBytes + h.n);
			try {
				handle(JSON.parse(body.toString("utf8")));
			} catch (e) {
				diagLog(`[smart-web-search-mcp] bad LSP body: ${e.message}`);
			}
			rawBuf = rawBuf.subarray(h.headerBytes + h.n);
			continue;
		}

		// ── 裸 JSON 行模式：按换行切 ──
		// 按 LSP 头的换行组（\r\n）切分：裸 JSON 行模式下客户端用 \r\n 分隔。
		// 找第一个 "\r\n"；找不到则找孤立 "\n"；再无则整行待定。
		let lineEnd = -1;
		const crlfIdx = s.indexOf("\r\n");
		if (crlfIdx !== -1) {
			lineEnd = crlfIdx; // 行内容到 \r 前
		} else {
			const nlIdx = s.indexOf("\n");
			const crIdx = s.indexOf("\r");
			if (nlIdx !== -1 && crIdx !== -1) lineEnd = Math.min(nlIdx, crIdx);
			else if (nlIdx !== -1) lineEnd = nlIdx;
			else if (crIdx !== -1) lineEnd = crIdx;
			else {
				// 无换行：可能是半个 JSON（等更多），也可能是末行无换行符的完整裸 JSON
				const whole = s.trim();
				if (whole.startsWith("{") && whole.length > 2) {
					try {
						const msg = JSON.parse(whole);
						if (msg?.method !== undefined) handle(msg);
						rawBuf = Buffer.alloc(0);
						return;
					} catch { /* 非完整 JSON：等更多数据 */ }
				}
				return; // 等更多数据
			}
		}

		// 行内容 = [0, lineEnd)；跳过后缀换行组（\r\n / \n / \r）
		let consumed = lineEnd;
		while (consumed < rawBuf.length && (rawBuf[consumed] === 0x0d || rawBuf[consumed] === 0x0a)) consumed++;
		const line = rawBuf.subarray(0, lineEnd).toString("utf8");
		rawBuf = rawBuf.subarray(consumed);
		if (!line.trim()) continue;
		if (!line.startsWith("{")) continue; // 非 JSON 非 LSP：丢弃
		noteFrameStyle("bare"); // 裸 JSON 行输入 → 输出也切裸行

		try {
			const msg = JSON.parse(line);
			if (msg?.method !== undefined) handle(msg);
		} catch (e) {
			// 粘滞行 "{...body}Content-Length: N"（LSP 帧尾与下一帧头粘在同一行）：
			// 按 "Content-Length:" 分段——前段当裸 JSON 重试，后段塞回缓冲头走 LSP 分支
			const idx = line.indexOf("Content-Length:");
			if (idx > 0) {
				try { const m2 = JSON.parse(line.slice(0, idx)); if (m2?.method !== undefined) handle(m2); } catch {}
				rawBuf = Buffer.concat([Buffer.from(line.slice(idx), "utf8"), rawBuf]);
				continue;
			}
			diagLog(`[smart-web-search-mcp] bad JSON line: ${e.message}`);
		}
	}
}

process.stdin.on("data", (chunk) => {
	rawBuf = Buffer.concat([rawBuf, chunk]);
	processRawBuf();
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

diagLog(`[smart-web-search-mcp] MCP stdio server ready (tool: ${TOOL_NAME}, executor: spawn-per-call)`);
diagLog("[smart-web-search-mcp] awaiting JSON-RPC on stdin");
