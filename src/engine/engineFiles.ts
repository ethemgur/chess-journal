/**
 * Stockfish 18 lite single-threaded WASM: downloaded on first use from the
 * plugin's own GitHub release, verified by SHA-256, stored in the plugin folder.
 */
import { requestUrl } from "obsidian";

export const ENGINE_RELEASE_BASE = "https://github.com/ethemgur/chess-journal/releases/download/engine-sf18";

export interface EngineFile {
	name: string;
	sha256: string;
	bytes: number;
}

/** Hashes of the files in the stockfish@18.0.8 npm package (bin/). */
export const ENGINE_FILES: EngineFile[] = [
	{
		name: "stockfish-18-lite-single.js",
		sha256: "5243fd9b276cab7dfe3ad1d43ab9ead73568fac76468c614242977a210c4a391",
		bytes: 21_429,
	},
	{
		name: "stockfish-18-lite-single.wasm",
		sha256: "a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1",
		bytes: 7_295_411,
	},
];

export const ENGINE_TOTAL_MB = (ENGINE_FILES.reduce((n, f) => n + f.bytes, 0) / 1_000_000).toFixed(1);

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const h = await crypto.subtle.digest("SHA-256", buf);
	return Array.from(new Uint8Array(h))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export class HashMismatchError extends Error {}

/** Throws HashMismatchError if the bytes do not match the expected hash. */
export async function verify(file: EngineFile, buf: ArrayBuffer): Promise<void> {
	const got = await sha256Hex(buf);
	if (got !== file.sha256) {
		throw new HashMismatchError(`${file.name}: SHA-256 mismatch (expected ${file.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…). The file was not saved.`);
	}
}

export interface EngineStorage {
	exists(path: string): Promise<boolean>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	mkdir(path: string): Promise<void>;
}

export class EngineFiles {
	constructor(private storage: EngineStorage, private dir: string) {}

	path(f: EngineFile): string {
		return `${this.dir}/engine/${f.name}`;
	}

	async installed(): Promise<boolean> {
		for (const f of ENGINE_FILES) if (!(await this.storage.exists(this.path(f)))) return false;
		return true;
	}

	async download(onProgress?: (msg: string) => void): Promise<void> {
		if (!(await this.storage.exists(`${this.dir}/engine`))) await this.storage.mkdir(`${this.dir}/engine`);
		const bufs: ArrayBuffer[] = [];
		// Download and verify everything before saving anything.
		for (const f of ENGINE_FILES) {
			onProgress?.(`Downloading ${f.name} (${(f.bytes / 1_000_000).toFixed(1)} MB)…`);
			const res = await requestUrl({ url: `${ENGINE_RELEASE_BASE}/${f.name}`, throw: false });
			if (res.status !== 200) throw new Error(`Download of ${f.name} failed (HTTP ${res.status}).`);
			await verify(f, res.arrayBuffer);
			bufs.push(res.arrayBuffer);
		}
		for (let i = 0; i < ENGINE_FILES.length; i++) await this.storage.writeBinary(this.path(ENGINE_FILES[i]), bufs[i]);
	}

	/** Read and re-verify the installed files (guards against a corrupted or tampered copy). */
	async load(): Promise<{ js: ArrayBuffer; wasm: ArrayBuffer }> {
		const [jsFile, wasmFile] = ENGINE_FILES;
		const js = await this.storage.readBinary(this.path(jsFile));
		const wasm = await this.storage.readBinary(this.path(wasmFile));
		await verify(jsFile, js);
		await verify(wasmFile, wasm);
		return { js, wasm };
	}
}
