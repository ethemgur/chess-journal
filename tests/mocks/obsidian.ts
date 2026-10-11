// Minimal stand-in for the Obsidian API so pure modules can be unit tested.
export const Platform = { isMobile: false, isDesktop: true };
export class Notice { constructor(public message: string) {} setMessage() { return this; } hide() {} }
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class FuzzySuggestModal {}
export class Plugin {}
export class MarkdownRenderChild {}
export class TFile {}
export class TFolder {}
export class Menu {}
export async function requestUrl(): Promise<never> { throw new Error("requestUrl is not available in tests"); }
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export function parseYaml(): unknown { return {}; }
export function stringifyYaml(o: unknown): string { return JSON.stringify(o); }
