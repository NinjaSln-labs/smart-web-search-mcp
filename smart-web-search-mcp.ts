/**
 * Smart Web Search — 5-provider fusion search + fetch (MCP/CLI core)
 *
 * 本文件是纯 CLI 引擎：由 smart-web-search-mcp-server.mjs 以 spawn-per-call 拉起，
 * pi 等客户端统一经内置 MCP 使用（不再提供 pi 扩展模式）。
 *
 * 暴露给 LLM 的工具 (2 个): `smart_web_search`（5-provider 搜索）+ `smart_web_fetch`（URL→可读正文）
 * 内部按"梯次降级"策略依次调:
 *   L1 wigolo + keenable 并行 (均免费) → 任一足够则停，否则升 L2
 *   L2 tinyfish (wallet 消耗) → tavily (1000/月免费)  串行：tinyfish error/0 结果才升 tavily
 *   L3 serper (Google, 一次性 2500 免费后付费) → 不论结果如何都返回 (无条件兜底)
 *
 * 路由规则 v0 (用 1-2 周后按遥测 JSONL 调优; t000004 门槛＝v2 且 via∈{mcp,cli} 攒够 200 条):
 *   - LLM 显式 intent=news/paper/code/research → 直跳特定层
 *   - query 含 [今天/最新/本周/news] → 优先 tinyfish (L2) 的新闻能力
 *   - query 含 [arxiv/paper/论文]    → 优先 tinyfish L2 (domain_type=research_paper)
 *   - query 含 [extract/crawl/map]   → 跳过 tinyfish, 直走 L2 tavily (tinyfish 无这些工具)
 *   - L1 全空/不足             → 升 L2
 *   - L2 (tinyfish) error/0     → L2 内串行升 tavily
 *   - L2 仍不满足              → 无条件升 L3 serper (兜底; 烧 serper 查询额度)
 *
 * **详尽状态日志**（遥测 v2）每条搜索落一行 JSONL — 这是路由策略调优的唯一源数据，
 * CLI/MCP 路径共用同一装配点（v1 时代只有已退役的 pi 扩展写，10-02 转内置 MCP 后生产流量零样本）。
 * 默认 ~/.local/state/smart-web-search/smart_web_search.jsonl（SMART_WS_LOG_PATH 覆盖；首次自动迁入旧 ~/.pi/log 历史文件）
 * 每行: v / ts / request_id / tool / via / version / input / hints / providers / chain[] / final
 *   chain[]: 每层的 provider/tool/params/result{status,latency_ms,credits_used,skip_reason,raw_text,...}
 *   final: stopped_at / output_mode / total_latency_ms(Σ各层) / wall_ms(端到端) / total_credits_used / l1_sufficient / l2_sufficient / l1_status
 * 体积: 超 SMART_WS_LOG_MAX_BYTES(默认 8MiB) rename 成带时间戳的兄弟文件，永不删；
 *       SMART_WS_LOG_RAW=0 剥各层 raw_text；SMART_WS_LOG_STALE_DAYS(默认 7) 日志陈旧时 stderr 告警。
 *
 * **不**写路由器对 LLM 透明路由的"全自动"工具 — 让 LLM 显式看到 chain 元信息
 * 这样 LLM 能感知"我的 L1 失败了，下次直接 L2"，也方便事后看 LLM 怎么用。
 *
 * 各 provider 的 client 都内联在本文件（避免跨模块 import 耦合）。
 * tinyfish 和 tavily 用相同模式 (Streamable HTTP MCP)，代码基本一致。
 * wigolo 用 stdio MCP (spawn npx -y wigolo)。serper 用纯 REST (POST + X-API-KEY)。
 *
 * @see docs/llm/smart-web-search.md (本仓库)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const TAVILY_REMOTE_MCP_URL = "https://mcp.tavily.com/mcp/";
const TINYFISH_REMOTE_MCP_URL = "https://agent.tinyfish.ai/mcp";
const KEENABLE_MCP_URL = "https://api.keenable.ai/mcp";
const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const SERPER_SCRAPE_URL = "https://scrape.serper.dev";

const WIGOLO_BIN_CANDIDATES: ReadonlyArray<{ cmd: string; args: string[]; shell?: boolean }> = process.platform === "win32"
	? [
			{ cmd: "wigolo.cmd", args: [], shell: true },
			{ cmd: "npx.cmd", args: ["-y", "wigolo"], shell: true },
			{ cmd: "npx", args: ["-y", "wigolo"], shell: true },
		]
	: [{ cmd: "wigolo", args: [] }, { cmd: "npx", args: ["-y", "wigolo"] }];

const VERSION = "0.4.0";
const LOG_SCHEMA_V = 2;

// 运行期状态目录：XDG state。日志与 throttle 状态原本住 pi 专属的 ~/.pi/log/，
// 但本工具现在是 13 家客户端共用的 MCP server（d000003 起 pi 也走内置 MCP），不再寄生 pi 目录。
function stateDir(): string {
	return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}
const LEGACY_LOG_PATH = join(homedir(), ".pi", "log", "smart_web_search.jsonl");
const LOG_PATH = process.env.SMART_WS_LOG_PATH || join(stateDir(), "smart-web-search", "smart_web_search.jsonl");
const LOG_DIR = dirname(LOG_PATH);
// Keenable public tier (no key): auto-throttle on 429 to respect the 1K/hour shared limit
const KEENABLE_THROTTLE_PATH = join(LOG_DIR, "keenable_throttle");

// ═══════════════════════════════════════════════════════════════════════
// Layer 1: Wigolo stdio MCP client
// ═══════════════════════════════════════════════════════════════════════

interface MCPContentPart { type: string; text: string; }

// M2：JSON-RPC 消息的最小形状（unknown 收窄用，不引第三方类型）
interface JsonRpcResponse { error?: { message?: string }; result?: unknown }

class WigoloClient {
	private proc: ChildProcess | null = null;
	private ready: Promise<void> | null = null;
	private reqId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private buf = "";

	async callTool(name: string, args: Record<string, unknown>): Promise<{ content: MCPContentPart[]; isError?: boolean }> {
		await this.ensure();
		const resp = await this.request("tools/call", { name, arguments: args ?? {} });
		if (resp?.error) throw new Error(`wigolo ${name}: ${resp.error.message ?? JSON.stringify(resp.error)}`);
		return resp?.result as { content: MCPContentPart[]; isError?: boolean };
	}

	private async ensure(): Promise<void> {
		if (this.proc) return;
		if (this.ready) {
			try { await this.ready; } catch (e) { this.ready = null; throw e; }
			return;
		}
		this.ready = this.spawn();
		try { await this.ready; }
		catch (e) { this.ready = null; this.proc = null; throw e; }
	}

	private async spawn(): Promise<void> {
		let lastErr: Error | null = null;
		for (const c of WIGOLO_BIN_CANDIDATES) {
			try {
				const proc = spawn(c.cmd, c.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env, shell: c.shell ?? false });
				await new Promise<void>((resolve, reject) => {
					const onExit = (code: number | null) => reject(new Error(`exited immediately (code ${code})`));
					proc.once("exit", onExit);
					setTimeout(() => { proc.removeListener("exit", onExit); resolve(); }, 500);
				});
				this.proc = proc;
				this.attachHandlers(proc);
				const initResp = await this.request("initialize", {
					protocolVersion: "2025-11-25", capabilities: {},
					clientInfo: { name: "pi-smart-web-search-wigolo", version: "1.0" },
				});
				if (initResp?.error) throw new Error(`wigolo init: ${initResp.error.message}`);
				this.notify("notifications/initialized", {});
				return;
			} catch (err) { lastErr = err instanceof Error ? err : new Error(String(err)); }
		}
		throw new Error(`wigolo spawn failed: ${lastErr?.message ?? "unknown"}. Install with: npm i -g wigolo (then restart pi).`);
	}

	/** 优化1：预热——提前 spawn + initialize，消除首次搜索的冷启动（工厂注册时调一次）。
	 *  失败静默：正式调用时 ensure() 会重试并向调用方报错。 */
	warmup(): void {
		this.ensure().catch(() => {});
	}

	/** 关闭子进程（调用一次即可，幂等）。 */
	close(): void {
		if (!this.proc) return;
		const proc = this.proc;
		this.proc = null;
		this.ready = null;
		for (const { reject } of this.pending.values()) reject(new Error("closed"));
		this.pending.clear();
		proc.kill();
	}

	private attachHandlers(proc: ChildProcess): void {
		proc.stdout!.setEncoding("utf8");
		proc.stdout!.on("data", (c: string) => this.onData(c));
		proc.stderr!.setEncoding("utf8");
		proc.stderr!.on("data", (c: string) => {
			// wigolo 0.2.x writes NDJSON telemetry to stderr ({"ts":...,"level":"info|warn|error",...}).
			// Policy (09-08, v3): drop ALL of it. Even warn-level lines (breaker reopens — routine
			// during degraded recovery) landed in the pi input area and the user flagged it.
			// wigolo health is already observable via tool responses + JSONL chain logs.
			// Debug escape hatch: SMART_WS_DEBUG_STDERR=1 re-enables filtered forwarding
			// (complete warn/error/fatal lines only, [wigolo/smart] prefix).
			if (process.env.SMART_WS_DEBUG_STDERR !== "1") return;
			const lines = c.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (trimmed.startsWith("{")) {
					if (!trimmed.endsWith("}")) continue; // truncated fragment at chunk boundary
					let lvl = "";
					try {
						lvl = String(JSON.parse(trimmed).level ?? "").toLowerCase();
					} catch {
						lvl = (trimmed.match(/"level"\s*:\s*"([^"]+)"/) ?? [])[1]?.toLowerCase() ?? "";
					}
					if (lvl === "error" || lvl === "warn" || lvl === "fatal") {
						process.stderr.write(`[wigolo/smart] ${trimmed}\n`);
					}
					continue; // per-line, not per-chunk (bug in v1/v2: return skipped remaining lines)
				}
				// Legacy plain-text health logs (older wigolo) — always noise
				if (/^(orchestrator|breaker|engine|pool|cache|warmup|ready|starting|loading)/i.test(trimmed)) continue;
				process.stderr.write(`[wigolo/smart] ${trimmed}\n`);
			}
		});
		proc.on("exit", () => { this.proc = null; this.ready = null; for (const { reject } of this.pending.values()) reject(new Error("wigolo exited")); this.pending.clear(); });
		proc.on("error", () => { this.proc = null; this.ready = null; for (const { reject } of this.pending.values()) reject(new Error("wigolo spawn error")); this.pending.clear(); });
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		const lines = this.buf.split("\n");
		this.buf = lines.pop() ?? "";
		for (const l of lines) {
			const t = l.trim(); if (!t) continue;
			let m: JsonRpcResponse; try { m = JSON.parse(t) as JsonRpcResponse; } catch { continue; }
			if (typeof m.id === "number" && this.pending.has(m.id)) {
				const { resolve, reject } = this.pending.get(m.id)!;
				this.pending.delete(m.id);
				if (m.error) reject(new Error(m.error.message ?? JSON.stringify(m.error))); else resolve(m);
			}
		}
	}

	private request(method: string, params: unknown): Promise<JsonRpcResponse> {
		return new Promise((resolve, reject) => {
			if (!this.proc?.stdin?.writable) { reject(new Error("wigolo not running")); return; }
			const id = this.reqId++; this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (e) => { if (e) { this.pending.delete(id); reject(e); } });
		});
	}

	private notify(method: string, params: unknown): void {
		if (!this.proc?.stdin?.writable) return;
		this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Layer 2 MCP clients: Generic Streamable HTTP (tinyfish + tavily, serial pair)
// ═══════════════════════════════════════════════════════════════════════

class HTTPClient {
	private sessionId: string | null = null;
	private lastUse = 0;
	private reqId = 1;
	private throttleFile?: string; // if set, write timestamp on 429
	// 显式字段（不用 TS parameter property——strip-only 模式不支持，裸 node 跑 e2e 需免 flag）
	private baseUrl: string;
	private headers: Record<string, string>;
	private label: string; // for logs

	constructor(
		baseUrl: string,
		headers: Record<string, string>,
		label: string,
		throttleFile?: string,
	) {
		this.baseUrl = baseUrl;
		this.headers = headers;
		this.label = label;
		this.throttleFile = throttleFile;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<{ content: MCPContentPart[]; isError?: boolean; _meta?: Record<string, unknown>; _rawHeaders?: Record<string, string> }> {
		// C5：session 刷新串行化——并发 callTool 时保证 400/401 重登 → 重试不被另一
		// 调用者用旧 sessionId 抢跑（同一实例多调用时的竞态隐患）。
		return this.locked(() => this.callToolInner(name, args));
	}

	// C5：promise 链锁——前一个操作（含 session 刷新）完成前，后一个不进入。
	private sessionLock: Promise<void> = Promise.resolve();
	private locked<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.sessionLock.then(() => fn(), () => fn());
		this.sessionLock = run.then(() => undefined, () => undefined);
		return run;
	}

	private async callToolInner(name: string, args: Record<string, unknown>): Promise<{ content: MCPContentPart[]; isError?: boolean; _meta?: Record<string, unknown>; _rawHeaders?: Record<string, string> }> {
		await this.ensureSession();
		const body = { jsonrpc: "2.0", id: this.reqId++, method: "tools/call", params: { name, arguments: args ?? {} } };
		const resp = await this.post(body, this.sessionId!);
		this.lastUse = Date.now();
		if (resp.ok) return this.parseResponse(resp);
		if (resp.status === 400 || resp.status === 401) {
			this.sessionId = null; await this.ensureSession();
			const retry = await this.post(body, this.sessionId!);
			if (retry.ok) return this.parseResponse(retry);
			throw new Error(`${this.label} MCP error ${retry.status}: ${(await retry.text().catch(() => "")).slice(0, 500)}`);
		}
		// Rate-limit: write throttle marker so future calls back off
		// 注意：必须覆盖写（writeFileSync）——appendFileSync 会把多个时间戳拼成一串，
		// 读侧 Number() 得天文数字 ⇒ 冷却判定恒真、公共层被永久跳过。
		if (resp.status === 429 && this.throttleFile) {
			try {
				mkdirSync(dirname(this.throttleFile), { recursive: true });
				writeFileSync(this.throttleFile, String(Date.now()), "utf8");
			} catch {}
		}
		throw new Error(`${this.label} MCP error ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 500)}`);
	}

	private async ensureSession(): Promise<void> {
		if (this.sessionId && Date.now() - this.lastUse < 5 * 60 * 1000) return;
		const initBody = {
			jsonrpc: "2.0", id: this.reqId++, method: "initialize",
			params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: `pi-smart-web-search-${this.label}`, version: "1.0" } },
		};
		const resp = await fetch(this.baseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...this.headers },
			body: JSON.stringify(initBody),
		});
		if (!resp.ok) {
			throw new Error(`${this.label} MCP initialize: HTTP ${resp.status}`);
		}
		// Try header first (tinyfish), then SSE data (tavily)
		let sid = resp.headers.get("mcp-session-id");
		if (!sid) {
			// Tavily returns session id inside SSE data
			const ct = resp.headers.get("content-type") || "";
			if (ct.includes("text/event-stream")) {
				const text = await resp.text();
				const parts = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
				if (parts.length > 0) {
					try {
						const parsed = JSON.parse(parts.join(""));
						sid = parsed?.result?.sessionId ?? parsed?.result?.session_id ?? null;
					} catch {}
				}
			}
		}
		if (!sid) {
			// As a last resort, reuse the same initialize request id as the session id
			// (works for servers that don't use explicit session tracking)
			sid = String(initBody.id);
		}
		this.sessionId = sid; this.lastUse = Date.now();
		// initialized notification (fire and forget)
		fetch(this.baseUrl, {
			method: "POST", headers: { "Content-Type": "application/json", ...this.headers, "mcp-session-id": sid! },
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		}).catch(() => {});
	}

	private post(body: unknown, sessionId: string): Promise<Response> {
		return fetch(this.baseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...this.headers, "mcp-session-id": sessionId },
			body: JSON.stringify(body),
		});
	}

	private async parseResponse(resp: Response): Promise<{ content: MCPContentPart[]; isError?: boolean; _meta?: Record<string, unknown>; _rawHeaders: Record<string, string> }> {
		const ct = resp.headers.get("content-type") || "";
		// M2：unknown 收窄（错误形状 / result 形状就地声明，不引第三方类型）
		let parsed: { error?: { message?: string }; result?: { content?: MCPContentPart[]; isError?: boolean; _meta?: Record<string, unknown> } } | null;
		if (ct.includes("text/event-stream")) {
			const text = await resp.text();
			const parts = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
			if (parts.length === 0) throw new Error(`${this.label} empty SSE`);
			parsed = JSON.parse(parts.join(""));
		} else {
			parsed = JSON.parse(await resp.text());
		}
		// Capture rate-limit / credit-related headers for logging
		const hdrs: Record<string, string> = {};
		resp.headers.forEach((v, k) => {
			const lk = k.toLowerCase();
			if (lk.includes("rate") || lk.includes("credit") || lk.includes("quota") || lk.includes("limit") || lk.includes("x-ratelimit") || lk.includes("x-credits")) {
				hdrs[k] = v;
			}
		});
		if (parsed?.error) throw new Error(`${this.label} error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
		return { content: parsed?.result?.content ?? [], isError: parsed?.result?.isError, _meta: parsed?.result?._meta, _rawHeaders: hdrs };
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Layer 3: Serper REST client (Google index; POST + X-API-KEY, not MCP)
// ═══════════════════════════════════════════════════════════════════════

// v1: direct fetch only (proxy fallback via dynamic undici import deferred).
// Response normalized to {results:[{title,url,content,source}]} so downstream
// parseGenericMetrics / postFilterResults / runLayer work unchanged.
class SerperClient {
	private apiKey: string; // 显式字段（strip-only 兼容，同 HTTPClient）

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	// recency → Serper tbs: day/week/month/year → qdr:d/w/m/y
	private static tbsFor(recency: string | null | undefined): string | undefined {
		const map: Record<string, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
		return recency ? map[recency] : undefined;
	}

	async search(query: string, opts: { num: number; recency?: string | null; site?: string | null }): Promise<{ content: MCPContentPart[]; _rawHeaders: Record<string, string> }> {
		const q = opts.site ? `${query} site:${opts.site}` : query;
		const body: Record<string, unknown> = { q, num: Math.min(Math.max(opts.num, 1), 10) };
		const tbs = SerperClient.tbsFor(opts.recency);
		if (tbs) body.tbs = tbs;
		const resp = await fetch(SERPER_SEARCH_URL, {
			method: "POST",
			headers: { "X-API-KEY": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
		});
		if (!resp.ok) {
			throw new Error(`serper HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
		}
		const data = await resp.json().catch(() => null) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> } | null;
		const results = (data?.organic ?? [])
			.filter((r) => r?.link)
			.map((r) => ({ title: r.title ?? "", url: r.link, content: r.snippet ?? "", source: "serper" }));
		const hdrs: Record<string, string> = {};
		resp.headers.forEach((v, k) => { const lk = k.toLowerCase(); if (lk.includes("ratelimit") || lk.includes("remaining") || lk.includes("quota")) hdrs[k] = v; });
		return { content: [{ type: "text", text: JSON.stringify({ results }) }], _rawHeaders: hdrs };
	}

	// fetch 专用：scrape.serper.dev（按页计费，2 credits/page 量级）
	async scrape(url: string, timeoutMs: number): Promise<{ text: string; title: string; credits: number | null }> {
		const resp = await fetch(SERPER_SCRAPE_URL, {
			method: "POST",
			headers: { "X-API-KEY": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ url }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!resp.ok) throw new Error(`serper scrape HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
		const data = await resp.json().catch(() => null) as { text?: string; markdown?: string; metadata?: { title?: string }; credits?: number } | null;
		return {
			text: data?.text ?? data?.markdown ?? "",
			title: data?.metadata?.title ?? "",
			credits: typeof data?.credits === "number" ? data.credits : null,
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Key resolution:
//   L1 wigolo + keenable: both always on, run in parallel
//   L2 tinyfish → tavily: serial pair. tinyfish opt-OUT (key on disk → use it);
//      tavily opt-IN (1000/month cap).
//   L3 serper: opt-IN (Google index; one-time 2500 free queries then paid).
//
// tinyfish doesn't need opt-in: it has wallet-based billing (you already pay
// as you go, no subscription). So if the key is on disk, just use it.
// tavily + serper need opt-in: both have hard quota caps (tavily 1000/month,
// serper 2500 lifetime then pay-per-use); we don't want a fresh install to
// auto-enable and burn credits without intent.
// ═══════════════════════════════════════════════════════════════════════

interface SmartProviderConfig {
	enabled?: boolean;          // only used for tavily opt-in; tinyfish ignores this
	key?: string;               // explicit key override
	notes?: string;
}

interface SmartConfig {
	tinyfish?: SmartProviderConfig;
	tavily?: SmartProviderConfig;
	keenable?: SmartProviderConfig;
	serper?: SmartProviderConfig;
}

// SMART_WS_CONFIG_PATH：测试/多实例覆盖位（e2e 用它指向 0600 临时副本，不改生产凭据文件）
const SMART_CONFIG_PATH = process.env.SMART_WS_CONFIG_PATH
	|| join(homedir(), ".pi", "agent", "extensions", "smart-web-search-mcp.config.json");

// 优化4：resolver 每次调用都 existsSync+readFileSync 小 JSON（cursor mcp.json 等）
// ——按 mtime 缓存，配置变更（mtime 变）自动失效，与 clients 热重载语义一致。
const jsonFileCache = new Map<string, { mtimeMs: number; data: unknown }>();
function readJsonCached(path: string): unknown | null {
	try {
		const mtimeMs = statSync(path).mtimeMs;
		const hit = jsonFileCache.get(path);
		if (hit && hit.mtimeMs === mtimeMs) return hit.data;
		const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
		jsonFileCache.set(path, { mtimeMs, data });
		return data;
	} catch { return null; }
}

function loadSmartConfig(): SmartConfig {
	try {
		if (existsSync(SMART_CONFIG_PATH)) {
			return JSON.parse(readFileSync(SMART_CONFIG_PATH, "utf8")) as SmartConfig;
		}
	} catch (e) {
		process.stderr.write(`[smart_web_search] config parse failed: ${e}\n`);
	}
	return {};
}

/**
 * Resolve a provider's key. Rules:
 *   L2 tinyfish: if config says enabled:false, skip. Otherwise look for key
 *               in (config.key > env > ~/.cursor/mcp.json) and use it.
 *               If no key found, skip (don't waste calls).
 *   L3 tavily: if config says enabled:true, use config.key or env or models.json
 *               or ~/.cursor/mcp.json. If not enabled in config, skip.
 *   keenable: opt-IN with key, else public tier (1K/hour shared). See resolveKeenableConfig.
 *   serper: opt-IN (L3 fallback, paid after 2500 free). See resolveSerperConfig.
 */
function resolveProviderKey(name: "tinyfish" | "tavily" | "keenable", smartCfg: SmartConfig): { enabled: boolean; key: string | null; source: string } {
	const cfg = smartCfg[name];
	// 1. explicit key in config (works for both, regardless of enabled flag for tinyfish)
	if (cfg?.key && cfg.key.length > 0) {
		return { enabled: true, key: cfg.key, source: "config-key" };
	}
	if (name === "tinyfish") {
		// tinyfish: opt-OUT only (enabled:false in config disables it; otherwise use key)
		if (cfg?.enabled === false) {
			return { enabled: false, key: null, source: "config-disabled" };
		}
		// look for key
		if (process.env.TINYFISH_API_KEY) return { enabled: true, key: process.env.TINYFISH_API_KEY, source: "env" };
		try {
			const c = readJsonCached(join(homedir(), ".cursor", "mcp.json")) as { mcpServers?: { tinyfish?: { headers?: Record<string, string> } } } | null;
			if (c) {
				const k = c?.mcpServers?.tinyfish?.headers?.["X-API-Key"];
				if (k) return { enabled: true, key: k, source: "~/.cursor/mcp.json" };
			}
		} catch {}
		return { enabled: false, key: null, source: "no-key-found" };
	} else {
		// tavily: opt-IN (must have enabled:true in config; key can come from anywhere)
		if (cfg?.enabled !== true) {
			return { enabled: false, key: null, source: "config-disabled" };
		}
		if (process.env.TAVILY_API_KEY) return { enabled: true, key: process.env.TAVILY_API_KEY, source: "env" };
		try {
			const c = readJsonCached(join(homedir(), ".pi", "agent", "models.json")) as { providers?: { tavily?: { apiKey?: string } } } | null;
			if (c) {
				const k = c?.providers?.tavily?.apiKey;
				if (k) return { enabled: true, key: k, source: "models.json" };
			}
		} catch {}
		try {
			const c = readJsonCached(join(homedir(), ".cursor", "mcp.json")) as { mcpServers?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> } | undefined> } | null;
			if (c) {
				const k = c?.mcpServers?.tavily?.env?.TAVILY_API_KEY
					?? c?.mcpServers?.tavily?.headers?.["X-API-Key"]
					?? c?.mcpServers?.["tavily-remote-mcp"]?.env?.TAVILY_API_KEY;
				if (k) return { enabled: true, key: k, source: "~/.cursor/mcp.json" };
			}
		} catch {}
		return { enabled: true, key: null, source: "no-key-found" };
	}
}

function resolveKeenableConfig(smartCfg: SmartConfig): { enabled: boolean; key: string | null; source: string } {
	const cfg = smartCfg.keenable;
	// 1. explicit key in config
	if (cfg?.key && cfg.key.length > 0) {
		return { enabled: true, key: cfg.key, source: "config-key" };
	}
	// 2. opt-IN required (unlike tinyfish which is opt-OUT)
	if (cfg?.enabled === false) {
		return { enabled: false, key: null, source: "config-disabled" };
	}
	// 3. env or cursor config
	if (process.env.KEENABLE_API_KEY) return { enabled: true, key: process.env.KEENABLE_API_KEY, source: "env" };
	try {
		const c = readJsonCached(join(homedir(), ".cursor", "mcp.json")) as { mcpServers?: { keenable?: { headers?: Record<string, string> } } } | null;
		if (c) {
			const k = c?.mcpServers?.keenable?.headers?.["X-API-Key"];
			if (k) return { enabled: true, key: k, source: "~/.cursor/mcp.json" };
		}
	} catch {}
	// No key → public tier (1K/hour rate limit, no credit allowance)
	return { enabled: true, key: null, source: "public-tier" };
}

/** serper: opt-IN (L3 fallback, paid after 2500 one-time free queries). Key from
 *  (config.key > env SERPER_API_KEY). Must have enabled:true in config. */
function resolveSerperConfig(smartCfg: SmartConfig): { enabled: boolean; key: string | null; source: string } {
	const cfg = smartCfg.serper;
	if (cfg?.enabled !== true) {
		return { enabled: false, key: null, source: "config-disabled" };
	}
	if (cfg?.key && cfg.key.length > 0) return { enabled: true, key: cfg.key, source: "config-key" };
	if (process.env.SERPER_API_KEY) return { enabled: true, key: process.env.SERPER_API_KEY, source: "env" };
	return { enabled: true, key: null, source: "no-key-found" };
}

// ─── Keenable public-tier throttle（429 冷却判定，pi/CLI 双路共用）────
// 429 时 HTTPClient.callTool 写 KEENABLE_THROTTLE_PATH（时间戳）；60s 冷却内跳过 keenable。
// 只认单个毫秒时间戳：拼接（t000018 原缺陷）会拼成天文数字，Date.now()-ts 恒负 ⇒ 冷却永久为真；
// 未来值同理不可信。两种都按脏文件处理、不算冷却。
export function throttleTsFrom(raw: string, now: number): number | null {
	const ts = Number(raw.trim());
	if (!Number.isFinite(ts) || ts <= 0 || ts > now + 5_000) return null;
	return ts;
}

function isKeenableThrottled(): boolean {
	try {
		if (!existsSync(KEENABLE_THROTTLE_PATH)) return false;
		const ts = throttleTsFrom(readFileSync(KEENABLE_THROTTLE_PATH, "utf8"), Date.now());
		return ts !== null && Date.now() - ts < 60_000; // 60s cooldown
	} catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════
// JSONL logger
// ═══════════════════════════════════════════════════════════════════════

let logMigrated = false;

function ensureLogDir(): void {
	try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
	if (logMigrated) return;
	logMigrated = true;
	// 落位迁移（v1→v2）：历史样本是路由调优的对照基线，整体 rename 到新默认位置，
	// 新位置已有文件则不动（不覆盖、不删）。rename 原子 ⇒ 并发 spawn 只有一个成功。
	// 只搬给**默认**位置：设了 SMART_WS_LOG_PATH（测试隔离用）就不动历史文件，
	// 否则一次带临时路径的运行会把生产历史整个挪走、原址清空。
	try {
		if (!process.env.SMART_WS_LOG_PATH && !existsSync(LOG_PATH) && existsSync(LEGACY_LOG_PATH)) {
			renameSync(LEGACY_LOG_PATH, LOG_PATH);
		}
	} catch {}
}

// 落盘前闸：体积轮转 + 陈旧自观测。任何异常都吞掉——遥测坏了不能连带搜索失败。
let staleWarned = false;

function logPrecheck(): void {
	try {
		const st = statSync(LOG_PATH);
		const staleDays = Number(process.env.SMART_WS_LOG_STALE_DAYS ?? 7);
		if (!staleWarned && staleDays > 0 && Date.now() - st.mtimeMs > staleDays * 86_400_000) {
			staleWarned = true;
			process.stderr.write(`[smart_web_search] WARN: telemetry log stale since ${new Date(st.mtimeMs).toISOString()} (${LOG_PATH})\n`);
		}
		const cap = Number(process.env.SMART_WS_LOG_MAX_BYTES ?? 8_388_608);
		if (cap > 0 && st.size >= cap) {
			const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
			renameSync(LOG_PATH, `${LOG_PATH}.${stamp}`);
		}
	} catch {}
}

function writeLog(entry: Record<string, unknown>): void {
	ensureLogDir();
	logPrecheck();
	try {
		// 优化3：raw_text 全文（wigolo 大 JSON）会让 JSONL 长期膨胀。
		// SMART_WS_LOG_RAW=0 时落盘前剥离各 chain 条目的 raw_text（省 <95% 体积，
		// result_count/status 等指标保留，t000004 重算不受影响）。
		if (process.env.SMART_WS_LOG_RAW === "0" && Array.isArray(entry.chain)) {
			entry.chain = (entry.chain as Array<Record<string, unknown>>).map((c) => {
				const r = c?.result as Record<string, unknown> | undefined;
				if (r && typeof r === "object" && typeof r.raw_text === "string") {
					return { ...c, result: { ...r, raw_text: `[omitted ${r.raw_text.length}B]` } };
				}
				return c;
			});
		}
		appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
	} catch (e) {
		process.stderr.write(`[smart_web_search] log write failed: ${e}\n`);
	}
}

// provider 配置态 label（原在 factory 闭包内，CLI/MCP 路径拿不到 ⇒ 上移为模块级共用）
function providerLabel(res: { enabled: boolean; key: string | null; source: string }, isKeenable = false): string {
	if (!res.enabled) return "DISABLED (config)";
	if (res.key) return `enabled (key: ${res.source})`;
	return isKeenable ? "PUBLIC TIER (no key, 1K/hour limit)" : `ENABLED BUT NO KEY (set ${res.source} or edit config)`;
}

function providersSnapshot(res: {
	keenableRes: { enabled: boolean; key: string | null; source: string };
	tinyfishRes: { enabled: boolean; key: string | null; source: string };
	tavilyRes: { enabled: boolean; key: string | null; source: string };
	serperRes: { enabled: boolean; key: string | null; source: string };
}): Record<string, string> {
	return {
		keenable: providerLabel(res.keenableRes, true),
		tinyfish: providerLabel(res.tinyfishRes),
		tavily: providerLabel(res.tavilyRes),
		serper: providerLabel(res.serperRes),
	};
}

// 遥测来源标签：显式 SMART_WS_VIA 一律优先（.mjs 注入 mcp、e2e 注入 test），否则按代码路径。
function viaTag(fallback: string): string {
	return process.env.SMART_WS_VIA || fallback;
}

interface SearchLogArgs {
	via: string;
	requestId: string;
	t0: number;
	input: SearchInput;
	maxResults: number;
	depth: string;
	hints: RoutingHints;
	chain: LayerCall[];
	stoppedAt: number;
	outputFormat: string;
	totalCredits: number;
	l1Sufficient: boolean;
	l2Sufficient: boolean;
	l1Status: string;
	providers: Record<string, string>;
}

/**
 * 遥测 v2 条目装配 + L1 装饰——两条执行路径共用同一函数、传同一 chain 引用。
 * 旧 pi 版在 execute() 里内联装配并把 stop_reason 无条件写成 "ok"，
 * 把 status==="skipped" 的 L1 条目也盖掉（实况污染 58 行）⇒ 装饰加守卫，skip 另由 skip_reason 承载。
 */
function buildSearchLogEntry(a: SearchLogArgs): Record<string, unknown> {
	for (const c of a.chain) {
		if (c.layer !== 1) continue;
		c.result.sub_providers = [c.provider];
		if (c.result.status === "skipped") continue;
		if (a.l1Sufficient || a.l2Sufficient) c.result.stop_reason = "ok";
	}
	return {
		v: LOG_SCHEMA_V,
		ts: new Date().toISOString(),
		request_id: a.requestId,
		tool: "smart_web_search",
		via: viaTag(a.via),
		version: VERSION,
		input: {
			query: a.input.query, max_results: a.maxResults, intent: a.input.intent ?? null,
			recency: a.input.recency ?? null, include_domains: a.input.include_domains ?? null,
			depth: a.depth, location: a.input.location ?? null,
		},
		hints: {
			news: a.hints.newsMode, paper: a.hints.paperMode, code: a.hints.codeMode,
			research: a.hints.researchMode, extract_crawl: a.hints.extractCrawl, domain_type: a.hints.domainType,
		},
		providers: a.providers,
		chain: a.chain,
		final: {
			stopped_at: a.stoppedAt,
			output_mode: a.outputFormat,
			total_latency_ms: a.chain.reduce((s, c) => s + c.result.latency_ms, 0),
			wall_ms: Date.now() - a.t0,
			total_credits_used: a.totalCredits,
			l1_sufficient: a.l1Sufficient,
			l2_sufficient: a.l2Sufficient,
			l1_status: a.l1Status,
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Intent inference (query keyword → routing hints)
// ═══════════════════════════════════════════════════════════════════════

/** "a.com, b.com" → ["a.com","b.com"]; null/empty → [] */
function splitDomainList(s: string | null | undefined): string[] {
	if (!s) return [];
	return s.split(",").map((d) => d.trim()).filter(Boolean);
}

/** Single-domain providers (keenable `site`): first domain or null */
function firstDomainOrNull(s: string | null | undefined): string | null {
	return splitDomainList(s)[0] ?? null;
}

interface RoutingHints {
	newsMode: boolean;
	paperMode: boolean;
	codeMode: boolean;
	researchMode: boolean;
	extractCrawl: boolean;
	domainType: "research_paper" | "news" | null;
}

function inferHints(query: string, userIntent: string | null): RoutingHints {
	const h: RoutingHints = {
		newsMode: false, paperMode: false,
		codeMode: false, researchMode: false, extractCrawl: false, domainType: null,
	};
	// explicit intent wins
	if (userIntent === "news") { h.newsMode = true; h.domainType = "news"; }
	if (userIntent === "paper") { h.paperMode = true; h.domainType = "research_paper"; }
	if (userIntent === "code") { h.codeMode = true; }
	if (userIntent === "research") { h.researchMode = true; }
	// keyword inference
	if (/\b(today|news|最新|本周|last\s*week|this\s*week|breaking|headline)\b/i.test(query)) { h.newsMode = true; h.domainType = h.domainType ?? "news"; }
	if (/\b(arxiv|paper|论文|research\s*paper|academic|preprint|doi:)/i.test(query)) { h.paperMode = true; h.domainType = h.domainType ?? "research_paper"; }
	if (/\b(github|stackoverflow|code|repo|repository|library\s*api|npm|pypi)\b/i.test(query)) { h.codeMode = true; }
	if (/\b(deep\s*research|comprehensive|thorough|深入|in.?depth)\b/i.test(query)) { h.researchMode = true; }
	if (/\b(extract|crawl|scrape|map)\b/i.test(query)) { h.extractCrawl = true; }
	return h;
}

// ═══════════════════════════════════════════════════════════════════════
// Result parsing helpers — extract metrics for logging
// ═══════════════════════════════════════════════════════════════════════

function parseWigoloMetrics(text: string): { resultCount: number; enginePool: unknown; degraded: boolean } {
	try {
		const rec = JSON.parse(text) as { results?: unknown; engine_pool?: { degraded?: boolean } | null } | null;
		const results = rec?.results;
		const pool = rec?.engine_pool;
		return {
			resultCount: Array.isArray(results) ? results.length : 0,
			enginePool: pool ?? null,
			degraded: pool?.degraded === true,
			// Note: healthy < total is normal variance (engines come/go). Only explicit
			// pool.degraded=true means the engine pool self-reported trouble.
		};
	} catch { return { resultCount: 0, enginePool: null, degraded: false }; }
}

function parseGenericMetrics(text: string): { resultCount: number } {
	// tinyfish + tavily return JSON in their text; try to count
	try {
		const obj = JSON.parse(text);
		const results = obj?.results;
		if (Array.isArray(results)) return { resultCount: results.length };
		if (Array.isArray(obj)) return { resultCount: obj.length };
		return { resultCount: obj?.results?.length ?? 0 };
	} catch { return { resultCount: 0 }; }
}

/**
 * Post-filter: truncate a provider's raw_text JSON results array to maxResults.
 * Handles wigolo prefix notices (e.g. "[wigolo notice] ...\n") by finding the first JSON token.
 * Appends a truncation note when results were trimmed.
 */
function postFilterResults(rawText: string, maxResults: number): string {
	if (!rawText || maxResults <= 0) return rawText;
	// Find first { or [ to skip prefix notices
	const jsonStart = rawText.search(/[\{\[]/);
	if (jsonStart < 0) return rawText;
	const prefix = jsonStart > 0 ? rawText.slice(0, jsonStart) : "";
	let jsonStr = rawText.slice(jsonStart);
	try {
		const obj = JSON.parse(jsonStr);
		if (obj && typeof obj === "object" && Array.isArray(obj.results) && obj.results.length > maxResults) {
			const origCount = obj.results.length;
			obj.results = obj.results.slice(0, maxResults);
			jsonStr = JSON.stringify(obj, null, jsonStart > 0 ? 2 : 0);
			// C4：提示被截数量（origCount 是截前总数），让 LLM 感知结果被截断
			const note = jsonStart > 0
				? `\n\n[truncated: kept ${maxResults} of ${origCount} results]`
				: `\n[truncated: kept ${maxResults} of ${origCount} results]`;
			jsonStr += note;
		} else if (Array.isArray(obj) && obj.length > maxResults) {
			jsonStr = JSON.stringify(obj.slice(0, maxResults), null, 2);
		}
	} catch {
		// Not parseable JSON — return as-is
	}
	return prefix + jsonStr;
}

// ─── 输出统一化：provider 原始 JSON → 归一化 items → agent 可读文本/envelope ──
// 设计约定（方案定稿 v3.1）：
//   - 文本主通道 = 标签块（Title:/URL:/…），对齐 Exa/Tavily 官方 MCP 的输出形态
//   - 噪音零上浮：relevance_score/evidence_score/cached*/freshness_signal/position/id 等不出工具返回值
//   - 路由判定（l1Sufficient）不消费本节任何产物，仍吃各层 result_count 原始计数
//   - normalize 失败回退 raw_text（页脚 format=raw），绝不把有结果变无结果

interface UnifiedItem {
	title: string;
	url: string;
	snippet: string;
	published: string;
	source: string;
}

/** 从 provider raw_text 剥离前缀通知（如 "[wigolo notice] ..."），定位 JSON 起点 */
function stripJsonPrefix(rawText: string): { prefix: string; json: string } {
	const jsonStart = rawText.search(/[\{\[]/);
	if (jsonStart < 0) return { prefix: "", json: "" };
	return { prefix: rawText.slice(0, jsonStart), json: rawText.slice(jsonStart) };
}

/**
 * provider raw_text → UnifiedItem[]。
 * 字段映射（JSONL 176 请求实测）：wigolo{title,url,snippet,published_date} /
 * keenable{title,url} / tinyfish{title,url,snippet,date,site_name,publisher} /
 * serper{title,url,content,source} / tavily{title,url,content,published_date}。
 * 解析失败返回 []（调用方回退 raw_text）。
 */
function normalizeProviderText(provider: string, rawText: string): UnifiedItem[] {
	if (!rawText) return [];
	const { json } = stripJsonPrefix(rawText);
	if (!json) return [];
	let obj: unknown = null;
	try { obj = JSON.parse(json); } catch { return []; }
	const arr = obj && typeof obj === "object" && Array.isArray((obj as { results?: unknown }).results)
		? (obj as { results: unknown[] }).results
		: (Array.isArray(obj) ? obj : null);
	if (!arr) return [];
	const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
	return arr
		.filter((it): it is Record<string, unknown> => !!it && typeof it === "object" && !Array.isArray(it))
		.map((it) => ({
			title: str(it.title),
			url: str(it.url),
			snippet: str(it.snippet) || str(it.content),
			published: str(it.published_date) || str(it.date),
			source: str(it.site_name) || str(it.publisher) || str(it.source),
		}))
		.filter((it) => it.title || it.url);
}

/** L1 两源合并：按 url 去重（wigolo 优先），切片到 max。rawCount=去重前总数，dedupedCount=去重后总数 */
function mergeL1Items(wItems: UnifiedItem[], kItems: UnifiedItem[], max: number): { items: UnifiedItem[]; rawCount: number; dedupedCount: number } {
	const seen = new Set<string>();
	const deduped: UnifiedItem[] = [];
	for (const it of [...wItems, ...kItems]) {
		const key = it.url || it.title;
		if (key && seen.has(key)) continue;
		if (key) seen.add(key);
		deduped.push(it);
	}
	return { items: deduped.slice(0, max), rawCount: wItems.length + kItems.length, dedupedCount: deduped.length };
}

interface TextOutputCtx {
	stoppedAt: number;
	provider: string;
	dedupedCount: number;
	rawCount: number;
	layersTried: Array<{ provider: string; status: string; count: number }>;
	totalLatencyMs: number;
	formatRaw: boolean;
	/** format=raw 回退时的原始文本（items 为空但有 raw 结果时附在页脚前） */
	rawFallback?: string;
}

/** UnifiedItem[] → 标签块文本 + 一行页脚（kept 口径：Y=去重后、切片前） */
function assembleTextOutput(items: UnifiedItem[], ctx: TextOutputCtx): string {
	const dedupNote = ctx.dedupedCount < ctx.rawCount ? ` | dedup: ${ctx.rawCount}→${ctx.dedupedCount}` : "";
	const layers = ctx.layersTried.map((l) => `${l.provider}(${l.status} ${l.count})`).join(" → ");
	const footer = [
		`from L${ctx.stoppedAt} ${ctx.provider}`,
		`kept ${items.length} of ${ctx.dedupedCount}`,
		ctx.formatRaw ? "format=raw" : null,
		dedupNote,
		`layers: ${layers || "-"}`,
		`${ctx.totalLatencyMs}ms`,
	].filter(Boolean).join(" | ");
	if (items.length === 0) {
		if (ctx.formatRaw && ctx.rawFallback) return `${ctx.rawFallback}\n\n──\n${footer}`;
		const tried = ctx.layersTried.map((l) => l.provider).join(", ") || "none";
		return `No results found (layers tried: ${tried}).`;
	}
	const blocks = items.map((it, i) => {
		const lines = [`[${i + 1}] Title: ${it.title}`, `    URL: ${it.url}`];
		if (it.published) lines.push(`    Published: ${it.published}`);
		if (it.source) lines.push(`    Source: ${it.source}`);
		if (it.snippet) lines.push(`    Snippet: ${it.snippet}`);
		return lines.join("\n");
	});
	return `${blocks.join("\n\n")}\n\n──\n${footer}`;
}

/** json 模式 envelope（chain 只留白名单键；与 details.chain 对齐） */
function assembleEnvelope(query: string, items: UnifiedItem[], chain: LayerCall[], ctx: { stoppedAt: number; provider: string; totalLatencyMs: number; totalCredits: number; dedupedCount: number }): string {
	return JSON.stringify({
		query,
		results: items,
		meta: {
			stopped_at: ctx.stoppedAt,
			provider: ctx.provider,
			total_latency_ms: ctx.totalLatencyMs,
			total_credits_used: ctx.totalCredits,
			results_kept: items.length,
			results_before_truncation: ctx.dedupedCount,
		},
		chain: chain.map((c) => ({
			layer: c.layer, provider: c.provider, status: c.result.status,
			result_count: c.result.result_count, latency_ms: c.result.latency_ms, error: c.result.error,
		})),
	});
}

// ═══════════════════════════════════════════════════════════════════════
// Smart web search tool implementation
// ═══════════════════════════════════════════════════════════════════════

interface SearchInput {
	query: string;
	max_results?: number;
	intent?: "general" | "news" | "paper" | "code" | "research" | null;
	recency?: "day" | "week" | "month" | "year" | null;
	include_domains?: string | null;
	exclude_domains?: string | null;
	depth?: "basic" | "advanced" | null;
	location?: string | null;
	output_format?: "text" | "json" | null;
}

interface LayerCall {
	layer: 1 | 2 | 3;
	provider: "wigolo" | "tinyfish" | "tavily" | "keenable" | "serper";
	tool: string;
	params: Record<string, unknown>;
	result: {
		status: "ok" | "degraded" | "empty" | "error" | "timeout" | "skipped";
		result_count: number;
		latency_ms: number;
		engine_pool: unknown | null;
		credits_used: number;
		usage: Record<string, unknown> | null;
		rate_limit_headers: Record<string, string>;
		response_bytes: number;
		stop_reason: string | null;
		skip_reason: string | null;
		error: string | null;
		raw_text: string;
			sub_providers?: string[];
	};
	ts_start: string;
	ts_end: string;
}

async function runLayer(
	layer: 1 | 2 | 3,
	provider: "wigolo" | "tinyfish" | "tavily" | "keenable" | "serper",
	toolName: string,
	params: Record<string, unknown>,
	executor: () => Promise<{ content: MCPContentPart[]; _meta?: Record<string, unknown>; _rawHeaders?: Record<string, string> }>,
	timeoutMs: number,
	skipped = false,
	skipReason: string | null = null,
): Promise<LayerCall> {
	const tsStart = new Date().toISOString();
	if (skipped) {
		return {
			layer, provider, tool: toolName, params,
			result: { status: "skipped", result_count: 0, latency_ms: 0, engine_pool: null, credits_used: 0, usage: null, rate_limit_headers: {}, response_bytes: 0, stop_reason: "skipped", skip_reason: skipReason ?? "not_tried", error: null, raw_text: "" },
			ts_start: tsStart, ts_end: new Date().toISOString(),
		};
	}
	const t0 = Date.now();
	let timer: NodeJS.Timeout | null = null;
	try {
		const result = await Promise.race([
			executor(),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
		]);
		if (timer) clearTimeout(timer);
		const latency = Date.now() - t0;
		const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
		const responseBytes = text.length;
		let metrics: { resultCount: number; enginePool?: unknown; degraded?: boolean } = { resultCount: 0 };
		if (provider === "wigolo") metrics = parseWigoloMetrics(text);
		else metrics = parseGenericMetrics(text);
		const empty = metrics.resultCount === 0;
		const degraded = provider === "wigolo" && metrics.degraded === true;
		const status: LayerCall["result"]["status"] = empty ? "empty" : degraded ? "degraded" : "ok";
		// Credits: keenable reports per-call usage in _meta["keenable/usage"]
		let creditsUsed = 0;
		let usage: Record<string, unknown> | null = null;
		const metaUsage = result._meta?.["keenable/usage"];
		if (metaUsage && typeof metaUsage === "object") {
			const mu = metaUsage as Record<string, unknown>;
			usage = mu;
			creditsUsed = Number(mu.credits ?? mu.amount ?? 0) || 0;
		}
		// 优化2：tinyfish/tavily 也烧 credits，但两家不回传每调用用量明细；
		// best-effort 把 credit/quota 相关响应头记进 usage 供 JSONL 调优
		// （credits_used 无法可靠换算，保持 0，不做虚假统计）。
		if (usage === null && (provider === "tinyfish" || provider === "tavily")) {
			for (const [k, v] of Object.entries(result._rawHeaders ?? {})) {
				if (/credit|balance|quota|ratelimit|remaining/i.test(k)) {
					usage = { [k]: v };
					break;
				}
			}
		}
		return {
			layer, provider, tool: toolName, params,
			result: {
				status, result_count: metrics.resultCount, latency_ms: latency,
				engine_pool: metrics.enginePool ?? null, credits_used: creditsUsed,
				usage,
				rate_limit_headers: result._rawHeaders ?? {},
				response_bytes: responseBytes, stop_reason: status === "ok" ? "ok" : null, skip_reason: null, error: null,
				raw_text: text,
			},
			ts_start: tsStart, ts_end: new Date().toISOString(),
		};
	} catch (e) {
		if (timer) clearTimeout(timer);
		const latency = Date.now() - t0;
		const msg = e instanceof Error ? e.message : String(e);
		const status: LayerCall["result"]["status"] = msg.includes("timeout") ? "timeout" : "error";
		return {
			layer, provider, tool: toolName, params,
			result: { status, result_count: 0, latency_ms: latency, engine_pool: null, credits_used: 0, usage: null, rate_limit_headers: {}, response_bytes: 0, stop_reason: null, skip_reason: null, error: msg, raw_text: "" },
			ts_start: tsStart, ts_end: new Date().toISOString(),
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════
// 共享 L2/L3 级联（pi execute 与 CLI runCliSearch 双路共用，避免双源漂移 C3）
// ═══════════════════════════════════════════════════════════════════════

interface CascadeClients {
	tinyfish: HTTPClient | null;
	tavily: HTTPClient | null;
	serper: SerperClient | null;
}

interface CascadeResult {
	l2Sufficient: boolean;
	// L2 成功的那条（tinyfish 或 tavily）——双路据此取 finalText，不必猜 chain 索引
	l2Winner: LayerCall | null;
	// L3 serper 成功的那条
	l3Winner: LayerCall | null;
}

// 在 L1 之后跑 L2 (tinyfish→tavily 串行) + L3 (serper 兜底)，返回级联结果并把调用追加进 chain。
// pi 与 CLI 两路共用，保证 L2/L3 行为单源。
async function runL2L3(opts: {
	chain: LayerCall[];
	clients: CascadeClients;
	input: SearchInput;
	hints: RoutingHints;
	depth: string;
	maxResults: number;
	l1Sufficient: boolean;
	tryTinyfish: boolean;
	tryTavily: boolean;
	trySerper: boolean;
	// L2/L3 超时常量
}): Promise<CascadeResult> {
	const { chain, clients, input, hints, depth, maxResults, l1Sufficient } = opts;
	const { tinyfish, tavily, serper } = clients;
	const L2_TIMEOUT = 20_000;
	const L3_TIMEOUT = 20_000;
	const includeArr = splitDomainList(input.include_domains);
	const excludeArr = splitDomainList(input.exclude_domains);

	// ─── Layer 2a: tinyfish ────────────────────────────────────
	const tinyfishParams: Record<string, unknown> = { query: input.query, max_results: maxResults };
	if (hints.domainType) tinyfishParams.domain_type = hints.domainType;
	if (hints.paperMode) tinyfishParams.domain_type = "research_paper";
	if (input.location) tinyfishParams.location = input.location;
	if (input.include_domains) tinyfishParams.include_domains = input.include_domains;
	if (input.exclude_domains) tinyfishParams.exclude_domains = input.exclude_domains;
	if (hints.codeMode && !input.include_domains) tinyfishParams.include_domains = "github.com";

	let tinyfishSufficient = false;
	if (opts.tryTinyfish && tinyfish && !l1Sufficient) {
		const l2 = await runLayer(2, "tinyfish", "search", tinyfishParams,
			() => tinyfish.callTool("search", tinyfishParams), L2_TIMEOUT);
		chain.push(l2);
		if (l2.result.status === "ok" && l2.result.result_count >= 1) tinyfishSufficient = true;
	} else if (opts.tryTinyfish) {
		chain.push(await runLayer(2, "tinyfish", "search", tinyfishParams, () => Promise.resolve({ content: [] }), 0, true, !tinyfish ? "disabled" : "satisfied"));
	}

	// ─── Layer 2b: tavily (serial, only if tinyfish didn't finish) ──
	const tavilyParams: Record<string, unknown> = { query: input.query, max_results: maxResults, search_depth: depth };
	if (includeArr.length > 0) tavilyParams.include_domains = includeArr;
	if (excludeArr.length > 0) tavilyParams.exclude_domains = excludeArr;
	if (hints.researchMode) tavilyParams.search_depth = "advanced";
	// 注：tavily MCP 的 tavily_search 已把 topic 钉死为 const "general"（2026-10 实测），
	// 传 topic:"news" 会 422 literal_error——不再映射 newsMode 到 topic。
	if (opts.tryTavily && tavily && !l1Sufficient && !tinyfishSufficient) {
		chain.push(await runLayer(2, "tavily", "tavily_search", tavilyParams,
			() => tavily.callTool("tavily_search", tavilyParams), L3_TIMEOUT));
	} else if (opts.tryTavily) {
		chain.push(await runLayer(2, "tavily", "tavily_search", tavilyParams, () => Promise.resolve({ content: [] }), 0, true, !tavily ? "disabled" : "satisfied"));
	}
	const l2Sufficient = tinyfishSufficient || chain.some(c => c.provider === "tavily" && c.result.status === "ok" && c.result.result_count >= 1);

	// ─── Layer 3: serper (unconditional L3 fallback) ───────────
	const serperParams: Record<string, unknown> = { query: input.query, num: maxResults };
	if (input.recency) serperParams.recency = input.recency;
	const serperSite = firstDomainOrNull(input.include_domains);
	if (serperSite) serperParams.site = serperSite;
	if (opts.trySerper && serper && !l1Sufficient && !l2Sufficient) {
		const l3 = await runLayer(3, "serper", "serper_search", serperParams,
			() => serper.search(input.query, { num: maxResults, recency: input.recency, site: serperSite }), L3_TIMEOUT);
		if (l3.result.status === "ok" && l3.result.result_count >= 1) l3.result.credits_used = 1;
		chain.push(l3);
	} else {
		chain.push(await runLayer(3, "serper", "serper_search", serperParams, () => Promise.resolve({ content: [] }), 0, true,
			!serper ? "disabled" : !opts.trySerper ? "hint" : "satisfied"));
	}

	// L2 成功条目（tinyfish 优先，其次 tavily）
	const l2Winner =
		chain.find(c => c.provider === "tinyfish" && c.result.status === "ok" && c.result.result_count >= 1)
		?? chain.find(c => c.provider === "tavily" && c.result.status === "ok" && c.result.result_count >= 1)
		?? null;
	const l3Winner =
		chain.find(c => c.provider === "serper" && c.result.status === "ok" && c.result.result_count >= 1)
		?? null;
	return { l2Sufficient, l2Winner, l3Winner };
}

// ═══════════════════════════════════════════════════════════════════════
// L1 + 取答案：两条执行路径单源（C3 残差——此前 CLI 与 pi 各写一份且已漂移）
// ═══════════════════════════════════════════════════════════════════════

interface L1Params {
	wigoloParams: Record<string, unknown>;
	keenableParams: Record<string, unknown>;
}

/** L1 请求参数。域过滤形态各家不同：wigolo 吃 string[]（裸字符串会炸 "list.map is not a function"），
 *  keenable 只吃单个 site。 */
function buildL1Params(input: SearchInput, hints: RoutingHints, maxResults: number): L1Params {
	const includeArr = splitDomainList(input.include_domains);
	const excludeArr = splitDomainList(input.exclude_domains);
	let wigoloInclude = includeArr;
	if (hints.codeMode && wigoloInclude.length === 0) wigoloInclude = ["github.com", "stackoverflow.com", "npmjs.com", "pypi.org"];
	const wigoloParams: Record<string, unknown> = { query: input.query, search_depth: "fast", max_tokens_out: 4000 };
	if (input.recency) {
		const map: Record<string, string> = { day: "day", week: "week", month: "month", year: "year" };
		wigoloParams.time_range = map[input.recency];
	}
	if (wigoloInclude.length > 0) wigoloParams.include_domains = wigoloInclude;
	if (excludeArr.length > 0) wigoloParams.exclude_domains = excludeArr;
	const keenableParams: Record<string, unknown> = { query: input.query, max_results: maxResults };
	const keenableSite = firstDomainOrNull(input.include_domains);
	if (keenableSite) keenableParams.site = keenableSite;
	return { wigoloParams, keenableParams };
}

interface L1Outcome {
	wigoloCall: LayerCall;
	keenableCall: LayerCall;
	sufficient: boolean;
	anyDegraded: boolean;
	combinedRaw: string;
}

/** 跑 L1（wigolo + keenable 并行）。两条判据在此收口：
 *  · keenable 缺 client 记 skipped/disabled，不再走 `keenable!.callTool` 抛错冒充 error；
 *  · 429 冷却只对 public tier（无 key）退让——auth tier 不写 throttle 文件，旧 CLI 判据漏看 key 会误跳。 */
async function runL1(opts: {
	chain: LayerCall[];
	wigolo: WigoloClient;
	keenable: HTTPClient | null;
	keenableHasKey: boolean;
	params: L1Params;
	tryL1: boolean;
	maxResults: number;
	wigoloTimeout: number;
	keenableTimeout: number;
}): Promise<L1Outcome> {
	const { chain, wigolo, keenable, keenableHasKey, params, tryL1, maxResults } = opts;
	const keenableSkipped = !keenable || !tryL1 || (!keenableHasKey && isKeenableThrottled());
	const [lw, lk] = await Promise.allSettled([
		runLayer(1, "wigolo", "search", params.wigoloParams,
			() => wigolo.callTool("search", params.wigoloParams), opts.wigoloTimeout, !tryL1, "hint"),
		runLayer(1, "keenable", "keenable_search", params.keenableParams,
			() => (keenable as HTTPClient).callTool("search", params.keenableParams), opts.keenableTimeout, keenableSkipped,
			!keenable ? "disabled" : !tryL1 ? "hint" : "throttled"),
	]);
	const rejected = (r: PromiseSettledResult<LayerCall>, provider: "wigolo" | "keenable"): LayerCall => ({
		layer: 1, provider, tool: provider === "wigolo" ? "search" : "keenable_search",
		params: provider === "wigolo" ? params.wigoloParams : params.keenableParams,
		result: { status: "error", result_count: 0, latency_ms: 0, engine_pool: null, credits_used: 0, usage: null, rate_limit_headers: {}, response_bytes: 0, stop_reason: null, skip_reason: null, error: r.reason?.message ?? "rejected", raw_text: "" },
		ts_start: new Date().toISOString(), ts_end: new Date().toISOString(),
	});
	const wigoloCall = lw.status === "fulfilled" ? lw.value : rejected(lw, "wigolo");
	const keenableCall = lk.status === "fulfilled" ? lk.value : rejected(lk, "keenable");
	chain.push(wigoloCall, keenableCall);

	const w = wigoloCall.result, k = keenableCall.result;
	const anyDegraded = w.status === "degraded" || k.status === "degraded";
	// Post-filter：provider 可能返超 maxResults（wigolo 无视该参数），只把要的量交给 LLM 看
	const wFiltered = w.raw_text && w.result_count > 0 ? postFilterResults(w.raw_text, maxResults) : w.raw_text;
	const kFiltered = k.raw_text && k.result_count > 0 ? postFilterResults(k.raw_text, maxResults) : k.raw_text;
	return {
		wigoloCall, keenableCall,
		sufficient: w.result_count + k.result_count >= (anyDegraded ? Math.min(3, maxResults) : maxResults),
		anyDegraded,
		combinedRaw: [wFiltered ? "[wigolo] " + wFiltered : null, kFiltered ? "[keenable] " + kFiltered : null].filter(Boolean).join("\n\n"),
	};
}

/** 级联取答案：L1 充足→L1；否则 L2 winner→L3 winner；全空→首个有 raw_text 的层兜底。
 *  判据取生产在跑的 CLI 版（pi 旧版是“chain 里第一个 ok|degraded”，两者已在 L2/L3 上漂移）。 */
function pickAnswer(chain: LayerCall[], l1: L1Outcome, l2l3: CascadeResult | null): { stoppedAt: number; winner: LayerCall | null } {
	if (l1.sufficient) {
		const w = l1.wigoloCall.result;
		return { stoppedAt: 1, winner: w.result_count > 0 || w.raw_text ? l1.wigoloCall : l1.keenableCall };
	}
	if (l2l3?.l2Winner) return { stoppedAt: 2, winner: l2l3.l2Winner };
	if (l2l3?.l3Winner) return { stoppedAt: 3, winner: l2l3.l3Winner };
	for (const c of chain) {
		if (c.result.raw_text && c.result.raw_text.length > 50) return { stoppedAt: c.layer, winner: c };
	}
	return { stoppedAt: 0, winner: null };
}

// ═══════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════

// ─── CLI 模式入口（MCP server spawn-per-call 用）──────────────
// 被 smart-web-search-mcp-server.mjs 以 `node smart-web-search-mcp.ts '{"query":...}'`
// 方式 spawn：argv[2] 为 JSON 搜索参数。跑一次完整搜索，stdout 输出 JSON 结果，exit 0。
// 避免 pi 内常驻 client（wigolo stdio / HTTP session）跨调用累积。
async function runCliSearch(params: SearchInput): Promise<{ query: string; results_text: string; details: Record<string, unknown> }> {
	const t0 = Date.now();
	const input: SearchInput = { ...params };
	const requestId = randomUUID();
	const hints = inferHints(input.query, input.intent ?? null);
	const maxResults = input.max_results ?? 5;
	const depth = input.depth ?? "basic";
	const smartCfg = loadSmartConfig();
	const clients = buildClientsForCli(smartCfg);
	const { tinyfish, tavily, keenable, serper } = clients;
	const providers = providersSnapshot(clients);

	const chain: LayerCall[] = [];
	const L1_TIMEOUT = 45_000;  // 级联预算 45+20+20+20=105s < server.mjs 看门狗 120s
	const L1_KEENABLE_TIMEOUT = 15_000;
	// L2/L3 超时在共享 runL2L3 内定义
	let tryL1 = true, tryTinyfish = !!tinyfish, tryTavily = !!tavily;
	const trySerper = !!serper;
	if (hints.extractCrawl) tryTinyfish = false;
	if (hints.newsMode && tinyfish) tryL1 = false;
	if (hints.paperMode && tinyfish) tryL1 = false;

	// C3：L1 与取答案改用与 pi 同一批共享函数（此前两路各写一份且已漂移）
	const l1Params = buildL1Params(input, hints, maxResults);
	const wigoloCli = new WigoloClient();
	// 优化1：spawn 与参数构建/keys 解析并行，缩短单次调用冷启动
	wigoloCli.warmup();
	// 暴露给模块顶层 CLI 路径，runCliSearch 返回后优雅关闭
	(process as any).__wigoloCli = wigoloCli;
	const l1 = await runL1({
		chain, wigolo: wigoloCli, keenable, keenableHasKey: clients.keenableRes.key !== null,
		params: l1Params, tryL1, maxResults, wigoloTimeout: L1_TIMEOUT, keenableTimeout: L1_KEENABLE_TIMEOUT,
	});
	const l1Sufficient = l1.sufficient;
	const l1CombinedRaw = l1.combinedRaw;
	const l1WigoloCall = l1.wigoloCall;

	// 级联：L1 充足时 runL2L3 只落 skip 占位行（不打网络），chain 形态与 v1 历史行一致
	const l2l3 = await runL2L3({
		chain, input, hints, depth, maxResults,
		clients: { tinyfish, tavily, serper },
		l1Sufficient, tryTinyfish, tryTavily, trySerper,
	});
	const l2Sufficient = l2l3.l2Sufficient;
	const { stoppedAt, winner } = pickAnswer(chain, l1, l2l3);
	// ─── Unified output: winner raw_text → items（与 pi execute 同一批函数）───
	const outputFormat = input.output_format === "json" ? "json" : "text";
	let items: UnifiedItem[] = [];
	let rawCount = 0;
	let dedupedCount = 0;
	if (stoppedAt === 1) {
		const merged = mergeL1Items(
			normalizeProviderText("wigolo", l1WigoloCall.result.raw_text),
			normalizeProviderText("keenable", l1.keenableCall.result.raw_text),
			maxResults,
		);
		items = merged.items; rawCount = merged.rawCount; dedupedCount = merged.dedupedCount;
	} else if (winner) {
		const norm = normalizeProviderText(winner.provider, winner.result.raw_text);
		dedupedCount = norm.length; rawCount = norm.length;
		items = norm.slice(0, maxResults);
	}
	const formatRaw = stoppedAt > 0 && items.length === 0;
	const rawFallback = formatRaw
		? (stoppedAt === 1 ? l1CombinedRaw : postFilterResults(winner?.result.raw_text ?? "", maxResults))
		: "";
	const winnerProvider = winner?.provider ?? "-";
	const layersTried = chain
		.filter((c) => c.result.status !== "skipped")
		.map((c) => ({ provider: c.provider, status: c.result.status, count: c.result.result_count }));
	const totalLatency = Date.now() - t0;
	const totalCredits = chain.reduce((s, c) => s + c.result.credits_used, 0);
	const resultsText = outputFormat === "json"
		? assembleEnvelope(input.query, items, chain, { stoppedAt, provider: winnerProvider, totalLatencyMs: totalLatency, totalCredits, dedupedCount })
		: assembleTextOutput(items, {
			stoppedAt, provider: winnerProvider, dedupedCount, rawCount,
			layersTried, totalLatencyMs: totalLatency, formatRaw, rawFallback,
		});
	// 遥测：CLI/MCP 路径同样逐条落盘（v1 时代只有 pi execute 写 ⇒ 10-02 起生产流量 23 天零样本）
	writeLog(buildSearchLogEntry({
		via: "cli", requestId, t0, input, maxResults, depth, hints, chain,
		stoppedAt, outputFormat, totalCredits, l1Sufficient, l2Sufficient,
		l1Status: l1WigoloCall.result.status, providers,
	}));
	return {
		query: input.query,
		results_text: resultsText,
		details: {
			request_id: requestId,
			stopped_at: stoppedAt,
			output_mode: outputFormat,
			total_latency_ms: totalLatency,
			total_credits_used: totalCredits,
			chain: chain.map((c) => ({ layer: c.layer, provider: c.provider, status: c.result.status, result_count: c.result.result_count, latency_ms: c.result.latency_ms, credits_used: c.result.credits_used, error: c.result.error })),
		},
	};
}

function buildClientsForCli(smartCfg: SmartConfig) {
	// 与 factory buildClients 同逻辑（CLI 单进程无需热重载）
	const tinyfishRes = resolveProviderKey("tinyfish", smartCfg);
	const tavilyRes = resolveProviderKey("tavily", smartCfg);
	const keenableRes = resolveKeenableConfig(smartCfg);
	const serperRes = resolveSerperConfig(smartCfg);
	return {
		tinyfishRes, tavilyRes, keenableRes, serperRes,
		tinyfish: tinyfishRes.enabled && tinyfishRes.key ? new HTTPClient(TINYFISH_REMOTE_MCP_URL, { "X-API-Key": tinyfishRes.key }, "tinyfish") : null,
		tavily: tavilyRes.enabled && tavilyRes.key ? new HTTPClient(TAVILY_REMOTE_MCP_URL + "?tavilyApiKey=" + encodeURIComponent(tavilyRes.key), {}, "tavily") : null,
		keenable: keenableRes.enabled
			? new HTTPClient(KEENABLE_MCP_URL, keenableRes.key ? { "X-API-Key": keenableRes.key } : {}, "keenable",
					keenableRes.key === null ? KEENABLE_THROTTLE_PATH : undefined)
			: null,
		serper: serperRes.enabled && serperRes.key ? new SerperClient(serperRes.key) : null,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Fetch：单 URL 正文抓取（wigolo → keenable → tavily → serper → direct）
// 输出面向 agent：text 模式直接是「Title/URL/Via + markdown」可读块；
// output_format=json 才给结构化 envelope。不写搜索遥测，避免污染 v2/search 样本。
// ═══════════════════════════════════════════════════════════════════════

interface FetchInput {
	url: string;
	max_chars?: number;
	output_format?: string;
}

interface FetchDeps {
	wigolo: WigoloClient;
	keenable: HTTPClient | null;
	tavily: HTTPClient | null;
	serper: SerperClient | null;
	keenableHasKey: boolean;
}

interface FetchResult {
	url: string;
	final_url: string;
	title: string;
	content: string;
	content_format: "markdown" | "text";
	via: string;
	http_status: number | null;
	truncated: boolean;
	elapsed_ms: number;
	meta: Record<string, unknown>;
}

const FETCH_DEFAULT_MAX_CHARS = 20_000;
const FETCH_MIN_MAX_CHARS = 500;
const FETCH_MAX_MAX_CHARS = 200_000;
const FETCH_WIGOLO_TIMEOUT = 45_000;
const FETCH_HTTP_TIMEOUT = 20_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_UA = `Mozilla/5.0 (compatible; smart-web-search/${VERSION}; +https://github.com/NinjaSln-labs/smart-web-search-mcp)`;

function normalizeFetchInput(input: FetchInput): { url: string; maxChars: number; outputFormat: "text" | "json" } {
	const raw = String(input?.url ?? "").trim();
	if (!raw) throw new Error("url is required");
	const u = new URL(raw);
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(`unsupported URL scheme: ${u.protocol}（只支持 http/https）`);
	}
	const n = Number(input.max_chars ?? FETCH_DEFAULT_MAX_CHARS);
	return {
		url: u.toString(),
		maxChars: Number.isFinite(n)
			? Math.min(Math.max(Math.trunc(n), FETCH_MIN_MAX_CHARS), FETCH_MAX_MAX_CHARS)
			: FETCH_DEFAULT_MAX_CHARS,
		outputFormat: input.output_format === "json" ? "json" : "text",
	};
}

function timeoutRace<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | null = null;
	return Promise.race([
		p,
		new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms); }),
	]).finally(() => { if (timer) clearTimeout(timer); });
}

