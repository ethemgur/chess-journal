import { requestUrl } from "obsidian";

export interface HttpRequest {
	url: string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	text: string;
	headers: Record<string, string>;
}

/** All network access goes through this, backed by Obsidian's requestUrl (never fetch). */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const obsidianHttp: Http = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method ?? "GET", headers: req.headers, body: req.body, throw: false });
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
	let text = "";
	try {
		text = res.text;
	} catch {
		text = "";
	}
	return { status: res.status, text, headers };
};

export class RateLimitedError extends Error {
	constructor(public site: string) {
		super(`${site} refused too many requests`);
	}
}

export class HttpError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}
