/** Stockfish worker wrapper speaking UCI. One shared worker; one search at a time. */
import type { EngineLine, Score } from "./types";

export interface SearchLimits {
	movetimeMs?: number;
	depth?: number;
	multiPv?: number;
}

export interface SearchResult {
	bestmove: string;
	lines: EngineLine[];
}

export class SearchStopped extends Error {}

/** Parse a UCI "info" line. Returns undefined for lines without a usable score+pv. */
export function parseInfo(line: string, whiteToMove: boolean): EngineLine | undefined {
	const t = line.trim().split(/\s+/);
	if (t[0] !== "info") return undefined;
	let depth = 0;
	let multipv = 1;
	let score: Score | undefined;
	let pv: string[] = [];
	let bound = false;
	for (let i = 1; i < t.length; i++) {
		switch (t[i]) {
			case "depth":
				depth = Number(t[++i]);
				break;
			case "multipv":
				multipv = Number(t[++i]);
				break;
			case "score": {
				const kind = t[++i];
				const v = Number(t[++i]);
				const sign = whiteToMove ? 1 : -1;
				score = kind === "mate" ? { mate: sign * v } : { cp: sign * v };
				if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") bound = true;
				break;
			}
			case "pv":
				pv = t.slice(i + 1);
				i = t.length;
				break;
		}
	}
	if (!score || !pv.length || bound) return undefined;
	return { depth, multipv, score, pv };
}

interface Pending {
	whiteToMove: boolean;
	lines: Map<number, EngineLine>;
	onInfo?: (lines: EngineLine[]) => void;
	resolve: (r: SearchResult) => void;
	reject: (e: Error) => void;
	stopped: boolean;
}

export class StockfishEngine {
	private worker?: Worker;
	private urls: string[] = [];
	private readyWaiters: Array<() => void> = [];
	private pending?: Pending;
	private chain: Promise<unknown> = Promise.resolve();
	private multiPv = 1;
	private dead = false;

	constructor(private files: { js: ArrayBuffer; wasm: ArrayBuffer }, private hashMb: number) {}

	async start(): Promise<void> {
		const jsUrl = URL.createObjectURL(new Blob([this.files.js], { type: "application/javascript" }));
		const wasmUrl = URL.createObjectURL(new Blob([this.files.wasm], { type: "application/wasm" }));
		this.urls = [jsUrl, wasmUrl];
		// Stockfish.js reads the wasm location from the worker URL's hash.
		this.worker = new Worker(`${jsUrl}#${encodeURIComponent(wasmUrl)}`);
		this.worker.onmessage = (e: MessageEvent) => this.onLine(String(e.data));
		this.worker.onerror = (e) => {
			this.pending?.reject(new Error(`Engine error: ${e.message}`));
			this.pending = undefined;
		};
		this.send("uci");
		this.send("setoption name Threads value 1");
		this.send(`setoption name Hash value ${this.hashMb}`);
		await this.isReady();
	}

	private send(cmd: string) {
		this.worker?.postMessage(cmd);
	}

	private isReady(): Promise<void> {
		return new Promise((resolve) => {
			this.readyWaiters.push(resolve);
			this.send("isready");
		});
	}

	private onLine(line: string) {
		if (line === "readyok") {
			this.readyWaiters.shift()?.();
			return;
		}
		const p = this.pending;
		if (!p) return;
		if (line.startsWith("info")) {
			const l = parseInfo(line, p.whiteToMove);
			if (!l) return;
			const prev = p.lines.get(l.multipv);
			// Keep the last full-depth line for each multipv.
			if (!prev || l.depth >= prev.depth) p.lines.set(l.multipv, l);
			p.onInfo?.(this.sorted(p));
		} else if (line.startsWith("bestmove")) {
			this.pending = undefined;
			const best = line.split(/\s+/)[1] ?? "(none)";
			if (p.stopped) p.reject(new SearchStopped("stopped"));
			else p.resolve({ bestmove: best, lines: this.sorted(p) });
		}
	}

	private sorted(p: Pending): EngineLine[] {
		return [...p.lines.values()].sort((a, b) => a.multipv - b.multipv);
	}

	async newGame(): Promise<void> {
		this.send("ucinewgame");
		await this.isReady();
	}

	/** Searches are serialised; a new search waits for the previous one to finish or stop. */
	search(fen: string, limits: SearchLimits, onInfo?: (lines: EngineLine[]) => void): Promise<SearchResult> {
		const run = async () => {
			if (this.dead) throw new SearchStopped("engine terminated");
			const mpv = limits.multiPv ?? 1;
			if (mpv !== this.multiPv) {
				this.send(`setoption name MultiPV value ${mpv}`);
				this.multiPv = mpv;
			}
			await this.isReady();
			return new Promise<SearchResult>((resolve, reject) => {
				const whiteToMove = fen.split(" ")[1] !== "b";
				this.pending = { whiteToMove, lines: new Map(), onInfo, resolve, reject, stopped: false };
				this.send(`position fen ${fen}`);
				this.send(limits.depth ? `go depth ${limits.depth}` : `go movetime ${limits.movetimeMs ?? 1500}`);
			});
		};
		const p = this.chain.then(run, run);
		this.chain = p.catch(() => undefined);
		return p;
	}

	/** Stop the running search; its promise rejects with SearchStopped. */
	stop(): void {
		if (this.pending && !this.pending.stopped) {
			this.pending.stopped = true;
			this.send("stop");
		}
	}

	terminate(): void {
		this.dead = true;
		this.pending?.reject(new SearchStopped("engine terminated"));
		this.pending = undefined;
		this.worker?.terminate();
		this.worker = undefined;
		for (const u of this.urls) URL.revokeObjectURL(u);
		this.urls = [];
	}
}
