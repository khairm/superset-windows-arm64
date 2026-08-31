/**
 * Prepare native modules for electron-builder.
 *
 * With Bun 1.3+ isolated installs, node_modules contains symlinks to packages
 * stored in node_modules/.bun/. electron-builder cannot follow these symlinks
 * when creating asar archives.
 *
 * This script:
 * 1. Detects if native modules are symlinks
 * 2. Replaces symlinks with actual file copies
 * 3. electron-builder can then properly package and unpack them
 *
 * This is safe because bun install will recreate the symlinks on next install.
 */

import { execSync } from "node:child_process";
import {
	closeSync,
	cpSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { satisfies, valid, validRange } from "semver";
import { requiredMaterializedNodeModules } from "../runtime-dependencies";

// Target architecture for cross-compilation. When set, platform-specific
// packages for this arch are fetched from npm if not already present.
// Set via TARGET_ARCH env var (e.g., TARGET_ARCH=x64).
const TARGET_ARCH = process.env.TARGET_ARCH || process.arch;
const TARGET_PLATFORM = process.env.TARGET_PLATFORM || process.platform;

function getWorkspaceRootNodeModulesDir(nodeModulesDir: string): string {
	return join(nodeModulesDir, "..", "..", "..", "node_modules");
}

function getBunFlatNodeModulesDir(nodeModulesDir: string): string {
	return join(
		getWorkspaceRootNodeModulesDir(nodeModulesDir),
		".bun",
		"node_modules",
	);
}

function getBunStoreDir(nodeModulesDir: string): string {
	return join(getWorkspaceRootNodeModulesDir(nodeModulesDir), ".bun");
}

/** Bun appends `+<16 lowercase hex>` to a store entry it had to deduplicate. */
const BUN_STORE_DEDUPE_HASH = /^[0-9a-f]{16}$/;

/** Bun store entries spell a scoped package `@scope/name` as `@scope+name`. */
function toBunStoreKey(moduleName: string): string {
	return moduleName.replaceAll("/", "+");
}

function parseBunStoreEntryVersion(entryName: string, prefix: string): string {
	const suffix = entryName.slice(prefix.length);
	const dedupeSeparator = suffix.lastIndexOf("+");
	const version =
		dedupeSeparator !== -1 &&
		BUN_STORE_DEDUPE_HASH.test(suffix.slice(dedupeSeparator + 1))
			? suffix.slice(0, dedupeSeparator)
			: suffix;
	if (valid(version) !== version) {
		throw new Error(
			`Unparsable Bun store entry "${entryName}": expected <key>@<semver> or <key>@<semver>+<16 hex>`,
		);
	}
	return version;
}

function selectVersion(
	versions: readonly string[],
	moduleName: string,
	versionSpec: string,
): string | null {
	if (validRange(versionSpec) === null) {
		throw new Error(
			`Unparsable version spec "${versionSpec}" for ${moduleName}: expected an exact version or a semver range`,
		);
	}
	const satisfying = [
		...new Set(versions.filter((version) => satisfies(version, versionSpec))),
	];
	if (satisfying.length === 0) return null;
	if (satisfying.length > 1) {
		throw new Error(
			`Ambiguous Bun store versions for ${moduleName}@${versionSpec}: ${satisfying.join(", ")}. The store caches every version ever installed, so it cannot elect one; resolve the range from the lockfile (scripts/bun-locked-versions.sh) and pass an exact version`,
		);
	}
	return satisfying[0];
}

/**
 * Pick the Bun store entry holding `moduleName` at `versionSpec`.
 *
 * Entries are named `<key>@<semver>` or `<key>@<semver>+<16 hex dedupe>`. The
 * whole version is parsed rather than prefix-matched, so `2.5.1` never selects
 * `2.5.10`, a prerelease, or any other suffixed neighbour.
 *
 * `.bun` is a cache of every version any install ever wrote, not the installed
 * dependency graph, so several cached versions satisfying one range is an
 * unanswerable question here rather than a "take the highest" one. Lockfile-owned
 * selection lives in scripts/bun-locked-versions.sh.
 *
 * Returns null when no entry satisfies the spec. Throws when an entry under the
 * package's key is unparsable, when the spec is neither a version nor a range,
 * when a range has more than one satisfying version, or when two entries claim
 * the selected version (readdir order must never decide which native binary
 * ships).
 */
export function selectBunStoreEntry(
	entryNames: readonly string[],
	moduleName: string,
	versionSpec: string,
): string | null {
	const prefix = `${toBunStoreKey(moduleName)}@`;
	const candidates = entryNames
		.filter((entryName) => entryName.startsWith(prefix))
		.map((entryName) => ({
			entryName,
			version: parseBunStoreEntryVersion(entryName, prefix),
		}));

	const selectedVersion = selectVersion(
		candidates.map((candidate) => candidate.version),
		moduleName,
		versionSpec,
	);
	if (selectedVersion === null) return null;

	const matches = candidates.filter(
		(candidate) => candidate.version === selectedVersion,
	);
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous Bun store entries for ${moduleName}@${selectedVersion}: ${matches
				.map((match) => match.entryName)
				.join(", ")}`,
		);
	}
	return matches[0].entryName;
}

function findBunStoreFolderName(
	bunStoreDir: string,
	moduleName: string,
	versionSpec: string,
): string | null {
	if (!existsSync(bunStoreDir)) return null;
	return selectBunStoreEntry(readdirSync(bunStoreDir), moduleName, versionSpec);
}

function copyModuleIfSymlink(
	nodeModulesDir: string,
	moduleName: string,
	required: boolean,
): boolean {
	const modulePath = join(nodeModulesDir, moduleName);
	const bunFlatNodeModulesDir = getBunFlatNodeModulesDir(nodeModulesDir);
	const bunFlatModulePath = join(bunFlatNodeModulesDir, moduleName);

	if (!existsSync(modulePath)) {
		if (existsSync(bunFlatModulePath)) {
			console.log(`  ${moduleName}: materializing from Bun store index`);
			mkdirSync(dirname(modulePath), { recursive: true });
			cpSync(realpathSync(bunFlatModulePath), modulePath, { recursive: true });
			console.log(`    Copied to: ${modulePath}`);
			return true;
		}
		if (required) {
			console.error(`  [ERROR] ${moduleName} not found at ${modulePath}`);
			process.exit(1);
		}
		console.log(`  ${moduleName}: not found (skipping)`);
		return false;
	}

	const stats = lstatSync(modulePath);

	if (stats.isSymbolicLink()) {
		// Resolve symlink to get real path
		const realPath = realpathSync(modulePath);
		console.log(`  ${moduleName}: symlink -> replacing with real files`);
		console.log(`    Real path: ${realPath}`);

		// Remove the symlink
		// Windows uses junctions (directory-like) instead of symlinks;
		// rmSync needs { recursive: true } to remove them.
		if (process.platform === "win32") {
		  rmSync(modulePath, { recursive: true, force: true });
		} else {
		  rmSync(modulePath);
		}

		// Copy the actual files. dereference: true follows nested symlinks
		// (e.g., node_modules/node-addon-api junctions on Windows) and copies
		// their contents instead of the link itself, which avoids EPERM on
		// copyfile when the destination cannot create the same junction.
		cpSync(realPath, modulePath, { recursive: true, dereference: true });

		console.log(`    Copied to: ${modulePath}`);
	} else {
		console.log(`  ${moduleName}: already real directory (not a symlink)`);
	}

	return true;
}

function readInstalledModuleVersion(modulePath: string): string | null {
	const packageJsonPath = join(modulePath, "package.json");
	if (!existsSync(packageJsonPath)) return null;
	type PackageJson = { version?: string };
	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as PackageJson;
	return packageJson.version ?? null;
}

function copyModuleForVersionSpec(
	nodeModulesDir: string,
	moduleName: string,
	versionSpec: string,
	destPath: string,
	required: boolean,
): boolean {
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	const bunStoreFolderName = findBunStoreFolderName(
		bunStoreDir,
		moduleName,
		versionSpec,
	);
	const bunStoreSourcePath =
		bunStoreFolderName === null
			? null
			: join(bunStoreDir, bunStoreFolderName, "node_modules", moduleName);
	if (bunStoreSourcePath !== null && existsSync(bunStoreSourcePath)) {
		mkdirSync(dirname(destPath), { recursive: true });
		cpSync(bunStoreSourcePath, destPath, { recursive: true });
		console.log(`    Copied ${bunStoreFolderName} to: ${destPath}`);
		return true;
	}

	// A tarball URL needs one exact version, so a range that fell through the Bun
	// store lookup is unfetchable and never reaches npm. WHICH way it fell
	// through is the whole diagnosis: no cached version satisfies the range (the
	// install never resolved it) is a different repair from an elected entry
	// whose payload directory is not there (the payload was never extracted —
	// scripts/materialize-native-closure.sh owns that).
	if (valid(versionSpec) === null) {
		const cause =
			bunStoreSourcePath === null
				? "no Bun store entry satisfied the range"
				: `Bun store entry ${bunStoreFolderName} has no payload at ${bunStoreSourcePath}`;
		const reason = `${moduleName}@${versionSpec}: ${cause}, and a semver range has no npm tarball URL`;
		if (required) {
			console.error(`  [ERROR] ${reason}`);
			process.exit(1);
		}
		console.warn(`  ${reason}`);
		return false;
	}

	if (fetchNpmPackage(moduleName, versionSpec, destPath)) {
		return true;
	}

	if (required) {
		console.error(
			`  [ERROR] Failed to materialize ${moduleName}@${versionSpec} at ${destPath}`,
		);
		process.exit(1);
	}

	return false;
}

function copyDependencyForPackage(
	nodeModulesDir: string,
	parentModuleName: string,
	dependencyName: string,
	dependencyRange: string,
	required: boolean,
): void {
	const topLevelDependencyPath = join(nodeModulesDir, dependencyName);
	const topLevelVersion = readInstalledModuleVersion(topLevelDependencyPath);

	if (topLevelVersion && satisfies(topLevelVersion, dependencyRange)) {
		copyModuleIfSymlink(nodeModulesDir, dependencyName, required);
		return;
	}

	if (!topLevelVersion) {
		console.log(
			`  ${dependencyName}: top-level version missing; materializing ${dependencyRange} at the workspace root`,
		);
		copyModuleForVersionSpec(
			nodeModulesDir,
			dependencyName,
			dependencyRange,
			topLevelDependencyPath,
			required,
		);
		return;
	}

	const nestedDependencyPath = join(
		nodeModulesDir,
		parentModuleName,
		"node_modules",
		dependencyName,
	);
	const nestedVersion = readInstalledModuleVersion(nestedDependencyPath);
	if (nestedVersion && satisfies(nestedVersion, dependencyRange)) {
		const nestedStats = lstatSync(nestedDependencyPath);
		if (nestedStats.isSymbolicLink()) {
			const realPath = realpathSync(nestedDependencyPath);
			rmSync(nestedDependencyPath);
			cpSync(realPath, nestedDependencyPath, {
				recursive: true,
			});
		}
		return;
	}

	console.log(
		`  ${dependencyName}: top-level version ${topLevelVersion ?? "missing"} does not satisfy ${dependencyRange}; materializing nested copy for ${parentModuleName}`,
	);

	copyModuleForVersionSpec(
		nodeModulesDir,
		dependencyName,
		dependencyRange,
		nestedDependencyPath,
		required,
	);
}

/**
 * Fetch an npm package tarball and extract it to destPath.
 * Used when cross-compiling and the target platform package isn't in the Bun store.
 */
function fetchNpmPackage(
	packageName: string,
	version: string,
	destPath: string,
): boolean {
	// npm tarball URL: @scope/pkg/-/pkg-version.tgz (filename uses pkg name without scope)
	const barePackageName = packageName.includes("/")
		? packageName.split("/")[1]
		: packageName;
	const url = `https://registry.npmjs.org/${packageName}/-/${barePackageName}-${version}.tgz`;
	console.log(`  ${packageName}: fetching from npm (${version})`);
	try {
		mkdirSync(destPath, { recursive: true });
		execSync(
			`curl -sL "${url}" | tar xz -C "${destPath}" --strip-components=1`,
			{
				stdio: "pipe",
			},
		);
		console.log(`    Extracted to: ${destPath}`);
		return true;
	} catch (err) {
		console.error(
			`  [ERROR] Failed to fetch ${packageName}@${version}: ${err}`,
		);
		return false;
	}
}

function copyAstGrepPlatformPackages(nodeModulesDir: string): void {
	const astGrepNapiPath = join(nodeModulesDir, "@ast-grep", "napi");
	if (!existsSync(astGrepNapiPath)) return;

	const astGrepPkgJsonPath = join(astGrepNapiPath, "package.json");
	if (!existsSync(astGrepPkgJsonPath)) return;

	type AstGrepPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const astGrepPkg = JSON.parse(
		readFileSync(astGrepPkgJsonPath, "utf8"),
	) as AstGrepPackageJson;
	const optionalDeps = astGrepPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@ast-grep/napi-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	// Determine which platform package we need for the target arch
	const targetPlatformSuffix = `${TARGET_PLATFORM === "darwin" ? "darwin" : TARGET_PLATFORM === "win32" ? "win32" : "linux"}-${TARGET_ARCH}`;
	const targetPkg = platformPackages.find((pkg) =>
		pkg.name.includes(targetPlatformSuffix),
	);

	// Bun isolated installs keep package payloads in workspaceRoot/node_modules/.bun
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedTargetPackage = false;

	for (const platformPkg of platformPackages) {
		const isTargetPkg = targetPkg && platformPkg.name === targetPkg.name;
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			const copied = copyModuleIfSymlink(
				nodeModulesDir,
				platformPkg.name,
				false,
			);
			if (isTargetPkg && copied) resolvedTargetPackage = true;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (bunStoreFolderName) {
			const sourcePath = join(
				bunStoreDir,
				bunStoreFolderName,
				"node_modules",
				platformPkg.name,
			);
			if (existsSync(sourcePath)) {
				console.log(`  ${platformPkg.name}: copying from Bun store`);
				mkdirSync(dirname(destPath), { recursive: true });
				cpSync(sourcePath, destPath, { recursive: true });
				if (isTargetPkg) resolvedTargetPackage = true;
				continue;
			}
		}

		// If this is the target platform package and it's not in the Bun store,
		// fetch it from npm (cross-compilation scenario)
		if (isTargetPkg) {
			if (fetchNpmPackage(platformPkg.name, platformPkg.version, destPath)) {
				resolvedTargetPackage = true;
				continue;
			}
		}

		console.warn(
			`  ${platformPkg.name}: not found in Bun store or node_modules`,
		);
	}

	if (!resolvedTargetPackage) {
		console.error(
			`  [ERROR] Target platform package ${targetPkg?.name ?? `@ast-grep/napi-${targetPlatformSuffix}`} was not materialized`,
		);
		process.exit(1);
	}
}

function copyLibsqlDependencies(nodeModulesDir: string): void {
	const libsqlPath = join(nodeModulesDir, "libsql");
	const libsqlPkgJsonPath = join(libsqlPath, "package.json");
	if (!existsSync(libsqlPkgJsonPath)) return;

	type LibsqlPackageJson = {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	const libsqlPkg = JSON.parse(
		readFileSync(libsqlPkgJsonPath, "utf8"),
	) as LibsqlPackageJson;
	const deps = libsqlPkg.dependencies ?? {};
	const optionalDeps = libsqlPkg.optionalDependencies ?? {};

	console.log("\nPreparing libsql runtime dependencies...");
	for (const [dep, version] of Object.entries(deps)) {
		copyDependencyForPackage(nodeModulesDir, "libsql", dep, version, true);
	}

	// Copy whichever optional native platform packages Bun installed for this platform.
	for (const dep of Object.keys(optionalDeps)) {
		copyModuleIfSymlink(nodeModulesDir, dep, false);
	}

	// Some Bun installs place optional deps under .bun/node_modules/@scope.
	// Mirror discovered @libsql optional packages if present there.
	const bunFlatLibsqlScopePath = join(
		getBunFlatNodeModulesDir(nodeModulesDir),
		"@libsql",
	);
	if (existsSync(bunFlatLibsqlScopePath)) {
		for (const entry of readdirSync(bunFlatLibsqlScopePath)) {
			if (
				!entry.includes("darwin") &&
				!entry.includes("linux") &&
				!entry.includes("win32")
			) {
				continue;
			}
			copyModuleIfSymlink(nodeModulesDir, `@libsql/${entry}`, false);
		}
	}

	// Cross-compilation: ensure the target platform's @libsql package is present
	const targetSuffix = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
	const targetLibsqlPkgs = Object.entries(optionalDeps).filter(([name]) =>
		name.includes(targetSuffix),
	);
	for (const [name, version] of targetLibsqlPkgs) {
		const destPath = join(nodeModulesDir, name);
		if (!existsSync(destPath)) {
			fetchNpmPackage(name, version, destPath);
		}
	}
}

function copyParcelWatcherPlatformPackages(nodeModulesDir: string): void {
	const watcherPath = join(nodeModulesDir, "@parcel", "watcher");
	const watcherPkgJsonPath = join(watcherPath, "package.json");
	if (!existsSync(watcherPkgJsonPath)) return;

	type ParcelWatcherPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const watcherPkg = JSON.parse(
		readFileSync(watcherPkgJsonPath, "utf8"),
	) as ParcelWatcherPackageJson;
	const optionalDeps = watcherPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@parcel/watcher-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	console.log("\nPreparing parcel watcher platform package...");
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedPlatformPackage = false;

	for (const platformPkg of platformPackages) {
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			resolvedPlatformPackage =
				copyModuleIfSymlink(nodeModulesDir, platformPkg.name, false) ||
				resolvedPlatformPackage;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (!bunStoreFolderName) {
			console.warn(
				`  ${platformPkg.name}: no Bun store entry matched version ${platformPkg.version}`,
			);
			continue;
		}

		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			platformPkg.name,
		);
		if (!existsSync(sourcePath)) {
			console.warn(
				`  ${platformPkg.name}: Bun store path missing after resolve (${sourcePath})`,
			);
			continue;
		}

		console.log(`  ${platformPkg.name}: copying from Bun store`);
		mkdirSync(dirname(destPath), { recursive: true });
		cpSync(sourcePath, destPath, { recursive: true });
		resolvedPlatformPackage = true;
	}

	if (!resolvedPlatformPackage) {
		console.error(
			"  [ERROR] No `@parcel/watcher-<platform>` runtime package was materialized",
		);
		process.exit(1);
	}
}

function copyDuckdbPlatformPackages(nodeModulesDir: string): void {
	const nodeBindingsPath = join(nodeModulesDir, "@duckdb", "node-bindings");
	const nodeBindingsPkgJsonPath = join(nodeBindingsPath, "package.json");
	if (!existsSync(nodeBindingsPkgJsonPath)) return;

	type DuckdbBindingsPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const nodeBindingsPkg = JSON.parse(
		readFileSync(nodeBindingsPkgJsonPath, "utf8"),
	) as DuckdbBindingsPackageJson;
	const optionalDeps = nodeBindingsPkg.optionalDependencies ?? {};

	console.log("\nPreparing duckdb platform package...");

	// The native binding is a `cpu`/`os`-gated optional dependency, so Bun only
	// installs the host's. For the target arch, fetch it from npm when missing.
	const targetSuffix = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
	const targetEntry = Object.entries(optionalDeps).find(([name]) =>
		name.endsWith(targetSuffix),
	);
	if (!targetEntry) {
		console.error(
			`  [ERROR] No @duckdb/node-bindings optional dependency matched ${targetSuffix}`,
		);
		process.exit(1);
	}

	const [targetName, targetVersion] = targetEntry;
	const destPath = join(nodeModulesDir, targetName);
	if (existsSync(destPath)) {
		copyModuleIfSymlink(nodeModulesDir, targetName, true);
		return;
	}

	copyModuleForVersionSpec(
		nodeModulesDir,
		targetName,
		targetVersion,
		destPath,
		true,
	);
}

// Platform-specific optional native packages that must be materialized from Bun's store.
// @lydell/node-pty uses optionalDependencies for platform binaries, but Bun keeps them
// in .bun/ and they aren't resolvable from the desktop workspace without explicit copying.
const OPTIONAL_PLATFORM_MODULES = [
  ...(process.platform === "win32" && process.arch === "arm64" ? ["@lydell/node-pty-win32-arm64"] : []),
  ...(process.platform === "darwin" && process.arch === "arm64" ? ["@lydell/node-pty-darwin-arm64"] : []),
  ...(process.platform === "darwin" && process.arch === "x64" ? ["@lydell/node-pty-darwin-x64"] : []),
  ...(process.platform === "linux" && process.arch === "x64" ? ["@lydell/node-pty-linux-x64"] : []),
  ...(process.platform === "linux" && process.arch === "arm64" ? ["@lydell/node-pty-linux-arm64"] : []),
] as const;

/**
 * The native files a platform package must actually contain to be usable.
 *
 * Only the win32-arm64 node-pty package is listed: it is the one this fork
 * packages, and its two conpty binaries are what the terminal loads at runtime.
 * A package.json with the right name and version says nothing about whether
 * they are there — an interrupted copy leaves exactly that. The darwin/linux
 * entries of OPTIONAL_PLATFORM_MODULES only ever exist on their own host, where
 * this fork builds no installer, so nothing is asserted about them.
 */
const REQUIRED_PLATFORM_MODULE_FILES: Readonly<
	Record<string, readonly string[]>
> = {
	"@lydell/node-pty-win32-arm64": ["conpty.node", "conpty_console_list.node"],
};

/** PE `IMAGE_FILE_HEADER.Machine` for ARM64 (IMAGE_FILE_MACHINE_ARM64). */
const PE_MACHINE_ARM64 = 0xaa64;

/**
 * The machine a PE binary was built for, or null when the file is absent,
 * unreadable, or not a PE image at all.
 *
 * Same checks as `pearch` in scripts/verify-packaged-natives.sh, and for the
 * same reason: the machine field is two bytes at a computed offset, and any
 * file at all can carry 0xaa64 there by accident. So the whole path to it is
 * verified — an "MZ" DOS header, an e_lfanew at 0x3c that points past that
 * header and leaves the signature inside the file, "PE\0\0" at that offset, and
 * only then the 2-byte machine field after it.
 */
export function readPeMachine(filePath: string): number | null {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		const dosHeader = Buffer.alloc(0x40);
		if (readSync(fd, dosHeader, 0, 0x40, 0) !== 0x40) return null;
		if (dosHeader.toString("latin1", 0, 2) !== "MZ") return null;
		const peOffset = dosHeader.readUInt32LE(0x3c);
		if (peOffset < 0x40 || peOffset + 6 > fstatSync(fd).size) return null;
		const peHeader = Buffer.alloc(6);
		if (readSync(fd, peHeader, 0, 6, peOffset) !== 6) return null;
		if (peHeader.toString("latin1", 0, 4) !== "PE\0\0") return null;
		return peHeader.readUInt16LE(4);
	} finally {
		closeSync(fd);
	}
}

