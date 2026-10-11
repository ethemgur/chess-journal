import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type ChessJournalPlugin from "./main";
import { TIME_CLASSES, TimeClass } from "./types";

export type BudgetMode = "time" | "depth";
export type Orientation = "mine" | "white" | "black";

export interface ChessJournalSettings {
	// Accounts
	lichessUsername: string;
	lichessToken: string;
	chesscomUsername: string;
	contactEmail: string;
	otbNames: string;
	// Sync
	gamesFolder: string;
	fileNameTemplate: string;
	timeClasses: TimeClass[];
	ratedOnly: boolean;
	importSince: string; // YYYY-MM-DD
	syncOnStartup: boolean;
	// Engine
	autoAnalyse: boolean;
	budgetMode: BudgetMode;
	movetimeMs: number;
	depth: number;
	hashMb: number;
	useCloudEval: boolean;
	analyseOnMobile: boolean;
	// Board
	pieceSet: string;
	boardTheme: string;
	showClocks: boolean;
	orientation: Orientation;
	// Dashboard
	dashboardPeriod: "30d" | "3m" | "12m" | "all";
	dashboardPalette: "accent" | "semantic" | "soft";
	dashboardMinGames: number;
}

function monthsAgo(n: number): string {
	const d = new Date();
	d.setUTCMonth(d.getUTCMonth() - n);
	return d.toISOString().slice(0, 10);
}

export function defaultSettings(): ChessJournalSettings {
	return {
		lichessUsername: "",
		lichessToken: "",
		chesscomUsername: "",
		contactEmail: "",
		otbNames: "",
		gamesFolder: "Chess/Games",
		fileNameTemplate: "{date} {white} vs {black} ({site})",
		timeClasses: ["rapid", "classical", "daily"],
		ratedOnly: true,
		importSince: monthsAgo(12),
		syncOnStartup: false,
		autoAnalyse: false,
		budgetMode: "time",
		movetimeMs: 1500,
		depth: 18,
		hashMb: Platform.isMobile ? 16 : 64,
		useCloudEval: true,
		analyseOnMobile: false,
		pieceSet: "cburnett",
		boardTheme: "brown",
		showClocks: true,
		orientation: "mine",
		dashboardPeriod: "3m",
		dashboardPalette: "semantic",
		dashboardMinGames: 5,
	};
}

/** Engine label stored in each game's frontmatter, e.g. "stockfish-18-lite@1.5s". */
export function engineLabel(s: ChessJournalSettings): string {
	return s.budgetMode === "time"
		? `stockfish-18-lite@${(s.movetimeMs / 1000).toString()}s`
		: `stockfish-18-lite@d${s.depth}`;
}

export const PIECE_SETS: Record<string, string> = { cburnett: "Cburnett" };
export const BOARD_THEMES: Record<string, string> = { brown: "Brown", blue: "Blue", green: "Green", grey: "Grey" };