function truncateContent(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	const slice = text.slice(0, max);
	const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
	return { text: (cut > max * 0.6 ? slice.slice(0, cut) : slice).trimEnd(), truncated: true };
}

const HTML_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
	mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
	copy: "©", reg: "®", trade: "™",
};

function decodeHtmlEntities(s: string): string {
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
		if (HTML_ENTITIES[ent] !== undefined) return HTML_ENTITIES[ent];
		const hex = ent.toLowerCase().startsWith("#x");
		const cp = hex ? parseInt(ent.slice(2), 16) : (ent.startsWith("#") ? parseInt(ent.slice(1), 10) : NaN);
		return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
	});
}

function htmlToText(html: string): { title: string; text: string } {
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = decodeHtmlEntities((titleMatch?.[1] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
	const cleaned = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, "");
	const scope = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
		?? cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
		?? cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]
		?? cleaned;
	const text = decodeHtmlEntities(
		scope
			.replace(/<\s*br\s*\/?>/gi, "\n")
			.replace(/<\s*\/\s*(p|div|section|article|main|header|footer|h[1-6]|li|ul|ol|tr|td|blockquote|pre)\s*>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
	)
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text };
}

async function readBodyCapped(resp: Response, cap: number): Promise<Uint8Array> {
	if (!resp.body) return new Uint8Array(await resp.arrayBuffer()).slice(0, cap);
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (total < cap) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) { chunks.push(value); total += value.byteLength; }
	}
	if (total >= cap) { try { await reader.cancel(); } catch { /* already closed */ } }
	const out = new Uint8Array(Math.min(total, cap));
	let off = 0;
	for (const c of chunks) {
		const take = Math.min(c.byteLength, out.byteLength - off);
		if (take <= 0) break;
		out.set(c.subarray(0, take), off);
		off += take;
	}
	return out;
}