/** What is sitting at a platform package's destination, as far as fs can tell. */
export type InstalledPlatformModule = {
	isSymbolicLink: boolean;
	/** `null` when the directory has no readable package.json name/version. */
	name: string | null;
	version: string | null;
	/**
	 * PE machine of every file `REQUIRED_PLATFORM_MODULE_FILES` demands of this
	 * package, keyed by file name; `null` for one that is absent or unreadable.
	 */
	nativeMachines: Readonly<Record<string, number | null>>;
};

/**
 * Why a copy of `moduleName` cannot ship, or null when every native file it must
 * carry is present and built for ARM64.
 *
 * Both halves are load-bearing: a manifest beside a missing binary is what an
 * interrupted copy leaves, and an x64 binary under an arm64 package name loads
 * on nobody's machine while passing every name/version check.
 */
export function describeUnusableNativeFiles(
	moduleName: string,
	nativeMachines: Readonly<Record<string, number | null>>,
): string | null {
	for (const file of REQUIRED_PLATFORM_MODULE_FILES[moduleName] ?? []) {
		const machine = nativeMachines[file] ?? null;
		if (machine === null) return `${file} is missing or is not a PE binary`;
		if (machine !== PE_MACHINE_ARM64) {
			return `${file} is built for machine 0x${machine.toString(16)}, not ARM64 (0x${PE_MACHINE_ARM64.toString(16)})`;
		}
	}
	return null;
}

