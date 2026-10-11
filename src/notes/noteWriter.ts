/** Create and update game notes. Only plugin-owned frontmatter keys and the summary region are ever rewritten. */
import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { AnalysisStatus, GameRecord } from "../types";
import type { UpsertResult } from "../sync/syncEngine";
import {
	ANALYSIS_KEYS,
	Frontmatter,
	SYNC_KEYS,
	applyOwnedKeys,
	changedKeys,
	newNoteFrontmatter,
	renderYaml,
	syncFrontmatter,
} from "./frontmatter";

export const SUMMARY_START = "<!-- chess-review:summary:start -->";
export const SUMMARY_END = "<!-- chess-review:summary:end -->";
export const CODE_LANG = "chess-game";

/* ------------------------------------------------------------------ */
/* Pure rendering helpers                                               */
/* ------------------------------------------------------------------ */

const SITE_LABEL: Record<string, string> = { lichess: "Lichess", chesscom: "chess.com", otb: "OTB" };

/** Strip characters that could break the single-line Markdown we write around user-supplied names. */
export function safeInline(s: unknown): string {
	return String(s ?? "")
		.replace(/[\r\n]+/g, " ")
		.replace(/[<>[\]`|*_#]/g, "")
		.trim();
}

/** "600+5" -> "10+5", "1/86400" -> "1 day/move". */
export function formatTimeControl(tc?: unknown): string {
	if (typeof tc !== "string" || !tc) return "";
	const daily = /^1\/(\d+)$/.exec(tc);
	if (daily) {
		const days = Math.round(Number(daily[1]) / 86400);
		return `${days} day${days === 1 ? "" : "s"}/move`;
	}
	const m = /^(\d+)(?:\+(\d+))?$/.exec(tc);
	if (!m) return tc;
	const base = Number(m[1]);
	const mins = base >= 60 ? String(Math.round((base / 60) * 100) / 100) : `${base}s`;
	return `${mins}+${m[2] ?? "0"}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Text between the summary markers, rendered from frontmatter values. */
export function renderSummary(fm: Record<string, unknown>): string {
	const first: string[] = [];
	const tc = [fm["time-class"] ? cap(String(fm["time-class"])) : "", formatTimeControl(fm["time-control"])]
		.filter(Boolean)
		.join(" ");
	if (tc) first.push(tc);
	first.push(SITE_LABEL[String(fm.site)] ?? String(fm.site ?? ""));
	if (fm.site === "otb" && fm.event) first.push(safeInline(fm.event) + (fm.round ? `, round ${safeInline(fm.round)}` : ""));
	first.push(`${fm.result ?? "*"}${fm.termination ? ` by ${safeInline(fm.termination)}` : ""}`);
	if (typeof fm.url === "string" && /^https:\/\//.test(fm.url)) first.push(`[open game](${fm.url.replace(/[()\s]/g, encodeURIComponent)})`);
	let second: string;
	switch (fm["analysis-status"]) {
		case "done": {
			const n = (k: string) => Number(fm[k] ?? 0);
			second =
				`My mistakes: ${plural(n("my-inaccuracies"), "inaccuracy", "inaccuracies")}, ` +
				`${plural(n("my-mistakes"), "mistake", "mistakes")}, ${plural(n("my-blunders"), "blunder", "blunders")}` +
				(fm["my-acpl"] !== undefined && fm["my-acpl"] !== null ? ` · ACPL ${fm["my-acpl"]}` : "");
			break;
		}
		case "queued":
			second = "Analysis queued.";
			break;
		case "running":
			second = "Analysis running…";
			break;
		case "failed":
			second = "Analysis failed.";
			break;
		default:
			second = "Not analysed yet.";
	}
	return `${first.join(" · ")}\n${second}`;
}

export function renderNote(r: GameRecord, fm: Frontmatter): string {
	const date = r.playedAt ? r.playedAt.slice(0, 10) : "unknown date";
	return [
		"---",
		renderYaml(fm),
		"---",
		`# ${safeInline(r.white.name)} vs ${safeInline(r.black.name)}, ${date}`,
		"",
		SUMMARY_START,
		renderSummary(fm),
		SUMMARY_END,
		"",
		"```" + CODE_LANG,
		r.pgn.replace(/```/g, "'''").trim(),
		"```",
		"",
		"## My review",
		"",
	].join("\n");
}

/** Replace the text between the markers. Returns the content unchanged if the markers are missing. */
export function replaceRegion(content: string, inner: string): string {
	const s = content.indexOf(SUMMARY_START);
	const e = content.indexOf(SUMMARY_END, s + 1);
	if (s < 0 || e < 0) return content;
	return content.slice(0, s + SUMMARY_START.length) + "\n" + inner + "\n" + content.slice(e);
}

/** Replace lines (lineStart, lineEnd) exclusive — the body of a fenced block — with `body`. */
export function replaceBlockBody(content: string, lineStart: number, lineEnd: number, body: string): string {
	const nl = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.split(nl);
	return [...lines.slice(0, lineStart + 1), ...body.split("\n"), ...lines.slice(lineEnd)].join(nl);
}

/** Locate the chess-game block whose body is `expected` (closest to `near` if several). */
export function findGameBlock(data: string, expected: string, near?: number): { lineStart: number; lineEnd: number } | undefined {
	const lines = data.split("\n").map((l) => l.replace(/\r$/, ""));
	const want = expected.trim();
	const found: Array<{ lineStart: number; lineEnd: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const open = /^\s*(`{3,}|~{3,})chess-game\b/.exec(lines[i]);
		if (!open) continue;
		const fence = open[1];
		let j = i + 1;
		while (j < lines.length && !(lines[j].trim().startsWith(fence[0].repeat(fence.length)) && lines[j].trim().replace(/[`~]/g, "") === "")) j++;
		if (j >= lines.length) break;
		if (lines.slice(i + 1, j).join("\n").trim() === want) found.push({ lineStart: i, lineEnd: j });
		i = j;
	}
	if (!found.length) return undefined;
	if (near === undefined) return found[0];
	return found.reduce((a, b) => (Math.abs(b.lineStart - near) < Math.abs(a.lineStart - near) ? b : a));
}

/** Extract the PGN of the first chess-game block of a note. */
export function firstGameBlock(content: string): string | undefined {
	const m = /^(```+|~~~+)chess-game[^\n]*\n([\s\S]*?)^\1\s*$/m.exec(content);
	return m ? m[2] : undefined;
}

export function fileNameFor(template: string, r: GameRecord): string {
	const tokens: Record<string, string> = {
		date: r.playedAt ? r.playedAt.slice(0, 10) : "unknown-date",
		white: r.white.name,
		black: r.black.name,
		site: SITE_LABEL[r.site] ?? r.site,
		id: r.key.split(":")[1]?.slice(0, 12) ?? r.key,
		result: r.result.replace("1/2-1/2", "½-½"),
		timeClass: r.timeClass ?? "",
	};
	const name = template.replace(/\{(\w+)\}/g, (m, k: string) => tokens[k] ?? m);
	return (
		name
			.replace(/[\\/:*?"<>|#^[\]]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 180) || r.key.replace(/:/g, "-")
	);
}

/* ------------------------------------------------------------------ */
/* Vault-backed writer                                                  */
/* ------------------------------------------------------------------ */

export interface NoteWriterHost {
	app: App;
	gamesFolder(): string;
	fileNameTemplate(): string;
	deletedKeys(): string[];
	initialStatus(): AnalysisStatus;
}

export class NoteWriter {
	/** game-key -> file path */
	readonly index = new Map<string, string>();
	private justCreated = new Set<string>();

	constructor(private host: NoteWriterHost) {}

	private get app() {
		return this.host.app;
	}

	/** Build the key -> file index from the game-key frontmatter of notes in the games folder. */
	buildIndex(): void {
		this.index.clear();
		const folder = normalizePath(this.host.gamesFolder());
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(folder + "/")) continue;
			this.indexFile(f);
		}
	}

	indexFile(f: TFile): void {
		const key = this.app.metadataCache.getFileCache(f)?.frontmatter?.["game-key"];
		if (typeof key === "string" && key) this.index.set(key, f.path);
	}

	keyForPath(path: string): string | undefined {
		for (const [k, p] of this.index) if (p === path) return k;
		return undefined;
	}

	fileFor(key: string): TFile | undefined {
		const p = this.index.get(key);
		const f = p ? this.app.vault.getAbstractFileByPath(p) : null;
		return f instanceof TFile ? f : undefined;
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = normalizePath(path).split("/");
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			const existing = this.app.vault.getAbstractFileByPath(cur);
			if (!existing) await this.app.vault.createFolder(cur);
			else if (!(existing instanceof TFolder)) throw new Error(`"${cur}" exists and is not a folder.`);
		}
	}

	async upsert(r: GameRecord): Promise<UpsertResult> {
		if (this.host.deletedKeys().includes(r.key)) return "deleted";
		const existing = this.fileFor(r.key);
		if (existing) return this.update(existing, r);
		const folder = normalizePath(this.host.gamesFolder());
		await this.ensureFolder(folder);
		const base = fileNameFor(this.host.fileNameTemplate(), r);
		let path = normalizePath(`${folder}/${base}.md`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} (${i}).md`);
		const fm = newNoteFrontmatter(r, this.host.initialStatus());
		await this.app.vault.create(path, renderNote(r, fm));
		this.index.set(r.key, path);
		this.justCreated.add(r.key);
		return "created";
	}

	/** Known key: update plugin-owned keys and the summary only if the source data changed. Never the PGN. */
	private async update(file: TFile, r: GameRecord): Promise<UpsertResult> {
		const current = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!current && this.justCreated.has(r.key)) return "unchanged";
		const wanted = syncFrontmatter(r);
		const changed = changedKeys(current, wanted, SYNC_KEYS);
		const tags = current?.tags;
		const hasTag = Array.isArray(tags) ? tags.includes("chess-game") : typeof tags === "string" && tags.includes("chess-game");
		if (!changed.length && hasTag) return "unchanged";
		await this.writeOwned(file, wanted, SYNC_KEYS);
		return "updated";
	}

	/** Write plugin-owned keys, then refresh the summary region if its text changed. */
	private async writeOwned(file: TFile, wanted: Frontmatter, owned: readonly string[]): Promise<void> {
		let merged: Record<string, unknown> = {};
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			applyOwnedKeys(fm, wanted, owned);
			merged = { ...fm };
		});
		const summary = renderSummary(merged);
		await this.app.vault.process(file, (content) => {
			const next = replaceRegion(content, summary);
			return next;
		});
	}

	async setAnalysis(key: string, values: Frontmatter): Promise<void> {
		const file = this.fileFor(key);
		if (!file) return;
		const current = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		// Keep analysis keys we are not setting (e.g. status-only updates keep the last counts).
		const wanted: Frontmatter = {};
		for (const k of ANALYSIS_KEYS) {
			if (k in values) {
				if (values[k] !== null) wanted[k] = values[k];
			} else if (current[k] !== undefined) wanted[k] = current[k] as Frontmatter[string];
		}
		if (!changedKeys(current, wanted, ANALYSIS_KEYS).length) return;
		await this.writeOwned(file, wanted, ANALYSIS_KEYS);
	}

	async setStatus(key: string, status: AnalysisStatus): Promise<void> {
		await this.setAnalysis(key, { "analysis-status": status });
	}
}
