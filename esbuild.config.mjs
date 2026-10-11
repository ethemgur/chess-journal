import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { readFileSync, writeFileSync } from "fs";

const prod = process.argv[2] === "production";

// styles.css = chessground base + bundled board/piece themes + our own styles.
function buildStyles() {
	const parts = [
		"node_modules/chessground/assets/chessground.base.css",
		"node_modules/chessground/assets/chessground.brown.css",
		"node_modules/chessground/assets/chessground.cburnett.css",
		"src/styles/plugin.css",
	];
	const css = parts
		.map((p) => `/* ${p.split("/").pop()} */\n` + readFileSync(p, "utf8"))
		.join("\n");
	writeFileSync("styles.css", css);
}

const stylesPlugin = {
	name: "styles",
	setup(build) {
		build.onStart(() => buildStyles());
	},
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	plugins: [stylesPlugin],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
