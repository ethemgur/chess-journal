import { App, Menu, Modal, Notice, Platform, Plugin, Setting, normalizePath } from "obsidian";
import { ChessJournalSettingTab, ChessJournalSettings, defaultSettings, engineLabel } from "./settings";
import type { AnalysisStatus, Colour, GameRecord } from "./types";
import { NoteWriter, firstGameBlock } from "./notes/noteWriter";
import { SyncEngine, SyncState, emptySummary, emptySyncState, formatSummary } from "./sync/syncEngine";
import { obsidianHttp } from "./sources/http";
import { openPgnImport } from "./sources/pgnFile";
import { registerChessGameBlock, clearBlockStates } from "./board/codeBlock";
import type { BoardView } from "./board/BoardView";
import { ENGINE_TOTAL_MB, EngineFiles } from "./engine/engineFiles";
import { EngineService } from "./engine/service";
import { AnalysisCache } from "./engine/cache";
import { AnalysisQueue, QueueState } from "./engine/queue";

interface PluginData {
	settings: ChessJournalSettings;
	sync: SyncState;
	deletedKeys: string[];
	queue: QueueState;
	/** Hash of the PGN last written by the board editor, per game key. */
	editedPgn: Record<string, string>;
}

export default class ChessJournalPlugin extends Plugin {
	data!: PluginData;
	notes!: NoteWriter;
	engine!: EngineService;
	cache!: AnalysisCache;
	queue!: AnalysisQueue;
	private engineFiles!: EngineFiles;
	private statusEl!: HTMLElement;
	private syncStatus: string | null = null;
	private queueStatus: string | null = null;
	private syncing = false;
	private syncCancelled = false;
	private activeBoard: BoardView | null = null;

	settings!: ChessJournalSettings;