function readNativeMachines(
	modulePath: string,
	moduleName: string,
): Record<string, number | null> {
	return Object.fromEntries(
		(REQUIRED_PLATFORM_MODULE_FILES[moduleName] ?? []).map((file) => [
			file,
			readPeMachine(join(modulePath, file)),
		]),
	);
}

/**
 * Decide what to do with the destination of a required platform package.
 *
 * A symlink cannot be packaged into the asar, and a directory holding some
 * other package, some other version, or a missing/foreign-arch binary is
 * content that would ship instead of the one node-pty pins — all are replaced
 * from the store rather than accepted. Only a real directory whose package.json
 * matches the manifest AND whose native files are present and ARM64 is left
 * alone.
 */
export function planPlatformModuleCopy(
	moduleName: string,
	versionSpec: string,
	installed: InstalledPlatformModule | null,
): { action: "create" | "replace" | "skip"; reason: string } {
	// Checked before `satisfies` reaches it: semver throws its own
	// `Invalid comparator` from inside the range parser, an error that names
	// neither the package nor the manifest field the spec came from.
	if (validRange(versionSpec) === null) {
		throw new Error(
			`Unparsable version spec "${versionSpec}" for ${moduleName}: node-pty's optionalDependencies must hold an exact version or a semver range`,
		);
	}
	if (installed === null) return { action: "create", reason: "not present" };
	if (installed.isSymbolicLink) {
		return {
			action: "replace",
			reason: "symlink into the Bun store (electron-builder cannot follow it)",
		};
	}
	if (installed.name === null || installed.version === null) {
		return {
			action: "replace",
			reason: "directory has no package.json name/version",
		};
	}
	if (installed.name !== moduleName) {
		return {
			action: "replace",
			reason: `directory holds ${installed.name}, not ${moduleName}`,
		};
	}
	if (!satisfies(installed.version, versionSpec)) {
		return {
			action: "replace",
			reason: `directory holds ${installed.version}, which does not satisfy ${versionSpec}`,
		};
	}
	const unusable = describeUnusableNativeFiles(
		moduleName,
		installed.nativeMachines,
	);
	if (unusable) {
		return {
			action: "replace",
			reason: `directory holds ${installed.version} but ${unusable}`,
		};
	}
	return { action: "skip", reason: `already real ${installed.version}` };
}

