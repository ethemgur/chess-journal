/** The dashboard's game index: game-note frontmatter from metadataCache, refreshed on change. */
import { App, TFile, normalizePath } from "obsidian";
import { GameRow, rowFromFrontmatter } from "./compute";

export const INDEX_DEBOUNCE_MS = 2000;

export class GameIndex {
	private rows?: GameRow[];
	private listeners = new Set<() => void>();
	private timer?: number;

	constructor(private app: App, private gamesFolder: () => string) {}

	/** All game rows (built on first use, then kept until invalidated). */
	all(): GameRow[] {
		if (!this.rows) this.rows = this.build();
		return this.rows;
	}

	private build(): GameRow[] {
		const folder = normalizePath(this.gamesFolder());
		const out: GameRow[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(folder + "/")) continue;
			const row = this.rowFor(f);
			if (row) out.push(row);
		}
		return out;
	}

	private rowFor(f: TFile): GameRow | undefined {
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm || typeof fm["game-key"] !== "string") return undefined;
		return rowFromFrontmatter(f.path, fm);
	}

	/** Note changes: rebuild after a short pause (debounced). */
	invalidate(immediate = false): void {
		window.clearTimeout(this.timer);
		const run = () => {
			this.rows = undefined;
			for (const l of this.listeners) l();
		};
		if (immediate) run();
		else this.timer = window.setTimeout(run, INDEX_DEBOUNCE_MS);
	}

	isGameFile(path: string): boolean {
		return path.startsWith(normalizePath(this.gamesFolder()) + "/");
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	dispose(): void {
		window.clearTimeout(this.timer);
		this.listeners.clear();
	}
}
