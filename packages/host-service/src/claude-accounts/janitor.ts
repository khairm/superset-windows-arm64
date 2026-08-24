import { statSync } from "node:fs";
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { HostDb } from "../db";
import { workspaces } from "../db/schema";
import type { EventBus } from "../events";
import { mapConcurrent } from "../lib/map-concurrent";
import {
	disposeSessionAndWait,
	isDisposalComplete,
	listUndisposedTerminalIdsByWorkspaceId,
} from "../terminal/terminal";
import { WorkspaceLockBusyError } from "./locks";
import {
	type ClaudeProfileManager,
	isMissingFsError,
	isWorkspaceUuid,
} from "./profile-manager";
import type { ClaudeAccountsLogger } from "./types";

const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const JANITOR_CONCURRENCY = 6;

const markerSchema = z
	.object({
		workspaceId: z.string().uuid(),
		terminalIds: z.array(z.string().min(1)),
		dbInstanceId: z.string().uuid(),
		createdAt: z.number().int().positive(),
	})
	.strict();

const workspaceSnapshotSchema = z.array(
	z
		.object({
			id: z.string().uuid(),
			worktreePath: z.string().min(1),
			archivedAt: z.number().int().nonnegative().nullable(),
		})
		.passthrough(),
);

type DeletionMarker = z.infer<typeof markerSchema>;
type WorkspaceSnapshotRow = z.infer<typeof workspaceSnapshotSchema>[number];

interface JanitorDeps {
	db: HostDb;
	dbInstanceId: string;
	profiles: ClaudeProfileManager;
	log: ClaudeAccountsLogger;
	withWorkspaceLock<T>(
		workspaceId: string,
		fn: () => Promise<T>,
		opts?: { tryOnly?: boolean; timeoutMs?: number },
	): Promise<T>;
	deleteProfileWithTerminalIds(
		workspaceId: string,
		terminalIds: readonly string[],
	): Promise<void>;
}

interface RootInventory {
	profiles: Set<string>;
	markers: Set<string>;
	quarantinedCount: number;
}

function parseSuffixedUuid(
	name: string,
	suffix: ".delete-intent" | ".tmp" | ".orphaned",
): string | null {
	if (!name.endsWith(suffix)) return null;
	const workspaceId = name.slice(0, -suffix.length);
	return isWorkspaceUuid(workspaceId) ? workspaceId : null;
}

function isMissingDirectory(path: string): boolean {
	try {
		return statSync(path, { throwIfNoEntry: false }) === undefined;
	} catch {
		return false;
	}
}

export class ClaudeProfileJanitor {
	constructor(private readonly deps: JanitorDeps) {}

	async prepareWorkspaceDeletion(
		workspaceId: string,
		terminalIds: readonly string[],
	): Promise<void> {
		if (!isWorkspaceUuid(workspaceId)) {
			throw new Error(`Invalid workspace UUID: ${workspaceId}`);
		}
		const uniqueTerminalIds = [...new Set(terminalIds)];
		if (
			uniqueTerminalIds.some(
				(terminalId) => typeof terminalId !== "string" || !terminalId.trim(),
			)
		) {
			throw new Error(
				`Deletion marker for ${workspaceId} has an invalid terminal id`,
			);
		}
		const marker: DeletionMarker = {
			workspaceId,
			terminalIds: uniqueTerminalIds,
			dbInstanceId: this.deps.dbInstanceId,
			createdAt: Date.now(),
		};
		await this.deps.profiles.writeMarkerFile(
			this.deps.profiles.markerPathFor(workspaceId),
			marker,
		);
	}

	async clearDeletionMarker(workspaceId: string): Promise<void> {
		const path = this.deps.profiles.markerPathFor(workspaceId);
		try {
			await unlink(path);
		} catch (error) {
			if (!isMissingFsError(error)) throw error;
		}
	}

	async readDeletionMarker(
		workspaceId: string,
	): Promise<DeletionMarker | null> {
		const path = this.deps.profiles.markerPathFor(workspaceId);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (isMissingFsError(error)) return null;
			throw error;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch (error) {
			throw new Error(`Deletion marker is invalid JSON at ${path}`, {
				cause: error,
			});
		}
		const parsed = markerSchema.safeParse(raw);
		if (!parsed.success || parsed.data.workspaceId !== workspaceId) {
			throw new Error(
				`Deletion marker failed validation at ${path}: ${parsed.success ? "workspace id mismatch" : z.prettifyError(parsed.error)}`,
			);
		}
		return parsed.data;
	}

