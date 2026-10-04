import { watch as probeNativeWatch } from "node:fs";
import { createIgnoreMatcher } from "./ignore-matcher";
import {
	nativeIgnoreForWindows,
	watchGenerationSentinel,
} from "./native-ignore-split";
import type { NativeWatchBackend, NativeWatchRequest } from "./types";

// Linux: @parcel/watcher's inotify backend starts on a thread and the caller
// blocks until that thread signals it started. When inotify_init fails
// (EMFILE at fs.inotify.max_user_instances, 128 by default and shared by
// every process of the user) the thread throws before signalling and the
// calling thread — host-service's event loop — waits forever. A throwaway
// fs.watch makes the same inotify_init call and fails cleanly instead.
function assertNativeWatchAvailable(dir: string): void {
	if (process.platform !== "linux") return;
	let probe: ReturnType<typeof probeNativeWatch>;
	try {
		probe = probeNativeWatch(dir, { persistent: false });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		throw new Error(
			`Cannot watch path: inotify unavailable (${code}); raise fs.inotify.max_user_instances or close other watchers: ${dir}`,
		);
	}
	probe.close();
}

function planIgnore({
	rootPath,
	ignore,
	generation,
}: Pick<NativeWatchRequest, "rootPath" | "ignore" | "generation">): {
	nativeIgnore: string[];
	isIgnored: ReturnType<typeof createIgnoreMatcher> | null;
} {
	if (process.platform === "win32") {
		// (WATCHER-NO-NATIVE-GLOBS) Windows: native gets plain dirs only (see
		// native-ignore-split.ts); globs are filtered here in JS.
		const { nativeDirs, jsGlobs } = nativeIgnoreForWindows(
			ignore,
			generation,
			rootPath,
		);
		return {
			nativeIgnore: nativeDirs,
			isIgnored: createIgnoreMatcher(rootPath, jsGlobs),
		};
	}
	// parcel dedupes native backends by (dir, ignore-set); a wedged backend
	// from a dead stream (its unsubscribe can hang) would be silently
	// joined and never deliver. The pattern matches nothing real — it only
	// forces a distinct backend identity per re-attach.
	return {
		nativeIgnore:
			generation === 1
				? ignore
				: [...ignore, `**/${watchGenerationSentinel(generation)}/**`],
		isIgnored: null,
	};
}

export const parcelWatchBackend: NativeWatchBackend = {
	name: "parcel",
	async subscribe({ rootPath, ignore, generation, onEvents, onError }) {
		assertNativeWatchAvailable(rootPath);
		const { nativeIgnore, isIgnored } = planIgnore({
			rootPath,
			ignore,
			generation,
		});
		// Loaded on first use so a platform on another backend never maps the
		// native addon into the process.
		const { subscribe: subscribeToFilesystem } = await import(
			"@parcel/watcher"
		);
		const subscription = await subscribeToFilesystem(
			rootPath,
			(error, events) => {
				// Log the error, then process whatever events arrived alongside
				// it. Mirrors VS Code's parcelWatcher.ts:373-378.
				if (error) onError(error);
				const kept = isIgnored
					? events.filter((event) => !isIgnored(event.path, false))
					: events;
				if (kept.length > 0) onEvents(kept);
			},
			{ ignore: nativeIgnore },
		);
		return { unsubscribe: () => subscription.unsubscribe() };
	},
};
