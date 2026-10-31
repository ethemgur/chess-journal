import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type ChessJournalPlugin from "./main";
import { TIME_CLASSES, TimeClass } from "./types";
import type { GameRecord } from "./types";
import { fileNameFor } from "./notes/noteWriter";
import { obsidianHttp } from "./sources/http";
import { LICHESS_HOST } from "./sources/lichess";
import { parseLichessUser } from "./dashboard/ratings";

export type BudgetMode = "time" | "depth";
export type Orientation = "mine" | "white" | "black";

export interface ChessJournalSettings {
	// Accounts
	lichessUsername: string;
	lichessToken: string;
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

/** Lichess's names for the speeds, in the order Lichess lists them. */
const SPEED_LABEL: Record<TimeClass, string> = {
	bullet: "Bullet",
	blitz: "Blitz",
	rapid: "Rapid",
	classical: "Classical",
	daily: "Correspondence",
};

const TOKEN_URL = "https://lichess.org/account/oauth/token/create?description=Chess%20Journal";

/** A sample game for the file name preview. */
function sampleRecord(username: string): GameRecord {
	return {
		key: "lichess:AbCd1234",
		site: "lichess",
		playedAt: "2026-10-04T18:22:10Z",
		white: { name: username || "you" },
		black: { name: "opponent" },
		myColour: "white",
		result: "1-0",
		myResult: "win",
		timeClass: "rapid",
		pgn: "",
	};
}

export class ChessJournalSettingTab extends PluginSettingTab {
	private showAdvanced = false;

	constructor(app: App, private plugin: ChessJournalPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		/* Lichess ----------------------------------------------------- */
		new Setting(containerEl).setName("Lichess").setHeading();
		const user = new Setting(containerEl)
			.setName("Username")
			.setDesc("Your Lichess account. Sync is off while this is empty.");
		const userStatus = user.descEl.createDiv({ cls: "cr-setting-status" });
		user.addText((t) =>
			t.setPlaceholder("e.g. DrNykterstein").setValue(s.lichessUsername).onChange(async (v) => {
				s.lichessUsername = v.trim();
				userStatus.setText("");
				await save();
			}),
		);
		user.addButton((b) =>
			b.setButtonText("Check").onClick(async () => {
				userStatus.setText("Checking…");
				userStatus.removeClass("is-good", "is-bad");
				const r = await checkLichessUser(s.lichessUsername);
				userStatus.setText(r.text);
				userStatus.addClass(r.ok ? "is-good" : "is-bad");
			}),
		);

		const token = new Setting(containerEl).setName("API token").setDesc("Optional. Makes syncing about three times faster. No permissions are needed. ");
		token.descEl.createEl("a", { text: "Create a token", href: TOKEN_URL });
		token.descEl.appendText(". Stored only in this plugin's data.json.");
		token.addText((t) => {
			t.inputEl.type = "password";
			t.setPlaceholder("lip_…").setValue(s.lichessToken).onChange(async (v) => { s.lichessToken = v.trim(); await save(); });
		});

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Imports new games and fills in games Lichess has analysed since the last sync. “Re-read all” downloads every game since the start date again.")
			.addButton((b) => b.setButtonText("Re-read all").onClick(() => void this.plugin.refreshAll()))
			.addButton((b) => b.setButtonText("Sync").setCta().onClick(() => void this.plugin.runSync()));
		new Setting(containerEl)
			.setName("Sync when Obsidian starts")
			.setDesc("30 seconds after start-up.")
			.addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => { s.syncOnStartup = v; await save(); }));

		/* Which games ------------------------------------------------- */
		new Setting(containerEl).setName("Games to import").setHeading();
		const speeds = new Setting(containerEl).setName("Speeds").setDesc("Bullet includes UltraBullet.");
		const pills = speeds.controlEl.createDiv({ cls: "cr-pills", attr: { role: "group", "aria-label": "Speeds" } });
		for (const c of TIME_CLASSES) {
			const on = s.timeClasses.includes(c);
			const pill = pills.createEl("button", { cls: "cr-toggle" + (on ? " is-on" : ""), text: SPEED_LABEL[c], attr: { "aria-pressed": String(on) } });
			pill.addEventListener("click", async () => {
				if (on && s.timeClasses.length === 1) {
					new Notice("Chess Journal: keep at least one speed.");
					return;
				}
				s.timeClasses = on ? s.timeClasses.filter((x) => x !== c) : TIME_CLASSES.filter((x) => x === c || s.timeClasses.includes(x));
				await save();
				this.display();
			});
		}
		new Setting(containerEl)
			.setName("Rated games only")
			.addToggle((t) => t.setValue(s.ratedOnly).onChange(async (v) => { s.ratedOnly = v; await save(); }));
		new Setting(containerEl)
			.setName("Games since")
			.setDesc("Games played before this date are not imported.")
			.addText((t) => {
				t.inputEl.type = "date";
				t.setValue(s.importSince).onChange(async (v) => {
					if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { s.importSince = v; await save(); }
				});
			});
		containerEl.createDiv({
			cls: "setting-item-description cr-setting-note",
			text: "Changing these re-reads your games from that date on the next sync.",
		});