	async run(startup = false): Promise<void> {
		let snapshot: WorkspaceSnapshotRow[];
		let inventory: RootInventory;
		try {
			const raw = this.deps.db.select().from(workspaces).all();
			const parsed = workspaceSnapshotSchema.safeParse(raw);
			if (!parsed.success) {
				throw new Error(z.prettifyError(parsed.error));
			}
			snapshot = parsed.data;
			inventory = await this.inventoryRoot(snapshot.length > 0);
		} catch (error) {
			this.deps.log.error(
				"Claude profile janitor refused the entire pass: snapshot or root inventory failed",
				{ error },
			);
			return;
		}
		if (startup && inventory.quarantinedCount > 0) {
			this.deps.log.warn(
				`${inventory.quarantinedCount} quarantined Claude profile folder(s) await manual review`,
				{ profilesRoot: this.deps.profiles.profilesRoot },
			);
		}

		if (snapshot.length === 0) {
			this.deps.log.warn(
				"Claude profile janitor refused the normal pass: workspace snapshot is empty",
			);
			await this.recoverSameDatabaseZeroRowMarkers(inventory);
			return;
		}

		const rows = new Map(snapshot.map((row) => [row.id, row]));
		const candidates = [
			...new Set([...inventory.profiles, ...inventory.markers]),
		];
		await mapConcurrent(
			candidates,
			JANITOR_CONCURRENCY,
			async (workspaceId) => {
				try {
					await this.deps.withWorkspaceLock(
						workspaceId,
						() => this.reconcileCandidate(workspaceId, rows),
						{ tryOnly: true },
					);
				} catch (error) {
					if (error instanceof WorkspaceLockBusyError) {
						this.deps.log.info(
							"Claude profile janitor skipped a locked workspace",
							{ workspaceId },
						);
						return;
					}
					this.deps.log.error("Claude profile janitor candidate failed", {
						workspaceId,
						error,
					});
				}
			},
		);
	}

	private async inventoryRoot(
		allowMaintenance: boolean,
	): Promise<RootInventory> {
		const inventory: RootInventory = {
			profiles: new Set(),
			markers: new Set(),
			quarantinedCount: 0,
		};
		const entries = await readdir(this.deps.profiles.profilesRoot, {
			withFileTypes: true,
		});
		for (const entry of entries) {
			if (entry.isDirectory() && isWorkspaceUuid(entry.name)) {
				inventory.profiles.add(entry.name);
				continue;
			}
			const markerId = parseSuffixedUuid(entry.name, ".delete-intent");
			if (entry.isFile() && markerId) {
				inventory.markers.add(markerId);
				continue;
			}
			const quarantineId = parseSuffixedUuid(entry.name, ".orphaned");
			if (entry.isDirectory() && quarantineId) {
				inventory.quarantinedCount += 1;
				continue;
			}
			const stagingId = parseSuffixedUuid(entry.name, ".tmp");
			if (entry.isDirectory() && stagingId) {
				if (allowMaintenance) await this.cleanupOldStaging(stagingId);
				continue;
			}
			this.deps.log.warn(
				"Claude profile janitor skipped an unknown root entry",
				{
					entry: join(this.deps.profiles.profilesRoot, entry.name),
				},
			);
		}
		return inventory;
	}

	private async cleanupOldStaging(workspaceId: string): Promise<void> {
		const path = this.deps.profiles.stagingPathFor(workspaceId);
		let metadata: Awaited<ReturnType<typeof lstat>>;
		try {
			metadata = await lstat(path);
		} catch (error) {
			if (isMissingFsError(error)) return;
			throw error;
		}
		if (Date.now() - metadata.mtimeMs <= STAGING_MAX_AGE_MS) return;
		this.deps.log.warn(
			"Deleting Claude profile staging folder older than 24 hours",
			{
				workspaceId,
				path,
			},
		);
		await this.deps.profiles.deleteStagingDir(workspaceId);
	}

