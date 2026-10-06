import type { FileTree, FileTreeIconConfig } from "@pierre/trees";
import { useEffect, useState } from "react";
import {
	getLoadedFallthroughIcons,
	loadFallthroughIcons,
} from "./loadFallthroughIcons";

const BASE_TREE_ICONS: FileTreeIconConfig = { set: "complete", colored: true };

/**
 * Icons for a new `@pierre/trees` model. Once the fallthrough sprite has
 * loaded, the model's constructor applies it, so `useFallthroughIcons` skips
 * the `setIcons` re-sync that would otherwise run before the first paint
 * (WS-OPEN-RENDER).
 */
export function useInitialTreeIcons(): FileTreeIconConfig {
	const [icons] = useState(() => {
		const loaded = getLoadedFallthroughIcons();
		return loaded ? { ...BASE_TREE_ICONS, ...loaded } : BASE_TREE_ICONS;
	});
	return icons;
}

/**
 * Layers our Material-icon fallthrough coverage onto a `@pierre/trees` model
 * built without it: file types Pierre's built-in `complete` set doesn't
 * recognize (`.toml`, `.lock`, framework dirs, …) plus a Material
 * default-file icon for anything still unmatched. The model renders with
 * Pierre's defaults first; ours fill in async.
 */
export function useFallthroughIcons(
	model: FileTree,
	initialIcons: FileTreeIconConfig,
): void {
	useEffect(() => {
		if (initialIcons.spriteSheet) return;
		let cancelled = false;
		void loadFallthroughIcons().then((config) => {
			if (cancelled) return;
			model.setIcons({ ...BASE_TREE_ICONS, ...config });
		});
		return () => {
			cancelled = true;
		};
	}, [model, initialIcons]);
}
