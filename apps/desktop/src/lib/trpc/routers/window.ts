import fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import { getImageMimeType } from "shared/file-types";
import { z } from "zod";
import { publicProcedure, router } from "..";

async function pickDirectories(
	window: BrowserWindow | null,
	opts: { title: string; defaultPath?: string; multi: boolean },
): Promise<string[]> {
	if (!window) return [];
	const result = await dialog.showOpenDialog(window, {
		properties: opts.multi
			? ["openDirectory", "createDirectory", "multiSelections"]
			: ["openDirectory", "createDirectory"],
		title: opts.title,
		defaultPath: opts.defaultPath ?? undefined,
	});
	if (result.canceled) return [];
	return result.filePaths;
}

export const createWindowRouter = (getWindow: () => BrowserWindow | null) => {
	return router({
		minimize: publicProcedure.mutation(() => {
			const window = getWindow();
			if (!window) return { success: false };
			window.minimize();
			return { success: true };
		}),

		maximize: publicProcedure.mutation(() => {
			const window = getWindow();
			if (!window) return { success: false, isMaximized: false };
			if (window.isMaximized()) {
				window.unmaximize();
			} else {
				window.maximize();
			}
			return { success: true, isMaximized: window.isMaximized() };
		}),

		close: publicProcedure.mutation(() => {
			const window = getWindow();
			if (!window) return { success: false };
			window.close();
			return { success: true };
		}),

		isMaximized: publicProcedure.query(() => {
			const window = getWindow();
			if (!window) return false;
			return window.isMaximized();
		}),

		getPlatform: publicProcedure.query(() => {
			return process.platform;
		}),

		getHomeDir: publicProcedure.query(() => {
			return homedir();
		}),

		getDirectoryStatus: publicProcedure
			.input(
				z.object({
					path: z.string(),
				}),
			)
			.query(async ({ input }) => {
				try {
					const stats = await fs.stat(input.path);
					return {
						exists: true,
						isDirectory: stats.isDirectory(),
					};
				} catch {
					return {
						exists: false,
						isDirectory: false,
					};
				}
			}),

		selectDirectory: publicProcedure
			.input(
				z
					.object({
						title: z.string().optional(),
						defaultPath: z.string().optional(),
					})
					.optional(),
			)
			.mutation(async ({ input }) => {
				const paths = await pickDirectories(getWindow(), {
					title: input?.title ?? "Select Directory",
					defaultPath: input?.defaultPath,
					multi: false,
				});
				if (paths.length === 0) return { canceled: true, path: null };
				return { canceled: false, path: paths[0] };
			}),

		// (MULTI-REPO WORKSPACE) Multi-select folder picker for "Open from
		// multi-folder" — same dialog as selectDirectory plus multiSelections.
		selectDirectories: publicProcedure
			.input(
				z
					.object({
						title: z.string().optional(),
						defaultPath: z.string().optional(),
					})
					.optional(),
			)
			.mutation(async ({ input }) => {
				const paths = await pickDirectories(getWindow(), {
					title: input?.title ?? "Select Directories",
					defaultPath: input?.defaultPath,
					multi: true,
				});
				if (paths.length === 0) return { canceled: true, paths: [] as string[] };
				return { canceled: false, paths };
			}),

		// (KANBAN BACKUP) Append-only daily snapshot of the kanban board.
		// HARD SAFETY CONTRACT: this code path can only CREATE files — it
		// never overwrites, deletes, prunes, or rotates. One file per org per
		// day; if today's file already exists the call is a no-op. Snapshots
		// live OUTSIDE the Electron profile so profile/leveldb corruption or
		// a reinstall cannot touch them. Written via temp+rename so a crash
		// mid-write can never leave a truncated snapshot under the real name.
		writeKanbanBackup: publicProcedure
			.input(
				z.object({
					organizationId: z.string().min(1),
					payload: z.string().min(2),
					cardCount: z.number().int().nonnegative(),
				}),
			)
			.mutation(async ({ input }) => {
				// Nothing worth snapshotting — and never let an accidentally
				// emptied board produce the day's snapshot.
				if (input.cardCount === 0) {
					return { written: false as const, reason: "empty-board" as const };
				}
				const safeOrg = input.organizationId.replace(/[^a-zA-Z0-9_-]/g, "_");
				const dir = join(homedir(), ".superset", "backups", "kanban");
				// LOCAL date, not toISOString (UTC) — otherwise the day rolls over
				// at UTC midnight and late-evening edits land in "yesterday's"
				// already-written file (a no-op), skipping them entirely.
				const now = new Date();
				const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
				const filePath = join(dir, `${safeOrg}-${today}.json`);
				try {
					await fs.mkdir(dir, { recursive: true });
					// Write-once per day: if today's snapshot exists, NOTHING runs —
					// rename would replace it on Windows, so the guard comes first.
					const exists = await fs
						.access(filePath)
						.then(() => true)
						.catch(() => false);
					if (exists) {
						return { written: false as const, reason: "already-exists" as const };
					}
					const tempPath = `${filePath}.tmp-${process.pid}`;
					await fs.writeFile(tempPath, input.payload, "utf8");
					await fs.rename(tempPath, filePath);
					return { written: true as const, path: filePath };
				} catch (err) {
					console.warn("[kanban-backup] snapshot failed", err);
					return { written: false as const, reason: "error" as const };
				}
			}),

		selectImageFile: publicProcedure.mutation(async () => {
			const window = getWindow();
			if (!window) {
				return { canceled: true, dataUrl: null };
			}

			const result = await dialog.showOpenDialog(window, {
				properties: ["openFile"],
				title: "Select Organization Logo",
				filters: [
					{
						name: "Images",
						extensions: ["png", "jpg", "jpeg", "webp"],
					},
				],
			});

			if (result.canceled || result.filePaths.length === 0) {
				return { canceled: true, dataUrl: null };
			}

			const filePath = result.filePaths[0];
			const buffer = await fs.readFile(filePath);
			const mimeType = getImageMimeType(filePath) ?? "image/png";
			const base64 = buffer.toString("base64");
			const dataUrl = `data:${mimeType};base64,${base64}`;

			return { canceled: false, dataUrl };
		}),
	});
};

export type WindowRouter = ReturnType<typeof createWindowRouter>;