/** 直连 HTTP + 零依赖 HTML→text（最底层兜底；导出供回归测试）。 */
export async function fetchUrlDirect(rawUrl: string, maxChars = FETCH_DEFAULT_MAX_CHARS, timeoutMs = FETCH_HTTP_TIMEOUT): Promise<FetchResult> {
	const t0 = Date.now();
	const u = new URL(rawUrl);
	if (u.protocol !== "http:" && u.protocol !== "https:") {
		throw new Error(`unsupported URL scheme: ${u.protocol}（只支持 http/https）`);
	}
	const resp = await fetch(rawUrl, {
		redirect: "follow",
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			"user-agent": FETCH_UA,
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.5",
		},
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	const ct = (resp.headers.get("content-type") || "").toLowerCase();
	const raw = new TextDecoder("utf-8").decode(await readBodyCapped(resp, FETCH_MAX_BYTES));
	let title = "";
	let content = "";
	let format: "markdown" | "text" = "text";
	if (ct.includes("html") || ct.includes("xml")) {
		const parsed = htmlToText(raw);
		title = parsed.title;
		content = parsed.text;
	} else if (ct.startsWith("text/") || ct.includes("json")) {
		content = raw.trim();
		if (ct.includes("json")) {
			try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* keep raw */ }
		}
	} else {
		throw new Error(`unsupported content-type: ${ct || "unknown"}`);
	}
	if (!content.trim()) throw new Error("empty content");
	const tr = truncateContent(content, maxChars);
	return {
		url: rawUrl,
		final_url: resp.url || rawUrl,
		title,
		content: tr.text,
		content_format: format,
		via: "direct",
		http_status: resp.status,
		truncated: tr.truncated,
		elapsed_ms: Date.now() - t0,
		meta: { content_type: ct },
	};
}