		/* Notes ------------------------------------------------------- */
		new Setting(containerEl).setName("Notes").setHeading();
		new Setting(containerEl)
			.setName("Folder")
			.setDesc("Where game notes are created. Created if missing.")
			.addText((t) => t.setPlaceholder("Chess/Games").setValue(s.gamesFolder).onChange(async (v) => {
				s.gamesFolder = v.trim().replace(/\/+$/, "") || "Chess/Games";
				await save();
			}));
		const name = new Setting(containerEl).setName("File name");
		const preview = () => {
			name.descEl.empty();
			name.descEl.appendText("Tokens: {date} {white} {black} {site} {id} {result} {timeClass}");
			name.descEl.createDiv({ cls: "cr-setting-status", text: `Example: ${fileNameFor(s.fileNameTemplate, sampleRecord(s.lichessUsername))}.md` });
		};
		preview();
		name.addText((t) => t.setValue(s.fileNameTemplate).onChange(async (v) => {
			s.fileNameTemplate = v || "{date} {white} vs {black} ({site})";
			preview();
			await save();
		}));
		const deleted = this.plugin.data.deletedKeys.length;
		new Setting(containerEl)
			.setName("Deleted games")
			.setDesc(
				deleted
					? `${deleted} game${deleted === 1 ? "" : "s"} whose notes you deleted will not be imported again. Clear the list to bring them back on the next “Re-read all”.`
					: "Games whose notes you delete are not imported again.",
			)
			.addButton((b) => {
				b.setButtonText("Clear list").setDisabled(!deleted).onClick(async () => {
					this.plugin.data.deletedKeys = [];
					await save();
					this.display();
				});
			});

		/* OTB games --------------------------------------------------- */
		new Setting(containerEl).setName("Over-the-board games").setHeading();
		containerEl.createDiv({
			cls: "setting-item-description cr-setting-note",
			text: "Import PGN files with “Import PGN file”. Lichess games use Lichess's own analysis; Stockfish on this device analyses OTB games.",
		});
		new Setting(containerEl)
			.setName("My names in PGN files")
			.setDesc("Comma-separated, to tell which colour you played. “Gur, Ethem” and “Ethem Gur” both match.")
			.addText((t) => t.setValue(s.otbNames).onChange(async (v) => { s.otbNames = v; await save(); }));
		new Setting(containerEl)
			.setName("Analyse imported games automatically")
			.addToggle((t) => t.setValue(s.autoAnalyse).onChange(async (v) => { s.autoAnalyse = v; await save(); }));
		new Setting(containerEl)
			.setName("Analyse on mobile")
			.setDesc("Off by default for battery and heat; analysis then waits for a desktop.")
			.addToggle((t) => t.setValue(s.analyseOnMobile).onChange(async (v) => { s.analyseOnMobile = v; await save(); }));
		const strength = new Setting(containerEl)
			.setName("Analysis strength")
			.setDesc(s.budgetMode === "time"
				? `${(s.movetimeMs / 1000).toFixed(1)} s per position. Time is predictable on every device.`
				: `Depth ${s.depth}. Fixed depth gives the same result on every device.`);
		strength.addDropdown((d) => d.addOptions({ time: "Seconds per move", depth: "Fixed depth" }).setValue(s.budgetMode)
			.onChange(async (v) => { s.budgetMode = v as BudgetMode; await save(); this.display(); }));
		if (s.budgetMode === "time") {
			strength.addSlider((sl) => sl.setLimits(0.2, 5, 0.1).setValue(s.movetimeMs / 1000).setDynamicTooltip()
				.onChange(async (v) => {
					s.movetimeMs = Math.round(v * 1000);
					strength.setDesc(`${v.toFixed(1)} s per position. Time is predictable on every device.`);
					await save();
				}));
		} else {
			strength.addSlider((sl) => sl.setLimits(8, 30, 1).setValue(s.depth).setDynamicTooltip()
				.onChange(async (v) => {
					s.depth = v;
					strength.setDesc(`Depth ${v}. Fixed depth gives the same result on every device.`);
					await save();
				}));
		}
		new Setting(containerEl)
			.setName("Advanced engine settings")
			.addExtraButton((b) => b.setIcon(this.showAdvanced ? "chevron-up" : "chevron-down").setTooltip(this.showAdvanced ? "Hide" : "Show")
				.onClick(() => { this.showAdvanced = !this.showAdvanced; this.display(); }));
		if (this.showAdvanced) {
			new Setting(containerEl)
				.setClass("cr-setting-sub")
				.setName("Hash size")
				.setDesc("Engine memory. More is slightly stronger and uses more RAM.")
				.addDropdown((d) => d.addOptions({ "16": "16 MB", "32": "32 MB", "64": "64 MB", "128": "128 MB", "256": "256 MB" })
					.setValue(String(s.hashMb)).onChange(async (v) => { s.hashMb = Number(v); await save(); }));
			new Setting(containerEl)
				.setClass("cr-setting-sub")
				.setName("Use Lichess cloud evaluations for the opening")
				.setDesc("Up to the first 20 plies, while Lichess has the position. Faster than analysing them here.")
				.addToggle((t) => t.setValue(s.useCloudEval).onChange(async (v) => { s.useCloudEval = v; await save(); }));
		}

