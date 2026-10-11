/** Import of PGN files (OTB games): from a vault .pgn file or pasted text; multi-game files are split. */
import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import type { Colour, GameRecord } from "../types";
import { PgnParseError, splitPgnGames } from "../pgn/tree";
import { OtbDraft, draftOtb, normaliseOtb, setPgnTags } from "./normalise";
import type { UpsertResult } from "../sync/syncEngine";

export interface PgnImportSummary {
	created: number;
	unchanged: number;
	skipped: number;
	failed: string[];
}

export interface PgnImportHost {
	app: App;
	myNames(): string[];
	upsert(r: GameRecord): Promise<UpsertResult>;
	onCreated(r: GameRecord): void;
}

/** Choose a source, then import every game in it. */
export function openPgnImport(host: PgnImportHost): void {
	new PgnSourceModal(host.app, async (text) => {
		const s = await importPgnText(host, text);
		const parts = [`${s.created} new`, `${s.unchanged} already imported`];
		if (s.skipped) parts.push(`${s.skipped} skipped`);
		if (s.failed.length) parts.push(`${s.failed.length} failed`);
		new Notice(`PGN import: ${parts.join(", ")}.` + (s.failed.length ? `\n${s.failed.slice(0, 3).join("\n")}` : ""), 8000);
	}).open();
}

export async function importPgnText(host: PgnImportHost, text: string): Promise<PgnImportSummary> {
	const summary: PgnImportSummary = { created: 0, unchanged: 0, skipped: 0, failed: [] };
	const games = splitPgnGames(text);
	for (let i = 0; i < games.length; i++) {
		let draft: OtbDraft;
		try {
			draft = draftOtb(games[i], host.myNames());
		} catch (e) {
			summary.failed.push(`Game ${i + 1}: ${e instanceof PgnParseError ? e.message : (e as Error).message}`);
			continue;
		}
		const missing = ["Event", "Round", "Date"].filter((t) => {
			const v = draft.tags.get(t);
			return !v || v.includes("?");
		});
		let pgn = draft.pgn;
		let colour = draft.myColour;
		if (!colour || missing.length) {
			const answer = await new OtbDetailsModal(host.app, draft, i + 1, games.length, missing).ask();
			if (!answer) {
				summary.skipped++;
				continue;
			}
			colour = answer.colour;
			pgn = setPgnTags(pgn, answer.tags);
		}
		try {
			const n = await normaliseOtb(pgn, colour);
			if (!n.ok) {
				summary.skipped++;
				if (n.reason === "unfinished") summary.failed.push(`Game ${i + 1}: no final result, not imported.`);
				continue;
			}
			const r = await host.upsert(n.record);
			if (r === "created") {
				summary.created++;
				host.onCreated(n.record);
			} else if (r === "deleted") summary.skipped++;
			else summary.unchanged++;
		} catch (e) {
			summary.failed.push(`Game ${i + 1}: ${(e as Error).message}`);
		}
	}
	return summary;
}

class PgnSourceModal extends Modal {
	constructor(app: App, private onText: (text: string) => Promise<void>) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Import PGN");
		const { contentEl } = this;
		new Setting(contentEl)
			.setName("From a .pgn file in the vault")
			.addButton((b) => b.setButtonText("Choose file").onClick(() => {
				new PgnFileSuggest(this.app, async (f) => {
					this.close();
					await this.onText(await this.app.vault.read(f));
				}).open();
			}));
		contentEl.createEl("p", { text: "Or paste PGN text (one or more games):" });
		const ta = contentEl.createEl("textarea", { cls: "cr-pgn-input" });
		ta.rows = 10;
		new Setting(contentEl).addButton((b) => b.setButtonText("Import").setCta().onClick(async () => {
			const text = ta.value;
			if (!text.trim()) return;
			this.close();
			await this.onText(text);
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class PgnFileSuggest extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder("Choose a .pgn file");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pgn");
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

interface OtbAnswer {
	colour: Colour;
	tags: Record<string, string>;
}

/** Ask for my colour (when no name matches) and fill missing Event/Round/Date tags. */
class OtbDetailsModal extends Modal {
	private resolve?: (a: OtbAnswer | undefined) => void;
	private answered = false;

	constructor(app: App, private draft: OtbDraft, private n: number, private total: number, private missing: string[]) {
		super(app);
	}

	ask(): Promise<OtbAnswer | undefined> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		const t = this.draft.tags;
		this.titleEl.setText(`Game ${this.n} of ${this.total}`);
		contentEl.createEl("p", { text: `${t.get("White") ?? "?"} – ${t.get("Black") ?? "?"} · ${t.get("Result") ?? "*"}` });
		let colour: Colour | undefined = this.draft.myColour;
		if (!colour) {
			new Setting(contentEl)
				.setName("Which side were you?")
				.setDesc("Neither player matches “My OTB names” in the settings.")
				.addDropdown((d) => {
					d.addOptions({ "": "Choose…", white: `White (${t.get("White") ?? "?"})`, black: `Black (${t.get("Black") ?? "?"})` });
					d.onChange((v) => (colour = v === "white" || v === "black" ? v : undefined));
				});
		}
		const tags: Record<string, string> = {};
		for (const tag of this.missing) {
			new Setting(contentEl)
				.setName(tag)
				.setDesc(tag === "Date" ? "YYYY.MM.DD (unknown parts as ??)" : "Leave empty to keep “?”.")
				.addText((x) => x.setPlaceholder(tag === "Date" ? "2026.04.02" : "?").onChange((v) => (tags[tag] = v.trim())));
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Import").setCta().onClick(() => {
				if (!colour) {
					new Notice("Choose your colour first.");
					return;
				}
				const filled: Record<string, string> = {};
				for (const [k, v] of Object.entries(tags)) {
					if (!v) continue;
					if (k === "Date" && !/^[\d?]{4}\.[\d?]{2}\.[\d?]{2}$/.test(v)) {
						new Notice("Date must look like 2026.04.02.");
						return;
					}
					filled[k] = v;
				}
				this.finish({ colour, tags: filled });
			}))
			.addButton((b) => b.setButtonText("Skip this game").onClick(() => this.finish(undefined)));
	}

	private finish(a: OtbAnswer | undefined): void {
		this.answered = true;
		this.resolve?.(a);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve?.(undefined);
	}
}