/**
 * What is sitting at `modulePath`, or null when nothing is.
 *
 * Never throws on the manifest. Absent, truncated, unreadable and "not an
 * object" are one fact here — the directory does not say which package or
 * version it holds — and `planPlatformModuleCopy` replaces it on exactly that
 * fact. Throwing instead would kill the build over a half-written package.json
 * that the next line is about to overwrite anyway.
 */
export function inspectInstalledModule(
	modulePath: string,
	moduleName: string,
): InstalledPlatformModule | null {
	// lstat, not existsSync: a dangling symlink/junction does not exist to
	// existsSync but very much exists to the copy that would land on top of it.
	const stats = lstatSync(modulePath, { throwIfNoEntry: false });
	if (!stats) return null;
	if (stats.isSymbolicLink()) {
		return {
			isSymbolicLink: true,
			name: null,
			version: null,
			nativeMachines: {},
		};
	}
	const nativeMachines = readNativeMachines(modulePath, moduleName);
	type PackageJson = { name?: string; version?: string };
	let packageJson: PackageJson = {};
	try {
		packageJson = (JSON.parse(
			readFileSync(join(modulePath, "package.json"), "utf8"),
		) ?? {}) as PackageJson;
	} catch {
		// Left as {}: name and version fall through to null below.
	}
	return {
		isSymbolicLink: false,
		name: packageJson.name ?? null,
		version: packageJson.version ?? null,
		nativeMachines,
	};
}

