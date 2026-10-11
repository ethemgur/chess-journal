/** ```chess-game``` processor: renders a lazy BoardView per block and writes edits back into that block only. */
import { MarkdownPostProcessorContext, MarkdownRenderChild, TFile } from "obsidian";
import type ChessReviewPlugin from "../main";
import { CODE_LANG, replaceBlockBody } from "../notes/noteWriter";
import { PgnParseError, pgnHash } from "../pgn/tree";
import { matchMyColour, pgnTags } from "../sources/normalise";
import type { Colour } from "../types";
import { BlockState, BoardHost, BoardView, newBlockState } from "./BoardView";

/** Block state survives re-renders (e.g. after our own write-back). */
const blockStates = new Map<string, BlockState>();

/**
 * Boards on screen, by block. When a block is re-rendered because the note
 * changed (most often our own write-back), the new block adopts the existing
 * board instead of building a new one, so the board never flashes.
 */
interface LiveBoard {
	view: BoardView;
	owner: ChessGameBlock;
	destroyTimer?: number;
}
const liveBoards = new Map<string, LiveBoard>();
const ADOPT_GRACE_MS = 3000;

export function registerChessGameBlock(plugin: ChessReviewPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(CODE_LANG, (source, el, ctx) => {
		ctx.addChild(new ChessGameBlock(plugin, source, el, ctx));
	});
}

export function clearBlockStates(): void {
	for (const live of liveBoards.values()) {
		window.clearTimeout(live.destroyTimer);
		live.view.destroy();
	}
	liveBoards.clear();
	blockStates.clear();
}

class ChessGameBlock extends MarkdownRenderChild {
	private view?: BoardView;
	private observer?: IntersectionObserver;
	private source: string;
	private key?: string;

	constructor(private plugin: ChessReviewPlugin, source: string, el: HTMLElement, private ctx: MarkdownPostProcessorContext) {
		super(el);
		this.source = source;
	}

