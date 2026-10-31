/** Live Lichess ratings, cached in memory. */
import type { TimeClass } from "../types";
import type { Http } from "../sources/http";
import { LICHESS_HOST } from "../sources/lichess";

export interface LiveRating {
	rating: number;
	games?: number;
	provisional?: boolean;
	asOf?: number; // ms
}

export type LiveRatings = Partial<Record<TimeClass, LiveRating>>;

export const LICHESS_TTL_MS = 5 * 60_000;

const LICHESS_PERFS: Record<string, TimeClass> = { bullet: "bullet", blitz: "blitz", rapid: "rapid", classical: "classical", correspondence: "daily" };

export function parseLichessUser(body: string): LiveRatings {
	const j = JSON.parse(body) as { perfs?: Record<string, { rating?: number; games?: number; prov?: boolean }> };
	const out: LiveRatings = {};
	for (const [perf, tc] of Object.entries(LICHESS_PERFS)) {
		const p = j.perfs?.[perf];
		if (p?.rating !== undefined) out[tc] = { rating: p.rating, games: p.games, provisional: !!p.prov };
	}
	return out;
}

export class RatingsCache {
	private cache = new Map<string, { at: number; value: LiveRatings }>();
	private inflight = new Map<string, Promise<LiveRatings | undefined>>();

	constructor(private http: Http, private now: () => number = () => Date.now()) {}

	private async cached(id: string, ttl: number, load: () => Promise<LiveRatings>): Promise<LiveRatings | undefined> {
		const hit = this.cache.get(id);
		if (hit && this.now() - hit.at < ttl) return hit.value;
		const running = this.inflight.get(id);
		if (running) return running;
		const p = (async () => {
			try {
				const value = await load();
				this.cache.set(id, { at: this.now(), value });
				return value;
			} catch {
				return hit?.value; // offline or refused: keep the last known value, if any
			} finally {
				this.inflight.delete(id);
			}
		})();
		this.inflight.set(id, p);
		return p;
	}

	lichess(username: string): Promise<LiveRatings | undefined> {
		if (!username) return Promise.resolve(undefined);
		return this.cached(`lichess:${username.toLowerCase()}`, LICHESS_TTL_MS, async () => {
			const res = await this.http({ url: `${LICHESS_HOST}/api/user/${encodeURIComponent(username)}`, headers: { Accept: "application/json" } });
			if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
			return parseLichessUser(res.text);
		});
	}
}
