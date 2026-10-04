import path from "node:path";
import { escapeGlobMagic, GLOB_ESCAPABLE, GLOB_MAGIC } from "./ignore-matcher";

// (WATCHER-NO-NATIVE-GLOBS) @parcel/watcher compiles every glob ignore into a
// std::regex, and on Windows matching an event path over ~290 chars aborts
// the whole process (0xC0000409). Plain paths are prefix-compared in C++ and
// never reach the regex, so Windows gets plain root-relative dirs only and
// every glob is filtered in JS instead.

const DIR_CONTENTS = "/**";
const ANY_DEPTH = "**/";

export class NativeIgnoreTripwireError extends Error {
	constructor(entry: string) {
		super(
			`Refusing to hand @parcel/watcher an unsafe native ignore entry: ${JSON.stringify(entry)}`,
		);
		this.name = "NativeIgnoreTripwireError";
	}
}

function unescapeGlob(input: string): string {
	return input.replace(/\\(.)/g, "$1");
}

function isLiteralEscaped(pattern: string): boolean {
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] as string;
		if (char === "\\") {
			if (index + 1 >= pattern.length) return false;
			index += 1;
		} else if (GLOB_ESCAPABLE.test(char)) {
			return false;
		}
	}
	return true;
}

export function splitIgnoreForNative(ignore: readonly string[]): {
	nativeDirs: string[];
	jsGlobs: string[];
} {
	const nativeDirs: string[] = [];
	const jsGlobs: string[] = [];
	for (const entry of ignore) {
		if (entry.endsWith(DIR_CONTENTS)) {
			const pattern = entry.slice(0, -DIR_CONTENTS.length);
			if (isLiteralEscaped(pattern)) {
				const dir = unescapeGlob(pattern).replaceAll("\\", "/");
				if (GLOB_MAGIC.test(dir)) {
					jsGlobs.push(`${escapeGlobMagic(dir)}${DIR_CONTENTS}`);
				} else {
					nativeDirs.push(dir);
				}
				continue;
			}
			if (pattern.startsWith(ANY_DEPTH)) {
				const name = pattern.slice(ANY_DEPTH.length);
				if (name !== "" && !GLOB_ESCAPABLE.test(name)) {
					nativeDirs.push(name);
					jsGlobs.push(entry);
					continue;
				}
			}
		}
		jsGlobs.push(entry);
	}
	return { nativeDirs, jsGlobs };
}

// (WATCHER-NO-NATIVE-GLOBS-TRIPWIRE) Unreachable from today's callers; fails
// loud if a future edit would hand native a glob or a path that resolves to
// the root, its parent, a drive or outside it (any of which ignores every
// event).
export function assertNativeIgnoreSafe(nativeDirs: readonly string[]): void {
	for (const dir of nativeDirs) {
		const normalised = path.posix.normalize(dir).replace(/\/+$/, "");
		if (
			normalised === "" ||
			normalised === "." ||
			dir.split("/").includes("..") ||
			path.win32.parse(dir).root !== "" ||
			dir.includes("\\") ||
			GLOB_MAGIC.test(dir)
		) {
			throw new NativeIgnoreTripwireError(dir);
		}
	}
}

export function nativeIgnoreForWindows(
	ignore: readonly string[],
	generation: number,
	rootPath: string,
): { nativeDirs: string[]; jsGlobs: string[] } {
	const { nativeDirs, jsGlobs } = splitIgnoreForNative(ignore);
	if (generation > 1) {
		nativeDirs.push(`.superset-watch-generation-${generation}`);
	}
	assertNativeIgnoreSafe(nativeDirs);
	// Native builds event paths as `mDir + "\\" + name`, so under a root that
	// already ends in a separator (`D:\`, `\\server\share\`) no plain dir
	// prefix ever matches.
	if (/[\\/]$/.test(path.win32.resolve(rootPath))) {
		for (const dir of nativeDirs) {
			jsGlobs.push(`${escapeGlobMagic(dir)}${DIR_CONTENTS}`);
		}
	}
	return { nativeDirs, jsGlobs };
}