		/* Board ------------------------------------------------------- */
		new Setting(containerEl).setName("Board").setHeading();
		new Setting(containerEl)
			.setName("Colours")
			.addDropdown((d) => d.addOptions(BOARD_THEMES).setValue(s.boardTheme).onChange(async (v) => { s.boardTheme = v; await save(); }));
		if (Object.keys(PIECE_SETS).length > 1) {
			new Setting(containerEl)
				.setName("Pieces")
				.addDropdown((d) => d.addOptions(PIECE_SETS).setValue(s.pieceSet).onChange(async (v) => { s.pieceSet = v; await save(); }));
		}
		new Setting(containerEl)
			.setName("Orientation")
			.addDropdown((d) => d.addOptions({ mine: "My colour at the bottom", white: "White at the bottom", black: "Black at the bottom" })
				.setValue(s.orientation).onChange(async (v) => { s.orientation = v as Orientation; await save(); }));
		new Setting(containerEl)
			.setName("Show clocks")
			.setDesc("Time left and time spent per move, when the game has clock times.")
			.addToggle((t) => t.setValue(s.showClocks).onChange(async (v) => { s.showClocks = v; await save(); }));

		/* Dashboard --------------------------------------------------- */
		new Setting(containerEl).setName("Dashboard").setHeading();
		new Setting(containerEl)
			.setName("Default period")
			.addDropdown((d) => d.addOptions({ "30d": "Last 30 days", "3m": "Last 3 months", "12m": "Last 12 months", all: "All games" })
				.setValue(s.dashboardPeriod).onChange(async (v) => { s.dashboardPeriod = v as ChessJournalSettings["dashboardPeriod"]; await save(); }));
		new Setting(containerEl)
			.setName("Chart colours")
			.setDesc("Semantic: neutral series, green for better and red for worse. Vault accent and Soft follow your theme's accent colour.")
			.addDropdown((d) => d.addOptions({ semantic: "Semantic", accent: "Vault accent", soft: "Soft" })
				.setValue(s.dashboardPalette).onChange(async (v) => { s.dashboardPalette = v as ChessJournalSettings["dashboardPalette"]; await save(); }));
		new Setting(containerEl)
			.setName("Games needed for a percentage")
			.setDesc("Figures based on fewer games are shown as “–”.")
			.addSlider((sl) => sl.setLimits(1, 20, 1).setValue(s.dashboardMinGames).setDynamicTooltip()
				.onChange(async (v) => { s.dashboardMinGames = v; await save(); }));
	}
}

/** Look the user up on Lichess and summarise their ratings, e.g. "Found gurethem · Blitz 1890 · Rapid 2010". */
async function checkLichessUser(username: string): Promise<{ ok: boolean; text: string }> {
	if (!username) return { ok: false, text: "Enter a username first." };
	try {
		const res = await obsidianHttp({ url: `${LICHESS_HOST}/api/user/${encodeURIComponent(username)}`, headers: { Accept: "application/json" } });
		if (res.status === 404) return { ok: false, text: `No Lichess account called “${username}”.` };
		if (res.status !== 200) return { ok: false, text: `Lichess returned HTTP ${res.status}. Try again later.` };
		const body = JSON.parse(res.text) as { username?: string; disabled?: boolean };
		if (body.disabled) return { ok: false, text: `The Lichess account “${username}” is closed.` };
		const ratings = parseLichessUser(res.text);
		const parts = TIME_CLASSES.filter((c) => ratings[c]).map((c) => `${SPEED_LABEL[c]} ${ratings[c]?.rating}${ratings[c]?.provisional ? "?" : ""}`);
		return { ok: true, text: [`Found ${body.username ?? username}`, ...parts].join(" · ") };
	} catch {
		return { ok: false, text: "Could not reach Lichess. Check your connection." };
	}
}
