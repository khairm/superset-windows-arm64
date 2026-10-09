import { createRequire } from "node:module";
import type { Options as ParcelWatchOptions } from "@parcel/watcher";

/** What parcel's own wrapper hands the native binding. */
export interface NativeOptions {
	ignoreGlobs?: string[];
	ignorePaths?: string[];
	backend?: string;
}

type NativeCall = (dir: string, fn: unknown, opts: NativeOptions) => void;

export const { createWrapper } = createRequire(import.meta.url)(
	"@parcel/watcher/wrapper.js",
) as {
	createWrapper(binding: { subscribe: NativeCall; unsubscribe?: NativeCall }): {
		subscribe(
			dir: string,
			fn: () => void,
			opts: ParcelWatchOptions,
		): Promise<{ unsubscribe(): Promise<void> }>;
	};
};