	async onload(): Promise<void> {
		await this.loadPluginData();
		const dir = this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		const adapter = this.app.vault.adapter;
		this.engineFiles = new EngineFiles(
			{
				exists: (p) => adapter.exists(p),
				readBinary: (p) => adapter.readBinary(p),
				writeBinary: (p, d) => adapter.writeBinary(p, d),
				mkdir: (p) => adapter.mkdir(p),
			},
			dir,
			this.manifest.version,
		);
		this.cache = new AnalysisCache(
			{
				exists: (p) => adapter.exists(p),
				read: (p) => adapter.read(p),
				write: (p, d) => adapter.write(p, d),
				remove: (p) => adapter.remove(p),
				mkdir: (p) => adapter.mkdir(p),
			},
			dir,
		);
		this.engine = new EngineService(this.engineFiles, () => this.settings.hashMb);
		this.register(() => this.engine.terminate());
		this.notes = new NoteWriter({
			app: this.app,
			gamesFolder: () => this.settings.gamesFolder,
			fileNameTemplate: () => this.settings.fileNameTemplate,
			deletedKeys: () => this.data.deletedKeys,
			initialStatus: (): AnalysisStatus => (this.settings.autoAnalyse ? "queued" : "none"),
		});
		this.queue = new AnalysisQueue({
			state: this.data.queue,
			save: () => this.savePluginData(),
			engine: this.engine,
			cache: this.cache,
			http: obsidianHttp,
			engineLabel: () => engineLabel(this.settings),
			limits: () => (this.settings.budgetMode === "depth" ? { depth: this.settings.depth } : { movetimeMs: this.settings.movetimeMs }),
			useCloudEval: () => this.settings.useCloudEval,
			canRun: () => !Platform.isMobile || this.settings.analyseOnMobile,
			readGame: (key) => this.readGame(key),
			writeResult: (key, values) => this.notes.setAnalysis(key, values),
			setStatus: (key, status) => this.notes.setStatus(key, status),
			status: (t) => {
				this.queueStatus = t;
				this.renderStatus();
			},
			notify: (t) => new Notice(`Chess Journal: ${t}`),
		});

		this.addSettingTab(new ChessJournalSettingTab(this.app, this));
		registerChessGameBlock(this);
		this.register(() => clearBlockStates());

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("cr-status", "mod-clickable");
		this.registerDomEvent(this.statusEl, "click", (e) => this.openStatusMenu(e));
		this.renderStatus();

		this.addRibbonIcon("crown", "Chess Journal", (e) => {
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Sync all games").setIcon("refresh-cw").onClick(() => void this.runSync("all")));
			menu.addItem((i) => i.setTitle("Import PGN file").setIcon("file-input").onClick(() => this.importPgn()));
			menu.addItem((i) =>
				i.setTitle(this.queue.paused ? "Resume analysis" : "Pause analysis").setIcon("cpu").onClick(() => void this.togglePause()),
			);
			menu.showAtMouseEvent(e);
		});

		this.registerCommands();
		this.registerVaultEvents();

		this.app.workspace.onLayoutReady(() => {
			this.notes.buildIndex();
			this.queue.kick();
			if (this.settings.syncOnStartup) {
				const t = window.setTimeout(() => void this.runSync("all"), 30_000);
				this.register(() => window.clearTimeout(t));
			}
		});
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.notes.buildIndex()));
		this.registerDomEvent(document, "visibilitychange", () => {
			if (Platform.isMobile) this.queue.setSuspended(document.hidden);
		});
	}

	onunload(): void {
		this.syncCancelled = true;
	}

	/* ------------------------------------------------------------ */
	/* Data                                                         */
	/* ------------------------------------------------------------ */

	private async loadPluginData(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.data = {
			settings: Object.assign(defaultSettings(), raw.settings ?? {}),
			sync: Object.assign(emptySyncState(), raw.sync ?? {}),
			deletedKeys: raw.deletedKeys ?? [],
			queue: Object.assign({ queue: [], paused: false }, raw.queue ?? {}),
			editedPgn: raw.editedPgn ?? {},
		};
		this.settings = this.data.settings;
	}

	async savePluginData(): Promise<void> {
		await this.saveData(this.data);
	}

	async saveSettings(): Promise<void> {
		await this.savePluginData();
	}

	async recordEditedPgn(key: string, hash: string): Promise<void> {
		this.data.editedPgn[key] = hash;
		await this.savePluginData();
	}

	setActiveBoard(v: BoardView | null): void {
		if (v || this.activeBoard) this.activeBoard = v;
	}

	/* ------------------------------------------------------------ */
	/* Commands                                                     */
	/* ------------------------------------------------------------ */

	private registerCommands(): void {
		this.addCommand({ id: "sync-all", name: "Sync all games", callback: () => void this.runSync("all") });
		this.addCommand({ id: "sync-lichess", name: "Sync Lichess games", callback: () => void this.runSync("lichess") });
		this.addCommand({ id: "sync-chesscom", name: "Sync chess.com games", callback: () => void this.runSync("chesscom") });
		this.addCommand({ id: "cancel-sync", name: "Cancel sync", checkCallback: (checking) => {
			if (!this.syncing) return false;
			if (!checking) this.syncCancelled = true;
			return true;
		} });
		this.addCommand({ id: "import-pgn", name: "Import PGN file", callback: () => this.importPgn() });
		this.addCommand({
			id: "analyse-this-game",
			name: "Analyse this game",
			checkCallback: (checking) => {
				const key = this.activeGameKey();
				if (!key) return false;
				if (!checking) void this.enqueue([key], true);
				return true;
			},
		});
		this.addCommand({
			id: "analyse-unanalysed",
			name: "Analyse all unanalysed games",
			callback: () => {
				const keys = this.gamesWhere((fm) => {
					const s = fm["analysis-status"];
					return s === undefined || s === "none" || s === "failed";
				});
				void this.enqueue(keys, false);
			},
		});
		this.addCommand({
			id: "reanalyse",
			name: "Re-analyse with current settings",
			callback: () => {
				const label = engineLabel(this.settings);
				const keys = this.gamesWhere((fm) => fm["analysis-status"] === "done" && fm.engine !== label);
				void this.enqueue(keys, false);
			},
		});
		this.addCommand({ id: "toggle-analysis", name: "Pause / resume analysis", callback: () => void this.togglePause() });
		this.addCommand({
			id: "cancel-analysis",
			name: "Cancel analysis",
			callback: async () => {
				await this.queue.cancel();
				new Notice("Chess Journal: analysis queue emptied.");
			},
		});
		this.addCommand({
			id: "open-on-site",
			name: "Open game on site",
			checkCallback: (checking) => {
				const url = this.activeFrontmatter()?.url;
				if (typeof url !== "string" || !/^https:\/\//.test(url)) return false;
				if (!checking) window.open(url);
				return true;
			},
		});
		this.addCommand({
			id: "copy-pgn",
			name: "Copy PGN",
			callback: async () => {
				let pgn = this.activeBoard?.getPgn();
				if (!pgn) {
					const f = this.app.workspace.getActiveFile();
					if (f) pgn = firstGameBlock(await this.app.vault.read(f))?.trim();
				}
				if (!pgn) {
					new Notice("Chess Journal: no game on screen.");
					return;
				}
				await navigator.clipboard.writeText(pgn);
				new Notice("PGN copied.");
			},
		});
		this.addCommand({ id: "download-engine", name: "Download engine", callback: () => this.confirmEngineDownload(true) });
	}

	private importPgn(): void {
		const created: string[] = [];
		openPgnImport({
			app: this.app,
			myNames: () => this.settings.otbNames.split(",").map((s) => s.trim()).filter(Boolean),
			upsert: async (r) => {
				if (!this.notes.index.size) this.notes.buildIndex();
				return this.notes.upsert(r);
			},
			onCreated: (r: GameRecord) => {
				created.push(r.key);
				if (this.settings.autoAnalyse) void this.queue.enqueue([r.key]);
			},
		});
	}

	private activeFrontmatter(): Record<string, unknown> | undefined {
		const f = this.app.workspace.getActiveFile();
		return f ? this.app.metadataCache.getFileCache(f)?.frontmatter : undefined;
	}

	private activeGameKey(): string | undefined {
		const k = this.activeFrontmatter()?.["game-key"];
		return typeof k === "string" ? k : undefined;
	}

	private gamesWhere(pred: (fm: Record<string, unknown>) => boolean): string[] {
		this.notes.buildIndex();
		const out: string[] = [];
		for (const [key] of this.notes.index) {
			const f = this.notes.fileFor(key);
			const fm = f && this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm && pred(fm)) out.push(key);
		}
		return out;
	}

	private async enqueue(keys: string[], front: boolean): Promise<void> {
		if (!keys.length) {
			new Notice("Chess Journal: nothing to analyse.");
			return;
		}
		if (!(await this.engine.installed())) {
			this.confirmEngineDownload();
		}
		const n = await this.queue.enqueue(keys, front);
		const extra = !Platform.isMobile || this.settings.analyseOnMobile ? "" : " Analysis runs on desktop (or turn on “Analyse on mobile”).";
		new Notice(`Chess Journal: ${n || keys.length} game${keys.length === 1 ? "" : "s"} queued for analysis.${extra}`);
	}

	private async togglePause(): Promise<void> {
		if (this.queue.paused) {
			await this.queue.resume();
			new Notice("Chess Journal: analysis resumed.");
		} else {
			await this.queue.pause();
			new Notice("Chess Journal: analysis paused.");
		}
	}

	private async readGame(key: string): Promise<{ pgn: string; myColour: Colour } | undefined> {
		if (!this.notes.fileFor(key)) this.notes.buildIndex();
		const f = this.notes.fileFor(key);
		if (!f) return undefined;
		const pgn = firstGameBlock(await this.app.vault.read(f));
		if (!pgn) return undefined;
		const c = this.app.metadataCache.getFileCache(f)?.frontmatter?.["my-colour"];
		return { pgn, myColour: c === "black" ? "black" : "white" };
	}

	/* ------------------------------------------------------------ */
	/* Sync                                                         */
	/* ------------------------------------------------------------ */

	async runSync(which: "all" | "lichess" | "chesscom"): Promise<void> {
		const s = this.settings;
		if (this.syncing) {
			new Notice("Chess Journal: a sync is already running.");
			return;
		}
		const doLichess = which !== "chesscom" && !!s.lichessUsername;
		const doChesscom = which !== "lichess" && !!s.chesscomUsername;
		if (!doLichess && !doChesscom) {
			new Notice("Chess Journal: set your Lichess or chess.com username in the settings first.");
			return;
		}
		this.syncing = true;
		this.syncCancelled = false;
		const created: string[] = [];
		new Notice("Chess Journal: sync started.");
		try {
			this.notes.buildIndex();
			const engine = new SyncEngine(
				{
					lichessUsername: doLichess ? s.lichessUsername : "",
					lichessToken: s.lichessToken,
					chesscomUsername: doChesscom ? s.chesscomUsername : "",
					contactEmail: s.contactEmail,
					timeClasses: s.timeClasses,
					ratedOnly: s.ratedOnly,
					importSince: s.importSince,
					version: this.manifest.version,
				},
				{
					http: obsidianHttp,
					sink: this.notes,
					state: this.data.sync,
					saveState: () => this.savePluginData(),
					sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
					now: () => Date.now(),
					progress: (m) => {
						this.syncStatus = m;
						this.renderStatus();
					},
					isCancelled: () => this.syncCancelled,
					onCreated: (r) => created.push(r.key),
				},
			);
			const summary = emptySummary();
			if (doLichess) await engine.syncLichess(summary);
			if (doChesscom && !summary.aborted && !summary.cancelled) await engine.syncChesscom(summary);
			const notes = summary.notes.filter((n) => !n.startsWith("chess.com refreshes") || doChesscom);
			new Notice(`Chess Journal sync finished: ${formatSummary(summary)}` + (notes.length ? `\n${notes.slice(0, 4).join("\n")}` : ""), 10_000);
			if (created.length && s.autoAnalyse) await this.queue.enqueue(created);
		} catch (e) {
			new Notice(`Chess Journal sync failed: ${(e as Error).message}`, 10_000);
			console.error("Chess Journal sync:", e);
		} finally {
			this.syncing = false;
			this.syncStatus = null;
			this.renderStatus();
		}
	}

	/* ------------------------------------------------------------ */
	/* Status bar                                                   */
	/* ------------------------------------------------------------ */

	private renderStatus(): void {
		if (!this.statusEl) return;
		const text = this.syncStatus ?? this.queueStatus;
		this.statusEl.setText(text ?? "");
		this.statusEl.toggleClass("is-hidden", !text);
	}

	private openStatusMenu(e: MouseEvent): void {
		const menu = new Menu();
		if (this.syncing) menu.addItem((i) => i.setTitle("Cancel sync").setIcon("x").onClick(() => (this.syncCancelled = true)));
		if (this.queue.length) {
			menu.addItem((i) =>
				i.setTitle(this.queue.paused ? "Resume analysis" : "Pause analysis").setIcon(this.queue.paused ? "play" : "pause").onClick(() => void this.togglePause()),
			);
			menu.addItem((i) => i.setTitle("Cancel analysis").setIcon("x").onClick(() => void this.queue.cancel()));
		}
		menu.showAtMouseEvent(e);
	}

	/* ------------------------------------------------------------ */
	/* Vault events: index, deletions                               */
	/* ------------------------------------------------------------ */

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				const key = this.notes.keyForPath(file.path);
				if (!key) return;
				this.notes.index.delete(key);
				// A game the user deleted is not re-created on the next sync.
				if (!this.data.deletedKeys.includes(key)) this.data.deletedKeys.push(key);
				this.data.queue.queue = this.data.queue.queue.filter((k) => k !== key || k === this.queue.currentKey);
				void this.savePluginData();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const key = this.notes.keyForPath(oldPath);
				if (key) this.notes.index.set(key, file.path);
			}),
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path.startsWith(normalizePath(this.settings.gamesFolder) + "/")) this.notes.indexFile(file);
			}),
		);
	}

	/* ------------------------------------------------------------ */
	/* Engine download                                              */
	/* ------------------------------------------------------------ */

	confirmEngineDownload(force = false): void {
		void (async () => {
			if (!force && (await this.engine.installed())) return;
			new EngineDownloadModal(this.app, this.engineFiles.source, async () => {
				const n = new Notice("Chess Journal: downloading engine…", 0);
				try {
					await this.engineFiles.download((m) => n.setMessage(`Chess Journal: ${m}`));
					n.setMessage("Chess Journal: engine downloaded and verified.");
					window.setTimeout(() => n.hide(), 4000);
					this.engine.terminate();
					this.queue.kick();
				} catch (e) {
					n.setMessage(`Chess Journal: engine download failed. ${(e as Error).message}`);
					window.setTimeout(() => n.hide(), 10_000);
				}
			}).open();
		})();
	}
}

class EngineDownloadModal extends Modal {
	constructor(app: App, private source: string, private onConfirm: () => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Download the Stockfish engine?");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text: `Analysis uses Stockfish 18 (lite, single-threaded WebAssembly build, GPL-3.0). It is about ${ENGINE_TOTAL_MB} MB and is downloaded once from the plugin's GitHub release, checked against a SHA-256 hash, and stored in the plugin folder.`,
		});
		contentEl.createEl("p", { cls: "cr-muted", text: `Source: ${this.source}/` });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Download").setCta().onClick(() => {
				this.close();
				void this.onConfirm();
			}))
			.addButton((b) => b.setButtonText("Not now").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