/**
 * Where a swap parks the copy it is replacing, and builds the new one.
 *
 * Never beside the destination: apps/desktop/node_modules is copied whole into
 * the installer, so a `.mat-old-<pid>` left there by a failed rollback would be
 * packaged and shipped. The repo's tmp/ is on the same volume (the renames stay
 * cheap) and no packaging step reads it.
 */
function getSwapScratchDir(nodeModulesDir: string): string {
	return join(getWorkspaceRootNodeModulesDir(nodeModulesDir), "..", "tmp");
}

/** The two scratch paths `replaceDirectoryAtomically` uses for one swap. */
export function swapScratchPaths(
	destPath: string,
	scratchDir: string,
): { stagingPath: string; previousPath: string } {
	const stem = basename(destPath);
	return {
		stagingPath: join(scratchDir, `${stem}.mat-stage-${process.pid}`),
		previousPath: join(scratchDir, `${stem}.mat-old-${process.pid}`),
	};
}

/**
 * Copy `sourcePath` over `destPath` without ever leaving the destination
 * half-written: the copy is built in `scratchDir`, the previous directory is
 * moved aside into the same place, and only a completed rename deletes it. A
 * failure at any step restores the previous directory and rethrows, so the
 * packaged tree never keeps stale content and never loses a working copy to a
 * broken one (same staging swap as scripts/materialize-native-closure.sh).
 *
 * `scratchDir` must sit outside every packaged root: a rollback that fails too
 * deliberately leaves the rescued directory behind as the only copy of it, and
 * that copy must not be something electron-builder would pick up.
 */
