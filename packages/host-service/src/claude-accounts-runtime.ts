import type { ClaudeAccountsService } from "./claude-accounts";
import type { HostDb } from "./db";

const servicesByDb = new WeakMap<object, ClaudeAccountsService>();

export function registerClaudeAccountsService(
	db: HostDb,
	service: ClaudeAccountsService,
): void {
	servicesByDb.set(db as object, service);
}

export function getManagedClaudeAccountsForLaunch(
	db: HostDb,
): ClaudeAccountsService | undefined {
	const service = servicesByDb.get(db as object);
	if (service?.getCapability().managed !== true) return undefined;
	return service;
}
