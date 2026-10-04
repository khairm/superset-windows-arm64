import path from "node:path";
import picomatch from "picomatch";

export const GLOB_MAGIC = /[*?{}()[\]!+@|]/;

// Every character picomatch (parcel's glob engine) treats as magic, plus the
// escape itself. Mirrors the metacharacter set `is-glob`/picomatch@2 recognize.
export const GLOB_ESCAPABLE = /[\\*?{}()[\]!+@|^$]/;
const GLOB_ESCAPABLE_ALL = new RegExp(GLOB_ESCAPABLE.source, "g");

/** Backslash-escapes glob magic so a path is matched literally inside a glob. */
export function escapeGlobMagic(input: string): string {
	return input.replace(GLOB_ESCAPABLE_ALL, (char) => `\\${char}`);
}

/**
 * Compiles a root-relative ignore list into a predicate over absolute paths.
 * A directory matches when the ignore list covers its contents, so a caller
 * pruning a traversal never descends into it.
 */
export function createIgnoreMatcher(
	rootPath: string,
	ignore: readonly string[],
): (absolutePath: string, isDirectory: boolean | undefined) => boolean {
	const globs = ignore.filter((entry) => GLOB_MAGIC.test(entry));
	const literalPaths = ignore
		.filter((entry) => !GLOB_MAGIC.test(entry))
		.map((entry) => path.resolve(rootPath, entry));
	const matchesGlob =
		globs.length > 0 ? picomatch(globs, { dot: true }) : () => false;

	return (absolutePath, isDirectory) => {
		for (const literal of literalPaths) {
			if (
				absolutePath === literal ||
				absolutePath.startsWith(`${literal}${path.sep}`)
			) {
				return true;
			}
		}
		const relative = path.relative(rootPath, absolutePath);
		if (
			relative === "" ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			return false;
		}
		const posixRelative =
			path.sep === "/" ? relative : relative.split(path.sep).join("/");
		if (matchesGlob(posixRelative)) {
			return true;
		}
		return isDirectory !== false && matchesGlob(`${posixRelative}/_`);
	};
}