export function replaceDirectoryAtomically(
	sourcePath: string,
	destPath: string,
	scratchDir: string,
): void {
	const { stagingPath, previousPath } = swapScratchPaths(destPath, scratchDir);
	mkdirSync(scratchDir, { recursive: true });
	mkdirSync(dirname(destPath), { recursive: true });
	rmSync(stagingPath, { recursive: true, force: true });
	rmSync(previousPath, { recursive: true, force: true });

	let movedAside = false;
	try {
		cpSync(sourcePath, stagingPath, { recursive: true, dereference: true });
		if (lstatSync(destPath, { throwIfNoEntry: false })) {
			renameSync(destPath, previousPath);
			movedAside = true;
		}
		renameSync(stagingPath, destPath);
	} catch (err) {
		rmSync(stagingPath, { recursive: true, force: true });
		// If the rollback itself fails, that error surfaces instead of this one
		// and the only remaining copy is the directory at `previousPath`.
		if (movedAside) renameSync(previousPath, destPath);
		throw err;
	}
	rmSync(previousPath, { recursive: true, force: true });
}

function copyNodePtyPlatformPackages(nodeModulesDir: string): void {
	if (OPTIONAL_PLATFORM_MODULES.length === 0) return;

	console.log("\nPreparing platform-specific optional modules...");

	// `node-pty` is an alias for `@lydell/node-pty` and is materialized above as a
	// required module, so its manifest is the source of truth for which version of
	// each platform binary belongs here. A missing manifest throws rather than
	// letting readdir order pick a version.
	const nodePtyPkgJsonPath = join(nodeModulesDir, "node-pty", "package.json");
	type NodePtyPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const nodePtyPkg = JSON.parse(
		readFileSync(nodePtyPkgJsonPath, "utf8"),
	) as NodePtyPackageJson;
	const optionalDeps = nodePtyPkg.optionalDependencies ?? {};

	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	const scratchDir = getSwapScratchDir(nodeModulesDir);
	for (const moduleName of OPTIONAL_PLATFORM_MODULES) {
		const destPath = join(nodeModulesDir, moduleName);

		const versionSpec = optionalDeps[moduleName];
		if (!versionSpec) {
			console.error(
				`  [ERROR] node-pty does not declare ${moduleName} in optionalDependencies`,
			);
			process.exit(1);
		}

		const plan = planPlatformModuleCopy(
			moduleName,
			versionSpec,
			inspectInstalledModule(destPath, moduleName),
		);
		if (plan.action === "skip") {
			console.log(`  ${moduleName}: ${plan.reason}`);
			continue;
		}

		// This is the terminal binary for the platform being packaged: an
		// installer without it has no working terminal at all, so a missing store
		// entry or payload fails the build instead of shipping a hole. There is
		// deliberately no any-version fallback — the wrong version is a native
		// module the app cannot load.
		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			moduleName,
			versionSpec,
		);
		if (!bunStoreFolderName) {
			console.error(
				`  [ERROR] ${moduleName}: node-pty pins ${versionSpec} and no Bun store entry holds it (${plan.reason})`,
			);
			process.exit(1);
		}

		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			moduleName,
		);
		if (!existsSync(sourcePath)) {
			console.error(
				`  [ERROR] ${moduleName}: Bun store entry ${bunStoreFolderName} has no payload at ${sourcePath}`,
			);
			process.exit(1);
		}

		// The entry can exist and still be unusable — a payload whose .node files
		// were never extracted, or a cache written by an install for another arch.
		// Checked BEFORE the swap, so the destination that is already there
		// survives a source that cannot replace it.
		const unusableSource = describeUnusableNativeFiles(
			moduleName,
			readNativeMachines(sourcePath, moduleName),
		);
		if (unusableSource) {
			console.error(
				`  [ERROR] ${moduleName}: Bun store entry ${bunStoreFolderName} cannot supply the module — ${unusableSource}`,
			);
			process.exit(1);
		}

		console.log(
			`  ${moduleName}: ${plan.reason} — copying ${bunStoreFolderName} from the Bun store`,
		);
		replaceDirectoryAtomically(sourcePath, destPath, scratchDir);
		console.log(`    Copied to: ${destPath}`);
	}
}

function prepareNativeModules() {
	console.log("Preparing external runtime modules for electron-builder...");
	console.log(
		`  Target: ${TARGET_PLATFORM}/${TARGET_ARCH} (host: ${process.platform}/${process.arch})`,
	);

	// bun creates symlinks for direct dependencies in the workspace's node_modules
	const nodeModulesDir = join(dirname(import.meta.dirname), "node_modules");

	console.log("\nMaterializing packaged runtime modules...");
	for (const moduleName of requiredMaterializedNodeModules) {
		copyModuleIfSymlink(nodeModulesDir, moduleName, true);
	}

	console.log("\nPreparing ast-grep platform package...");
	copyAstGrepPlatformPackages(nodeModulesDir);
	copyParcelWatcherPlatformPackages(nodeModulesDir);
	copyLibsqlDependencies(nodeModulesDir);
	copyDuckdbPlatformPackages(nodeModulesDir);

	copyNodePtyPlatformPackages(nodeModulesDir);

	console.log("\nDone!");
}

if (import.meta.main) {
	prepareNativeModules();
}
