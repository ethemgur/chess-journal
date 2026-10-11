module.exports = {
	root: true,
	parser: "@typescript-eslint/parser",
	env: { node: false, browser: true },
	plugins: ["@typescript-eslint"],
	extends: [
		"eslint:recommended",
		"plugin:@typescript-eslint/eslint-recommended",
		"plugin:@typescript-eslint/recommended",
	],
	parserOptions: { sourceType: "module" },
	rules: {
		"no-unused-vars": "off",
		"@typescript-eslint/no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }],
		"@typescript-eslint/ban-ts-comment": "off",
		"no-prototype-builtins": "off",
		"@typescript-eslint/no-empty-function": "off",
		// Compliance: never build DOM from untrusted strings.
		"no-restricted-properties": [
			"error",
			{ property: "innerHTML", message: "Use createEl/setText instead." },
			{ property: "outerHTML", message: "Use createEl/setText instead." },
		],
		"no-restricted-globals": ["error", { name: "fetch", message: "Use Obsidian requestUrl." }],
	},
};