export class ChessJournalSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ChessJournalPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Accounts").setHeading();
		new Setting(containerEl)
			.setName("Lichess username")
			.setDesc("Lichess sync is off while this is empty.")
			.addText((t) => t.setValue(s.lichessUsername).onChange(async (v) => { s.lichessUsername = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("Lichess API token")
			.setDesc("Optional. Raises the export rate for your own games. Stored only in this plugin's data.json.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.lichessToken).onChange(async (v) => { s.lichessToken = v.trim(); await save(); });
			});
		new Setting(containerEl)
			.setName("chess.com username")
			.setDesc("chess.com sync is off while this is empty.")
			.addText((t) => t.setValue(s.chesscomUsername).onChange(async (v) => { s.chesscomUsername = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("Contact email for API User-Agent")
			.setDesc("Sent to chess.com in the User-Agent header, as chess.com asks of API clients.")
			.addText((t) => t.setValue(s.contactEmail).onChange(async (v) => { s.contactEmail = v.trim(); await save(); }));
		new Setting(containerEl)
			.setName("My OTB names")
			.setDesc("Comma-separated names you appear under in PGN files, used to work out your colour.")
			.addText((t) => t.setValue(s.otbNames).onChange(async (v) => { s.otbNames = v; await save(); }));

		new Setting(containerEl).setName("Sync").setHeading();
		new Setting(containerEl)
			.setName("Games folder")
			.setDesc("Created if missing.")
			.addText((t) => t.setValue(s.gamesFolder).onChange(async (v) => { s.gamesFolder = v.trim().replace(/\/+$/, "") || "Chess/Games"; await save(); }));
		new Setting(containerEl)
			.setName("File name template")
			.setDesc("Tokens: {date} {white} {black} {site} {id} {result} {timeClass}")
			.addText((t) => t.setValue(s.fileNameTemplate).onChange(async (v) => { s.fileNameTemplate = v || "{date} {white} vs {black} ({site})"; await save(); }));
		new Setting(containerEl)
			.setName("Time classes to import")
			.setDesc("Uses each site's own label for the game's speed.");
		const speeds: Record<TimeClass, [string, string]> = {
			bullet: ["Bullet", "Lichess (incl. UltraBullet) and chess.com"],
			blitz: ["Blitz", "Lichess and chess.com"],
			rapid: ["Rapid", "Lichess and chess.com"],
			classical: ["Classical", "Lichess only"],
			daily: ["Daily", "chess.com Daily and Lichess Correspondence"],
		};
		for (const c of TIME_CLASSES) {
			new Setting(containerEl)
				.setClass("cr-setting-sub")
				.setName(speeds[c][0])
				.setDesc(speeds[c][1])
				.addToggle((t) =>
					t.setValue(s.timeClasses.includes(c)).onChange(async (on) => {
						s.timeClasses = on ? [...new Set([...s.timeClasses, c])] : s.timeClasses.filter((x) => x !== c);
						await save();
					}),
				);
		}
		new Setting(containerEl)
			.setName("Rated games only")
			.addToggle((t) => t.setValue(s.ratedOnly).onChange(async (v) => { s.ratedOnly = v; await save(); }));
		new Setting(containerEl)
			.setName("Import games since")
			.setDesc("Limits the first sync. Format YYYY-MM-DD.")
			.addText((t) => {
				t.inputEl.type = "date";
				t.setValue(s.importSince).onChange(async (v) => {
					if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { s.importSince = v; await save(); }
				});
			});
		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Runs 30 seconds after Obsidian loads.")
			.addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => { s.syncOnStartup = v; await save(); }));
		new Setting(containerEl)
			.setName("Deleted games")
			.setDesc(`Games whose notes you deleted are not re-created (${this.plugin.data.deletedKeys.length} remembered).`)
			.addButton((b) => b.setButtonText("Clear list").onClick(async () => {
				this.plugin.data.deletedKeys = [];
				await save();
				this.display();
			}));

		new Setting(containerEl).setName("Engine").setHeading();
		new Setting(containerEl)
			.setName("Analyse new games automatically")
			.setDesc("Runs Stockfish on this device for every imported game. Off by default: the dashboard uses the accuracy Lichess and chess.com provide.")
			.addToggle((t) => t.setValue(s.autoAnalyse).onChange(async (v) => { s.autoAnalyse = v; await save(); }));
		new Setting(containerEl)
			.setName("Analysis budget")
			.setDesc("Time per position is predictable; fixed depth is reproducible across machines.")
			.addDropdown((d) => d.addOptions({ time: "Time per position", depth: "Fixed depth" }).setValue(s.budgetMode)
				.onChange(async (v) => { s.budgetMode = v as BudgetMode; await save(); this.display(); }));
		if (s.budgetMode === "time") {
			new Setting(containerEl)
				.setName("Seconds per position")
				.addSlider((sl) => sl.setLimits(0.2, 5, 0.1).setValue(s.movetimeMs / 1000).setDynamicTooltip()
					.onChange(async (v) => { s.movetimeMs = Math.round(v * 1000); await save(); }));
		} else {
			new Setting(containerEl)
				.setName("Depth")
				.addSlider((sl) => sl.setLimits(8, 30, 1).setValue(s.depth).setDynamicTooltip()
					.onChange(async (v) => { s.depth = v; await save(); }));
		}
		new Setting(containerEl)
			.setName("Hash size (MB)")
			.addDropdown((d) => d.addOptions({ "16": "16", "32": "32", "64": "64", "128": "128", "256": "256" })
				.setValue(String(s.hashMb)).onChange(async (v) => { s.hashMb = Number(v); await save(); }));
		new Setting(containerEl)
			.setName("Use Lichess cloud eval")
			.setDesc("Opening positions only (at most 20 plies per game).")
			.addToggle((t) => t.setValue(s.useCloudEval).onChange(async (v) => { s.useCloudEval = v; await save(); }));
		new Setting(containerEl)
			.setName("Analyse on mobile")
			.setDesc("Off by default for battery and heat.")
			.addToggle((t) => t.setValue(s.analyseOnMobile).onChange(async (v) => { s.analyseOnMobile = v; await save(); }));

		new Setting(containerEl).setName("Board").setHeading();
		new Setting(containerEl)
			.setName("Piece set")
			.addDropdown((d) => d.addOptions(PIECE_SETS).setValue(s.pieceSet).onChange(async (v) => { s.pieceSet = v; await save(); }));
		new Setting(containerEl)
			.setName("Board theme")
			.addDropdown((d) => d.addOptions(BOARD_THEMES).setValue(s.boardTheme).onChange(async (v) => { s.boardTheme = v; await save(); }));
		new Setting(containerEl)
			.setName("Show clocks")
			.addToggle((t) => t.setValue(s.showClocks).onChange(async (v) => { s.showClocks = v; await save(); }));
		new Setting(containerEl)
			.setName("Orientation")
			.addDropdown((d) => d.addOptions({ mine: "From my colour", white: "White at bottom", black: "Black at bottom" })
				.setValue(s.orientation).onChange(async (v) => { s.orientation = v as Orientation; await save(); }));

		new Setting(containerEl).setName("Dashboard").setHeading();
		new Setting(containerEl)
			.setName("Default period")
			.addDropdown((d) => d.addOptions({ "30d": "30 days", "3m": "3 months", "12m": "12 months", all: "All" })
				.setValue(s.dashboardPeriod).onChange(async (v) => { s.dashboardPeriod = v as ChessJournalSettings["dashboardPeriod"]; await save(); }));
		new Setting(containerEl)
			.setName("Chart colours")
			.setDesc("Semantic: neutral series, green for better and red for worse. Vault accent and Soft follow your theme's accent colour.")
			.addDropdown((d) => d.addOptions({ semantic: "Semantic", accent: "Vault accent", soft: "Soft" })
				.setValue(s.dashboardPalette).onChange(async (v) => { s.dashboardPalette = v as ChessJournalSettings["dashboardPalette"]; await save(); }));
		new Setting(containerEl)
			.setName("Minimum games before showing a percentage")
			.addSlider((sl) => sl.setLimits(1, 20, 1).setValue(s.dashboardMinGames).setDynamicTooltip()
				.onChange(async (v) => { s.dashboardMinGames = v; await save(); }));
	}
}