	onload(): void {
		this.containerEl.addClass("cr-block");
		// A block that was already shown (e.g. re-rendered after a save) renders at once, without a flash.
		if (blockStates.get(this.stateKey())?.rendered) {
			this.renderBoard();
			return;
		}
		const placeholder = this.containerEl.createDiv({ cls: "cr-placeholder" });
		// Boards render lazily when scrolled into view.
		if (typeof IntersectionObserver === "undefined") {
			placeholder.remove();
			this.renderBoard();
			return;
		}
		this.observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) {
				this.observer?.disconnect();
				this.observer = undefined;
				placeholder.remove();
				this.renderBoard();
			}
		}, { rootMargin: "200px" });
		this.observer.observe(this.containerEl);
	}

	onunload(): void {
		this.observer?.disconnect();
		const live = this.key ? liveBoards.get(this.key) : undefined;
		if (this.view && live && live.owner === this) {
			// Keep the board alive briefly in case the re-rendered block adopts it.
			const key = this.key as string;
			live.destroyTimer = window.setTimeout(() => {
				if (liveBoards.get(key) === live) liveBoards.delete(key);
				live.view.destroy();
			}, ADOPT_GRACE_MS);
		} else if (this.view && !live) {
			this.view.destroy();
		}
		this.view = undefined;
	}

	private stateKey(): string {
		const info = this.ctx.getSectionInfo(this.containerEl);
		if (info) {
			const before = info.text.split("\n").slice(0, info.lineStart);
			const index = before.filter((l) => new RegExp("^\\s*(`{3,}|~{3,})" + CODE_LANG).test(l)).length;
			return `${this.ctx.sourcePath}::${index}`;
		}
		return `${this.ctx.sourcePath}::${pgnHash(this.source)}`;
	}

	private frontmatter(): Record<string, unknown> | undefined {
		const f = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		return f instanceof TFile ? this.plugin.app.metadataCache.getFileCache(f)?.frontmatter : undefined;
	}

	private myColour(fm?: Record<string, unknown>): Colour | undefined {
		const c = fm?.["my-colour"];
		if (c === "white" || c === "black") return c;
		const s = this.plugin.settings;
		const tags = pgnTags(this.source);
		const names = [s.lichessUsername, s.chesscomUsername, ...s.otbNames.split(",")].map((x) => x.trim()).filter(Boolean);
		return matchMyColour(tags.get("White") ?? "", tags.get("Black") ?? "", names);
	}

	private renderBoard(): void {
		const key = this.stateKey();
		this.key = key;
		let state = blockStates.get(key);
		if (!state) {
			state = newBlockState();
			blockStates.set(key, state);
		}
		const fm = this.frontmatter();
		const gameKey = typeof fm?.["game-key"] === "string" ? (fm["game-key"] as string) : undefined;
		const plugin = this.plugin;
		const host = (): BoardHost => ({
			app: plugin.app,
			settings: () => plugin.settings,
			engine: plugin.engine,
			gameKey,
			myColour: this.myColour(fm),
			state,
			loadAnalysis: async () => (gameKey ? plugin.cache.get(gameKey) : undefined),
			onAnalysisChange: (fn) => plugin.cache.onChange((k) => k === gameKey && fn()),
			save: (pgn) => this.save(pgn, gameKey),
			askDownloadEngine: () => plugin.confirmEngineDownload(),
			setActive: (v) => plugin.setActiveBoard(v),
		});
		const live = liveBoards.get(key);
		if (live && pgnHash(live.view.savedPgn()) === pgnHash(this.source)) {
			window.clearTimeout(live.destroyTimer);
			live.destroyTimer = undefined;
			live.owner = this;
			this.view = live.view;
			this.view.adopt(this.containerEl, host());
			return;
		}
		if (live) {
			window.clearTimeout(live.destroyTimer);
			if (live.owner !== this) live.view.destroy();
			liveBoards.delete(key);
		}
		try {
			this.view = new BoardView(this.containerEl, this.source, host());
			this.view.render();
			liveBoards.set(key, { view: this.view, owner: this });
		} catch (e) {
			this.renderError(e);
		}
	}

	private renderError(e: unknown): void {
		this.containerEl.empty();
		const box = this.containerEl.createDiv({ cls: "cr-error" });
		box.createDiv({ cls: "cr-error-title", text: "Chess Review could not read this game" });
		const msg = e instanceof PgnParseError ? e.message : `Unexpected error: ${(e as Error)?.message ?? String(e)}`;
		box.createDiv({ cls: "cr-error-message", text: msg });
		if (this.source.trim()) box.createEl("pre", { cls: "cr-error-source", text: this.source.slice(0, 2000) });
		if (!(e instanceof PgnParseError)) console.error("Chess Review:", e);
	}

	/** Replace only this block's body, using its position from getSectionInfo. */
	private async save(pgn: string, gameKey?: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) throw new Error("the note was not found");
		const info = this.ctx.getSectionInfo(this.containerEl);
		if (!info) throw new Error("the block's position in the note is unknown (is it embedded?)");
		const expected = this.source;
		await this.plugin.app.vault.process(file, (data) => {
			const lines = data.split("\n").map((l) => l.replace(/\r$/, ""));
			const open = lines[info.lineStart] ?? "";
			if (!new RegExp("^\\s*(`{3,}|~{3,})" + CODE_LANG).test(open)) {
				throw new Error("the note changed while editing; reopen it and try again");
			}
			const body = lines.slice(info.lineStart + 1, info.lineEnd).join("\n");
			if (body.trim() !== expected.trim()) {
				throw new Error("the game text changed outside the board; reopen the note and try again");
			}
			return replaceBlockBody(data, info.lineStart, info.lineEnd, pgn);
		});
		this.source = pgn;
		if (gameKey) await this.plugin.recordEditedPgn(gameKey, pgnHash(pgn));
	}
}