async function fetchViaWigolo(wigolo: WigoloClient, url: string, maxChars: number): Promise<FetchResult> {
	const t0 = Date.now();
	const resp = await timeoutRace(
		wigolo.callTool("fetch", { url, max_content_chars: maxChars, render_js: "auto" }),
		FETCH_WIGOLO_TIMEOUT, "wigolo fetch",
	);
	const text = (resp.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
	if (resp.isError) throw new Error(`wigolo fetch isError: ${text.slice(0, 200)}`);
	const data = JSON.parse(text) as {
		url?: string; title?: string; markdown?: string; metadata?: { title?: string };
		cached?: boolean; fetch_method?: string; http_status?: number;
		content_completeness?: { level?: string };
	};
	const rawMd = typeof data.markdown === "string" ? data.markdown : "";
	if (!rawMd.trim()) throw new Error("wigolo fetch returned empty markdown");
	const truncatedByProvider = /\[\.\.\. content truncated\]/i.test(rawMd);
	const content = truncateContent(rawMd.replace(/\s*\[\.\.\. content truncated\]\s*$/i, "").trimEnd(), maxChars);
	return {
		url,
		final_url: data.url || url,
		title: data.title || data.metadata?.title || "",
		content: content.text,
		content_format: "markdown",
		via: "wigolo",
		http_status: typeof data.http_status === "number" ? data.http_status : null,
		truncated: truncatedByProvider || content.truncated,
		elapsed_ms: Date.now() - t0,
		meta: { cached: data.cached === true, fetch_method: data.fetch_method, completeness: data.content_completeness?.level },
	};
}

async function fetchViaKeenable(client: HTTPClient, url: string): Promise<FetchResult> {
	const t0 = Date.now();
	const resp = await timeoutRace(client.callTool("fetch_page_content", { url }), FETCH_HTTP_TIMEOUT, "keenable fetch");
	const text = (resp.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
	if (resp.isError) throw new Error(`keenable fetch isError: ${text.slice(0, 200)}`);
	const m = text.match(/^Title:\s*(.*)\r?\nURL:\s*(\S+)\r?\n\r?\n([\s\S]*)$/);
	const content = (m?.[3] ?? text).trim();
	if (!content) throw new Error("keenable fetch returned empty content");
	return {
		url,
		final_url: m?.[2] ?? url,
		title: (m?.[1] ?? "").trim(),
		content,
		content_format: "markdown",
		via: "keenable",
		http_status: null,
		truncated: false,
		elapsed_ms: Date.now() - t0,
		meta: {},
	};
}

async function fetchViaTavily(client: HTTPClient, url: string): Promise<FetchResult> {
	const t0 = Date.now();
	const resp = await timeoutRace(
		client.callTool("tavily_extract", { urls: [url], extract_depth: "basic" }),
		FETCH_HTTP_TIMEOUT, "tavily extract",
	);
	const text = (resp.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
	if (resp.isError) throw new Error(`tavily extract isError: ${text.slice(0, 200)}`);
	const data = JSON.parse(text) as {
		results?: Array<{ url?: string; title?: string; raw_content?: string }>;
		failed_results?: Array<{ url?: string; error?: string }>;
	};
	const item = data.results?.[0];
	const content = (item?.raw_content ?? "").trim();
	if (!content) {
		const why = (data.failed_results ?? []).map((f) => f.error).filter(Boolean).join("; ");
		throw new Error(`tavily extract empty${why ? `: ${why.slice(0, 160)}` : ""}`);
	}
	return {
		url,
		final_url: item?.url || url,
		title: item?.title || "",
		content,
		content_format: "markdown",
		via: "tavily",
		http_status: null,
		truncated: false,
		elapsed_ms: Date.now() - t0,
		meta: {},
	};
}

async function fetchViaSerper(client: SerperClient, url: string): Promise<FetchResult> {
	const t0 = Date.now();
	const r = await client.scrape(url, FETCH_HTTP_TIMEOUT);
	const content = r.text.trim();
	if (!content) throw new Error("serper scrape returned empty text");
	return {
		url,
		final_url: url,
		title: r.title,
		content,
		content_format: "text",
		via: "serper",
		http_status: null,
		truncated: false,
		elapsed_ms: Date.now() - t0,
		meta: { credits: r.credits },
	};
}

async function runFetch(input: FetchInput, deps: FetchDeps): Promise<FetchResult> {
	const { url, maxChars } = normalizeFetchInput(input);
	const t0 = Date.now();
	const failed: string[] = [];
	const keenableThrottled = !deps.keenableHasKey && isKeenableThrottled();
	// SMART_WS_FETCH_SKIP=wigolo,keenable,... —— 仅用于验证/排障：强制走后面的层
	const skipEnv = new Set((process.env.SMART_WS_FETCH_SKIP ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
	const envSkip = (via: string): string | undefined => (skipEnv.has(via) ? "env skip" : undefined);
	const attempts: Array<{ via: string; run: () => Promise<FetchResult>; skip?: string }> = [
		{ via: "wigolo", run: () => fetchViaWigolo(deps.wigolo, url, maxChars), skip: envSkip("wigolo") },
		{
			via: "keenable",
			run: () => fetchViaKeenable(deps.keenable as HTTPClient, url),
			skip: envSkip("keenable") ?? (!deps.keenable ? "disabled" : (keenableThrottled ? "throttled" : undefined)),
		},
		{ via: "tavily", run: () => fetchViaTavily(deps.tavily as HTTPClient, url), skip: envSkip("tavily") ?? (deps.tavily ? undefined : "no key") },
		{ via: "serper", run: () => fetchViaSerper(deps.serper as SerperClient, url), skip: envSkip("serper") ?? (deps.serper ? undefined : "no key") },
		{ via: "direct", run: () => fetchUrlDirect(url, maxChars), skip: envSkip("direct") },
	];
	for (const a of attempts) {
		if (a.skip) { failed.push(`${a.via}: skipped (${a.skip})`); continue; }
		try {
			const r = await a.run();
			const tr = truncateContent(r.content, maxChars);
			return {
				...r,
				url,
				content: tr.text,
				truncated: r.truncated || tr.truncated,
				elapsed_ms: Date.now() - t0,
				meta: { ...r.meta, tried: failed },
			};
		} catch (e) {
			failed.push(`${a.via}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	throw new Error(`fetch failed: ${failed.join("; ")}`);
}

function renderFetchText(r: FetchResult): string {
	const bits: string[] = [];
	if (r.http_status) bits.push(`HTTP ${r.http_status}`);
	if (r.meta.cached === true) bits.push("cached");
	if (typeof r.meta.credits === "number") bits.push(`${r.meta.credits} credits`);
	const via = bits.length ? `${r.via} (${bits.join(", ")})` : r.via;
	return `Title: ${r.title || "(untitled)"}\nURL: ${r.final_url}\nVia: ${via} · ${r.elapsed_ms}ms\n\n${r.content}${r.truncated ? "\n\n[... content truncated]" : ""}`;
}

function renderFetchResult(r: FetchResult, outputFormat: "text" | "json"): string {
	return outputFormat === "json" ? JSON.stringify(r, null, 2) : renderFetchText(r);
}

async function runCliFetch(params: FetchInput): Promise<{ text: string; details: FetchResult }> {
	const input = normalizeFetchInput(params);
	const clients = buildClientsForCli(loadSmartConfig());
	const wigolo = new WigoloClient();
	wigolo.warmup();
	(process as any).__wigoloCli = wigolo;
	const r = await runFetch(input, {
		wigolo,
		keenable: clients.keenable,
		tavily: clients.tavily,
		serper: clients.serper,
		keenableHasKey: clients.keenableRes.key !== null,
	});
	return { text: renderFetchResult(r, input.outputFormat), details: r };
}

export { runCliSearch };
export { runCliFetch };

// ─── CLI 模式（模块顶层）：argv[2] 为 JSON 搜索参数 ────────
// 由 smart-web-search-mcp-server.mjs 以 `node smart-web-search-mcp.ts '{...}'` spawn。
// 跑一次完整搜索，stdout 输出 JSON，exit 0。避免 pi 内常驻 client 跨调用累积。
// 守卫须判 argv[1] 为本文件：pi 加载扩展同进程，argv[2] 会是 pi 自己的参数（如 "-p"），误判即炸加载。
if (/(^|[\\/])smart-web-search-mcp\.[cm]?[jt]s$/.test(process.argv[1] ?? "") && process.argv[2]) {
	// M3：stdout 是 CLI 的 JSON 协议通道——把 console.log 重定向 stderr，
	// 防御未来给核心加模块顶层副作用（横幅/日志）污染 CLI stdout。
	console.log = (...a: unknown[]) => { process.stderr.write(a.join(" ") + "\n"); };
	const cliArgs = JSON.parse(process.argv[2]) as Record<string, unknown>;
	const cliRun = cliArgs?.action === "fetch"
		? runCliFetch(cliArgs as unknown as FetchInput)
		: runCliSearch(cliArgs as unknown as SearchInput);
	cliRun
		.then((out) => {
			const wig = (process as any).__wigoloCli;
			if (wig?.close) wig.close();
			process.stdout.write(JSON.stringify(out));
			process.exit(0);
		})
		.catch((e) => { process.stderr.write("CLI failed: " + (e?.message ?? e) + "\n"); process.exit(1); });
}
