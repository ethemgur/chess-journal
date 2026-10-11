/** Analysis cache: one JSON file per game at <plugin folder>/analysis/<game-key>.json. */
import type { GameAnalysis } from "./types";

export interface CacheStorage {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

/** Keys contain ":" which is not allowed in Windows file names. */
export const cacheFileName = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_") + ".json";

export class AnalysisCache {
	private mem = new Map<string, GameAnalysis | null>();
	private listeners = new Set<(key: string) => void>();

	constructor(private storage: CacheStorage, private dir: string) {}

	private path(key: string) {
		return `${this.dir}/analysis/${cacheFileName(key)}`;
	}

	async get(key: string): Promise<GameAnalysis | undefined> {
		if (this.mem.has(key)) return this.mem.get(key) ?? undefined;
		const p = this.path(key);
		let a: GameAnalysis | null = null;
		try {
			if (await this.storage.exists(p)) a = JSON.parse(await this.storage.read(p)) as GameAnalysis;
		} catch {
			a = null;
		}
		this.mem.set(key, a);
		return a ?? undefined;
	}

	async set(a: GameAnalysis): Promise<void> {
		const dir = `${this.dir}/analysis`;
		if (!(await this.storage.exists(dir))) await this.storage.mkdir(dir);
		await this.storage.write(this.path(a.key), JSON.stringify(a));
		this.mem.set(a.key, a);
		for (const l of this.listeners) l(a.key);
	}

	async remove(key: string): Promise<void> {
		const p = this.path(key);
		if (await this.storage.exists(p)) await this.storage.remove(p);
		this.mem.delete(key);
	}

	onChange(fn: (key: string) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
}
