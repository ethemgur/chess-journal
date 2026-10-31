/**
 * Incremental Lichess sync: fetch month windows one request at a time, normalise,
 * filter, and hand each game to the note sink. Safe to re-run: the sink decides
 * whether a known game changed, and the cursor only moves after a window succeeds.
 * Games still awaiting Lichess analysis are fetched again by ID on every sync,
 * so their notes fill in once they have been analysed on lichess.org.
 */
import type { GameRecord, TimeClass } from "../types";
import { Http, RateLimitedError } from "../sources/http";
import { LICHESS_IDS_PER_REQUEST, fetchLichessByIds, fetchLichessWindow, monthWindows } from "../sources/lichess";
import { Normalised, normaliseLichess } from "../sources/normalise";

export type UpsertResult = "created" | "updated" | "unchanged" | "deleted";

export interface NoteSink {
	upsert(record: GameRecord): Promise<UpsertResult>;
}

export interface SyncState {
	/** Per Lichess username: newest game seen, and the filters it was seen with. */
	lichess: Record<string, { cursor?: number; filters?: string }>;
}

export const emptySyncState = (): SyncState => ({ lichess: {} });

export interface SyncSummary {
	created: number;
	updated: number;
	unchanged: number;
	skippedVariant: number;
	skippedFilter: number;
	skippedDeleted: number;
	failed: number;
	/** Games imported or re-checked that Lichess has not analysed yet. */
	awaiting: number;
	notes: string[];
	aborted?: string;
	cancelled?: boolean;
}

export const emptySummary = (): SyncSummary => ({
	created: 0,
	updated: 0,
	unchanged: 0,
	skippedVariant: 0,
	skippedFilter: 0,
	skippedDeleted: 0,
	failed: 0,
	awaiting: 0,
	notes: [],
});

export interface SyncOptions {
	lichessUsername: string;
	lichessToken: string;
	timeClasses: TimeClass[];
	ratedOnly: boolean;
	importSince: string; // YYYY-MM-DD
}

export interface SyncDeps {
	http: Http;
	sink: NoteSink;
	state: SyncState;
	saveState: () => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	progress: (message: string) => void;
	isCancelled: () => boolean;
	onCreated?: (record: GameRecord) => void;
	/** Lichess game IDs whose notes still await Lichess analysis. */
	awaitingIds?: () => string[];
}

export const RATE_LIMIT_WAIT_MS = 60_000;
/** Bump when the notes gain keys from Lichess's data, so the next sync re-reads every game once. */
export const SYNC_DATA_VERSION = 2;
/** Daily games can start long before they finish; re-check this far back when daily games are synced. */
export const DAILY_LOOKBACK_MS = 60 * 86_400_000;

class AbortRun extends Error {}

export class SyncEngine {
	constructor(private opts: SyncOptions, private deps: SyncDeps) {}

	/** Run fn; on a 429 wait a full minute and retry once, then abort the run. */
	private async withRateLimit<T>(site: string, fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (e) {
			if (!(e instanceof RateLimitedError)) throw e;
			this.deps.progress(`${site} asked us to slow down; waiting 60 s…`);
			await this.deps.sleep(RATE_LIMIT_WAIT_MS);
			try {
				return await fn();
			} catch (e2) {
				if (e2 instanceof RateLimitedError) {
					throw new AbortRun(`${site} refused too many requests; try again in a minute.`);
				}
				throw e2;
			}
		}
	}

	private passesFilter(r: GameRecord): boolean {
		if (r.timeClass && !this.opts.timeClasses.includes(r.timeClass)) return false;
		if (this.opts.ratedOnly && r.rated === false) return false;
		if (r.playedAt && r.playedAt.slice(0, 10) < this.opts.importSince) return false;
		return true;
	}

	private async handle(n: Normalised, summary: SyncSummary): Promise<void> {
		if (!n.ok) {
			if (n.reason === "variant") summary.skippedVariant++;
			else if (n.reason === "filter") summary.skippedFilter++;
			else summary.failed++;
			return;
		}
		if (!this.passesFilter(n.record)) {
			summary.skippedFilter++;
			return;
		}
		const r = await this.deps.sink.upsert(n.record);
		if (r !== "deleted" && n.record.siteAnalysis === "awaiting") summary.awaiting++;
		if (r === "created") {
			summary.created++;
			this.deps.onCreated?.(n.record);
		} else if (r === "updated") summary.updated++;
		else if (r === "deleted") summary.skippedDeleted++;
		else summary.unchanged++;
	}