	private async reconcileCandidate(
		workspaceId: string,
		snapshotRows: ReadonlyMap<string, WorkspaceSnapshotRow>,
	): Promise<void> {
		const snapshotted = snapshotRows.get(workspaceId);
		const current = this.deps.db.query.workspaces
			.findFirst({ where: eq(workspaces.id, workspaceId) })
			.sync();
		if (snapshotted && !current) {
			this.deps.log.warn(
				"Workspace changed after janitor snapshot; candidate deferred",
				{
					workspaceId,
				},
			);
			return;
		}
		const markerExists = await this.markerExists(workspaceId);
		if (current && current.archivedAt === null) {
			if (markerExists) {
				await this.clearDeletionMarker(workspaceId);
				this.deps.log.warn(
					"Cleared stale Claude profile deletion marker for live workspace",
					{
						workspaceId,
					},
				);
			}
			return;
		}

		let marker: DeletionMarker | null = null;
		if (markerExists) {
			try {
				marker = await this.readDeletionMarker(workspaceId);
			} catch (error) {
				this.deps.log.error(
					"Claude profile deletion marker is unreadable; standing down",
					{
						workspaceId,
						error,
					},
				);
				return;
			}
		}

		if (!current) {
			if (!marker) {
				if (!(await this.deps.profiles.profileExists(workspaceId))) return;
				await this.deps.profiles.quarantineProfile(workspaceId);
				this.deps.log.warn("Quarantined unmarked orphan Claude profile", {
					workspaceId,
					path: this.deps.profiles.quarantinePathFor(workspaceId),
				});
				return;
			}
			await this.deleteAuthorized(workspaceId, marker);
			return;
		}

		if (
			current.archivedAt !== null &&
			isMissingDirectory(current.worktreePath)
		) {
			const terminalIds = marker
				? marker.terminalIds
				: listUndisposedTerminalIdsByWorkspaceId(workspaceId, this.deps.db);
			await this.deps.deleteProfileWithTerminalIds(workspaceId, terminalIds);
			await this.clearDeletionMarker(workspaceId);
			this.deps.log.warn(
				"Deleted Claude profile for archived workspace with missing worktree",
				{
					workspaceId,
					markerPresent: marker !== null,
				},
			);
		}
	}

	private async recoverSameDatabaseZeroRowMarkers(
		inventory: RootInventory,
	): Promise<void> {
		for (const workspaceId of inventory.markers) {
			try {
				await this.deps.withWorkspaceLock(
					workspaceId,
					async () => {
						const current = this.deps.db.query.workspaces
							.findFirst({ where: eq(workspaces.id, workspaceId) })
							.sync();
						if (current) {
							await this.clearDeletionMarker(workspaceId);
							this.deps.log.warn(
								"Cleared stale zero-row deletion marker after workspace appeared",
								{ workspaceId },
							);
							return;
						}
						const marker = await this.readDeletionMarker(workspaceId);
						if (!marker || marker.dbInstanceId !== this.deps.dbInstanceId) {
							this.deps.log.warn(
								"Zero-row janitor refused marker from another or unknown database instance",
								{ workspaceId },
							);
							return;
						}
						await this.deleteAuthorized(workspaceId, marker);
					},
					{ tryOnly: true },
				);
			} catch (error) {
				if (error instanceof WorkspaceLockBusyError) continue;
				this.deps.log.error("Zero-row Claude profile recovery failed", {
					workspaceId,
					error,
				});
			}
		}
	}

	private async deleteAuthorized(
		workspaceId: string,
		marker: DeletionMarker,
	): Promise<void> {
		if (marker.dbInstanceId !== this.deps.dbInstanceId) {
			this.deps.log.warn(
				"Claude profile marker database instance mismatch; standing down",
				{
					workspaceId,
				},
			);
			return;
		}
		await this.deps.deleteProfileWithTerminalIds(
			workspaceId,
			marker.terminalIds,
		);
		await this.clearDeletionMarker(workspaceId);
		this.deps.log.warn(
			"Deleted Claude profile authorized by committed deletion marker",
			{
				workspaceId,
			},
		);
	}

	private async markerExists(workspaceId: string): Promise<boolean> {
		try {
			await lstat(this.deps.profiles.markerPathFor(workspaceId));
			return true;
		} catch (error) {
			if (isMissingFsError(error)) return false;
			throw error;
		}
	}
}

export type DisposalFailureMode = "abort" | "warn-and-continue";

interface DisposeTerminalIdsOptions {
	mode: DisposalFailureMode;
	log: ClaudeAccountsLogger;
	eventBus?: EventBus;
}

export async function disposeTerminalIds(
	db: HostDb,
	terminalIds: readonly string[],
	options: DisposeTerminalIdsOptions,
): Promise<void> {
	const results = await Promise.allSettled(
		[...new Set(terminalIds)].map(async (terminalId) => {
			const result = await disposeSessionAndWait(
				terminalId,
				db,
				options.eventBus,
			);
			if (!isDisposalComplete(result)) {
				throw new Error(
					`Terminal ${terminalId} disposal did not complete (${result.dbDisposition}${result.daemonCloseError ? `: ${result.daemonCloseError}` : ""})`,
				);
			}
		}),
	);
	const errors = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (errors.length === 0) return;
	if (options.mode === "abort") {
		throw new AggregateError(errors, "One or more terminal disposals failed");
	}
	options.log.warn(
		"One or more terminal disposals did not complete; workspace destroy will continue",
		{ errors },
	);
}
