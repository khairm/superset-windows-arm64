import { create } from "zustand";
import { persist } from "zustand/middleware";

export type KanbanSplitOrientation = "top" | "left";

export const KANBAN_SPLIT_MIN_HEIGHT = 160;
export const KANBAN_SPLIT_MAX_HEIGHT = 560;
export const KANBAN_SPLIT_DEFAULT_HEIGHT = 280;
export const KANBAN_SPLIT_MIN_WIDTH = 260;
export const KANBAN_SPLIT_MAX_WIDTH = 560;
export const KANBAN_SPLIT_DEFAULT_WIDTH = 360;

interface KanbanSplitLayoutState {
	/** Where the collapsed board sits in the split. Default: top bar. */
	orientation: KanbanSplitOrientation;
	/** Top-bar strip height (px), persisted like the rail width. */
	topHeight: number;
	/** Left-rail width (px). */
	railWidth: number;
	setOrientation: (orientation: KanbanSplitOrientation) => void;
	setTopHeight: (topHeight: number) => void;
	setRailWidth: (railWidth: number) => void;
}

/**
 * (KANBAN) Device-local layout preference for the collapse-split: board as a
 * TOP strip (default) or a LEFT rail, plus the remembered strip height / rail
 * width. Local-only like the board itself.
 */
export const useKanbanSplitLayout = create<KanbanSplitLayoutState>()(
	persist(
		(set) => ({
			orientation: "top",
			topHeight: KANBAN_SPLIT_DEFAULT_HEIGHT,
			railWidth: KANBAN_SPLIT_DEFAULT_WIDTH,
			setOrientation: (orientation) => set({ orientation }),
			setTopHeight: (topHeight) =>
				set({
					topHeight: Math.max(
						KANBAN_SPLIT_MIN_HEIGHT,
						Math.min(KANBAN_SPLIT_MAX_HEIGHT, topHeight),
					),
				}),
			setRailWidth: (railWidth) =>
				set({
					railWidth: Math.max(
						KANBAN_SPLIT_MIN_WIDTH,
						Math.min(KANBAN_SPLIT_MAX_WIDTH, railWidth),
					),
				}),
		}),
		{ name: "kanban-split-layout" },
	),
);