	async syncLichess(summary: SyncSummary = emptySummary()): Promise<SyncSummary> {
		const user = this.opts.lichessUsername;
		if (!user) return summary;
		const key = user.toLowerCase();
		const st = (this.deps.state.lichess[key] ??= {});
		// Changing which games are wanted (speeds, rated, start date) starts again from the start date.
		const filters = JSON.stringify([[...this.opts.timeClasses].sort(), this.opts.ratedOnly, this.opts.importSince, SYNC_DATA_VERSION]);
		if (st.filters !== filters) {
			st.cursor = undefined;
			st.filters = filters;
		}
		const seen = new Set<string>();
		const sinceDate = Date.parse(`${this.opts.importSince}T00:00:00Z`);
		let from = st.cursor !== undefined ? st.cursor + 1 : sinceDate;
		if (st.cursor !== undefined && this.opts.timeClasses.includes("daily")) {
			from = Math.max(sinceDate, from - DAILY_LOOKBACK_MS);
		}
		const windows = monthWindows(from, this.deps.now());
		let cursorFrozen = false;
		try {
			for (const w of windows) {
				if (this.deps.isCancelled()) {
					summary.cancelled = true;
					break;
				}
				const label = new Date(w.since).toLocaleString("en", { month: "short", year: "numeric", timeZone: "UTC" });
				this.deps.progress(`Syncing Lichess: ${label}, ${summary.created} new`);
				let games;
				try {
					games = await this.withRateLimit("Lichess", () =>
						fetchLichessWindow(this.deps.http, {
							username: user,
							token: this.opts.lichessToken || undefined,
							since: w.since,
							until: w.until,
							timeClasses: this.opts.timeClasses,
							ratedOnly: this.opts.ratedOnly,
						}),
					);
				} catch (e) {
					if (e instanceof AbortRun) throw e;
					// Network or parse failure: skip this window, keep its cursor so the next sync retries it.
					summary.failed++;
					summary.notes.push(`Lichess ${label}: ${(e as Error).message}`);
					cursorFrozen = true;
					continue;
				}
				let newest = st.cursor ?? 0;
				for (const g of games) {
					seen.add(g.id);
					try {
						await this.handle(normaliseLichess(g, user), summary);
						newest = Math.max(newest, g.createdAt);
					} catch (e) {
						summary.failed++;
						summary.notes.push(`Lichess game ${g.id}: ${(e as Error).message}`);
						cursorFrozen = true;
					}
				}
				if (!cursorFrozen && newest > (st.cursor ?? 0)) {
					st.cursor = newest;
					await this.deps.saveState();
				}
			}
			if (!summary.cancelled) await this.recheckAwaiting(user, seen, summary);
		} catch (e) {
			if (e instanceof AbortRun) summary.aborted = e.message;
			else throw e;
		}
		return summary;
	}

	/** Fetch games still awaiting Lichess analysis by ID, so their notes fill in once analysed. */
	private async recheckAwaiting(user: string, seen: Set<string>, summary: SyncSummary): Promise<void> {
		const ids = (this.deps.awaitingIds?.() ?? []).filter((id) => !seen.has(id));
		for (let i = 0; i < ids.length; i += LICHESS_IDS_PER_REQUEST) {
			if (this.deps.isCancelled()) {
				summary.cancelled = true;
				return;
			}
			const batch = ids.slice(i, i + LICHESS_IDS_PER_REQUEST);
			this.deps.progress(`Checking Lichess for new analyses: ${Math.min(i + batch.length, ids.length)} / ${ids.length}`);
			let games;
			try {
				games = await this.withRateLimit("Lichess", () => fetchLichessByIds(this.deps.http, batch, this.opts.lichessToken || undefined));
			} catch (e) {
				if (e instanceof AbortRun) throw e;
				summary.failed++;
				summary.notes.push(`Lichess analysis check: ${(e as Error).message}`);
				continue;
			}
			for (const g of games) {
				try {
					await this.handle(normaliseLichess(g, user), summary);
				} catch (e) {
					summary.failed++;
					summary.notes.push(`Lichess game ${g.id}: ${(e as Error).message}`);
				}
			}
		}
	}
}

export function formatSummary(s: SyncSummary): string {
	const parts = [`${s.created} new`, `${s.updated} updated`];
	const skipped = s.skippedVariant + s.skippedFilter + s.skippedDeleted;
	if (skipped) {
		const why = [
			s.skippedVariant && `${s.skippedVariant} variant`,
			s.skippedFilter && `${s.skippedFilter} filtered`,
			s.skippedDeleted && `${s.skippedDeleted} deleted by you`,
		].filter(Boolean);
		parts.push(`${skipped} skipped (${why.join(", ")})`);
	}
	if (s.failed) parts.push(`${s.failed} failed`);
	if (s.awaiting) parts.push(`${s.awaiting} awaiting Lichess analysis`);
	let msg = parts.join(", ") + ".";
	if (s.cancelled) msg = "Cancelled. " + msg;
	if (s.aborted) msg = s.aborted + " " + msg;
	return msg;
}
