import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";

import { main, resources } from "../package.json";

export const devPath = normalize(dirname(main)).split(/\/|\\/g)[0];

function copyDir({ src, dest }: { src: string; dest: string }): void {
	if (!existsSync(src)) return;

	if (existsSync(dest)) {
		rmSync(dest, { recursive: true });
	}
	mkdirSync(dest, { recursive: true });
	cpSync(src, dest, { recursive: true });
}

export function defineEnv(
	value: string | undefined,
	fallback?: string,
): string {
	return JSON.stringify(value || fallback);
}

const RESOURCES_TO_COPY = [
	{
		src: resolve(__dirname, "..", resources, "sounds"),
		dest: resolve(__dirname, "..", devPath, "resources/sounds"),
	},
	{
		src: resolve(__dirname, "..", resources, "tray"),
		dest: resolve(__dirname, "..", devPath, "resources/tray"),
	},
	{
		src: resolve(__dirname, "..", resources, "browser-extension"),
		dest: resolve(__dirname, "..", devPath, "resources/browser-extension"),
	},
	{
		src: resolve(__dirname, "../../../packages/local-db/drizzle"),
		dest: resolve(__dirname, "..", devPath, "resources/migrations"),
	},
	{
		src: resolve(__dirname, "../../../packages/host-service/drizzle"),
		dest: resolve(__dirname, "..", devPath, "resources/host-migrations"),
	},
	{
		src: resolve(__dirname, "../../../packages/chat-runtime/src/db/drizzle"),
		dest: resolve(__dirname, "..", devPath, "resources/chat-migrations"),
	},
	{
		src: resolve(__dirname, "../../../packages/agent-setup/templates"),
		dest: resolve(__dirname, "..", devPath, "main/templates"),
	},
];

/**
 * Copies resources to dist/ for preview/production mode.
 * In preview mode, __dirname resolves relative to dist/main, so resources
 * need to be copied there for the main process to access them.
 */
export function copyResourcesPlugin(): Plugin {
	return {
		name: "copy-resources",
		writeBundle() {
			for (const resource of RESOURCES_TO_COPY) {
				copyDir(resource);
			}
		},
	};
}

/**
 * Strips the `crossorigin` attribute that Vite adds to script/link tags.
 * Electron's ASAR file:// handler doesn't support CORS on Windows,
 * so crossorigin causes scripts/styles to silently fail to load (black screen).
 */
export function stripCrossOriginPlugin(): Plugin {
  return {
    name: "strip-crossorigin",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (process.platform !== "win32") return html;
        return html.replace(/ crossorigin(?:="[^"]*")?/g, "");
      },
    },
  };
}

/**
 * Injects environment variables into index.html CSP.
 */
// The renderer gets the Lingui macro through @vitejs/plugin-react's babel
// option; the main process has no babel step, so run the macro directly.
export function linguiMacroPlugin(): Plugin {
	return {
		name: "lingui-macro",
		enforce: "pre",
		async transform(code, id) {
			if (!/\.tsx?$/.test(id) || id.includes("/node_modules/")) return null;
			if (!code.includes("@lingui/core/macro")) return null;
			const result = await transformAsync(code, {
				filename: id,
				babelrc: false,
				configFile: false,
				sourceMaps: true,
				parserOpts: { plugins: ["typescript"] },
				plugins: ["@lingui/babel-plugin-lingui-macro"],
			});
			return result?.code ? { code: result.code, map: result.map } : null;
		},
	};
}

export function htmlEnvTransformPlugin(): Plugin {
	return {
		name: "html-env-transform",
		transformIndexHtml(html) {
			return html
				.replace(
					/%NEXT_PUBLIC_API_URL%/g,
					process.env.NEXT_PUBLIC_API_URL || "https://api.cloud-severed.invalid",
				)
				.replace(
					/%NEXT_PUBLIC_STREAMS_URL%/g,
					process.env.NEXT_PUBLIC_STREAMS_URL || "https://streams.cloud-severed.invalid",
				)
				.replace(
					/%RELAY_URL%/g,
					process.env.RELAY_URL || "https://relay.cloud-severed.invalid",
				);
		},
	};
}
