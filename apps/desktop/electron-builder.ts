/**
 * Electron Builder Configuration
 * @see https://www.electron.build/configuration/configuration
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
import pkg from "./package.json";
import {
	packagedAsarUnpackGlobs,
	packagedNodeModuleCopies,
} from "./runtime-dependencies";

const currentYear = new Date().getFullYear();
const author = pkg.author?.name ?? pkg.author;
const productName = pkg.productName;
const disableWinSigning = process.env.SUPERSET_DISABLE_WIN_SIGNING === "1";
const macIconPath = join(pkg.resources, "build/icons/icon.icns");
const linuxIconPath = join(pkg.resources, "build/icons");
const winIconPath = join(pkg.resources, "build/icons/icon.ico");
const dmgBackgroundPath = join(
	pkg.resources,
	"build/installer/background.tiff",
);

const config: Configuration = {
	appId: "com.superset.desktop",
	productName,
	copyright: `Copyright © ${currentYear} — ${author}`,
	electronVersion: pkg.devDependencies.electron.replace(/^\^/, ""),

	// Generate update manifests for all channels (latest.yml, canary.yml, etc.)
	// This enables proper channel-based auto-updates following electron-builder conventions
	generateUpdatesFilesForAllChannels: true,

	// (CLOUD-SEVERANCE-P1) No publish provider, so electron-builder bakes NO
	// app-update.yml into the package.
	//
	// Upstream published to owner `superset-sh` / repo `superset`, and even with
	// `--publish never` (which is how CI invokes electron-builder) that config is
	// still written into the packaged resources as app-update.yml — a file naming
	// upstream's repo as this build's update source. Chosen over repointing it at
	// khairm/superset-windows-arm64 because the updater is hard-disabled anyway
	// (FORK_AUTO_UPDATE_DISABLED): a manifest for an updater that never runs is
	// dead config that a future upstream change could re-arm. Our releases are
	// created by CI with `gh`, which never reads this block.
	publish: null,

	// Directories
	directories: {
		output: "release",
		buildResources: join(pkg.resources, "build"),
	},

	// ASAR configuration for native modules and external resources
	asar: true,
	asarUnpack: [
		...packagedAsarUnpackGlobs,
		// Sound files must be unpacked so external audio players (afplay, paplay, etc.) can access them
		"**/resources/sounds/**/*",
		// Tray icon must be unpacked so Electron Tray can load it
		"**/resources/tray/**/*",
	],

	// Extra resources placed outside asar archive (accessible via process.resourcesPath)
	extraResources: [
			{
				from: "node_modules/@anush008/tokenizers-win32-arm64-msvc",
				to: "node_modules/@anush008/tokenizers-win32-arm64-msvc",
				filter: ["**/*"],
			},
		// Database migrations - must be outside asar for drizzle-orm to read
		{
			from: "dist/resources/migrations",
			to: "resources/migrations",
			filter: ["**/*"],
		},
		{
			from: "dist/resources/host-migrations",
			to: "resources/host-migrations",
			filter: ["**/*"],
		},
		{
			from: "dist/resources/chat-migrations",
			to: "resources/chat-migrations",
			filter: ["**/*"],
		},
		{
			from: "dist/resources/bin",
			to: "resources/bin",
			filter: ["**/*"],
		},
		{
			from: join(pkg.resources, "build/icons"),
			to: "build/icons",
			filter: ["**/*"],
		},
	],

	files: [
		{
			filter: ["dist/**/*", "!dist/resources/migrations/**", "package.json"],
		},
		{
			from: pkg.resources,
			to: "resources",
			filter: ["**/*", "!build/**"],
		},
		// Runtime modules that stay external to the main bundle.
		// bun creates symlinks for direct deps in workspace node_modules.
		// The copy:native-modules script replaces symlinks with real files
		// before building (required for Bun 1.3+ isolated installs).
		...packagedNodeModuleCopies,
		"!**/.DS_Store",
		// (CLOUD-SEVERANCE-P1) @blaxel/core hardcodes ITS OWN Sentry DSN in
		// dist/{cjs,esm,cjs-browser,esm-browser}/common/settings.js, so shipping the
		// package bakes a live third-party crash-reporting endpoint into app.asar.
		//
		// It is a dependency of @superset/trpc, reachable only from the cloud-side
		// routers (lib/blaxel — sandbox provisioning), which run in the api deploy.
		// Every desktop/host-service import of @superset/trpc is `import type`, so
		// nothing in the packaged app ever require()s it: electron-builder only
		// copies it because it walks the workspace production dependency tree. A
		// negation string here is the exclusion channel electron-builder applies to
		// that walk (getNodeModuleFileMatcher collects only "!"-prefixed patterns).
		//
		// Scope-wide rather than @blaxel/core so a future sibling package can't
		// re-introduce the DSN. Drop this only if the desktop runtime ever gains a
		// real (non-type) import of @blaxel/*, and then sever the DSN some other way.
		"!**/node_modules/@blaxel/**",
	],

	// Rebuild native modules for Electron's Node.js version
	npmRebuild: process.platform !== "win32",

	// macOS DMG installer
	dmg: {
		...(existsSync(dmgBackgroundPath) ? { background: dmgBackgroundPath } : {}),
		// Explicit size — dmgbuild's auto-calc under-allocates and silently truncates
		// the last large file above ~1.7GB of contents. `shrink: true` (default) keeps
		// the final artifact compact.
		size: "4g",
	},

	// macOS
	mac: {
		...(existsSync(macIconPath) ? { icon: macIconPath } : {}),
		category: "public.app-category.utilities",
		target: "default",
		hardenedRuntime: true,
		gatekeeperAssess: false,
		notarize: true,
		entitlements: join(pkg.resources, "build/entitlements.mac.plist"),
		entitlementsInherit: join(
			pkg.resources,
			"build/entitlements.mac.inherit.plist",
		),
		extendInfo: {
			CFBundleName: productName,
			CFBundleDisplayName: productName,
			// Required for macOS microphone permission prompt
			NSMicrophoneUsageDescription:
				"Superset needs microphone access so voice-enabled tools like Codex transcription can capture audio input.",
			// Required for macOS local network permission prompt
			NSLocalNetworkUsageDescription:
				"Superset needs access to your local network to discover and connect to development servers running on your network.",
			// Bonjour service types to browse for (triggers the permission prompt)
			NSBonjourServices: ["_http._tcp", "_https._tcp"],
			// Required for Apple Events / Automation permission prompt
			NSAppleEventsUsageDescription:
				"Superset needs to interact with other applications to run terminal commands and development tools.",
		},
	},

	// Deep linking protocol
	protocols: {
		name: productName,
		schemes: ["superset"],
	},

	// Linux
	linux: {
		...(existsSync(linuxIconPath) ? { icon: linuxIconPath } : {}),
		category: "Utility",
		synopsis: pkg.description,
		target: ["AppImage"],
		artifactName: `superset-\${version}-\${arch}.\${ext}`,
		// GNOME's app menus only show their heuristic "New Window" item
		// intermittently for running apps; an explicit desktop action (the
		// Chrome/VS Code approach) is always shown. The action relaunches with
		// --new-window, which the second-instance handler answers by opening a
		// window; a plain relaunch focuses the running app.
		desktop: {
			// electron-builder appends [Desktop Action] groups but never writes
			// the Actions= key that exposes them, so declare it explicitly —
			// launchers ignore action groups not listed under Actions.
			entry: {
				Actions: "new-window;",
			},
			desktopActions: {
				"new-window": {
					Name: "New Window",
					// Args must stay in sync with linux.executableArgs (the
					// AppImage default is --no-sandbox when unset); %U is
					// intentionally omitted. --new-window is what the
					// second-instance handler keys on to open a window instead
					// of focusing the running app.
					Exec: "AppRun --no-sandbox --new-window",
				},
			},
		},
	},

	// Windows
	win: {
		...(existsSync(winIconPath) ? { icon: winIconPath } : {}),
		target: [
			{
				target: "nsis",
				arch: ["arm64"],
			},
		],
		artifactName: `${productName}-${pkg.version}-\${arch}.\${ext}`,
		asarUnpack: ["**/node_modules/@lydell/node-pty-win32-arm64/**/*"],
		files: [
			{
				from: "node_modules/@lydell/node-pty-win32-arm64",
				to: "node_modules/@lydell/node-pty-win32-arm64",
				filter: ["**/*"],
			},
		],
	},

	// NSIS installer (Windows)
	nsis: {
		oneClick: true,
		allowToChangeInstallationDirectory: false,
		createDesktopShortcut: true,
		createStartMenuShortcut: true,
		shortcutName: productName,
		installerIcon: join(pkg.resources, "build/icons/icon.ico"),
		uninstallerIcon: join(pkg.resources, "build/icons/icon.ico"),
	},
};

export default config;
