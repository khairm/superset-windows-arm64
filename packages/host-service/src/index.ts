export { createApiClient } from "./api";
export { type CreateAppOptions, type CreateAppResult, createApp } from "./app";
export type { HostDb } from "./db";
export type {
	ClientMessage as EventBusClientMessage,
	ServerMessage as EventBusServerMessage,
} from "./events";
export type { ApiAuthProvider } from "./providers/auth";
export {
	DeviceKeyApiAuthProvider,
	JwtApiAuthProvider,
	SeveredApiAuthProvider,
} from "./providers/auth";
export {
	CloudGitCredentialProvider,
	LocalGitCredentialProvider,
} from "./providers/git";
export type { HostAuthProvider } from "./providers/host-auth";
export { PskHostAuthProvider } from "./providers/host-auth";
export { resolveBrowserBridgeFromEnv } from "./runtime/browser-bridge/env";
export type { GitCredentialProvider, GitFactory } from "./runtime/git";
export { installProcessSafetyNet, installUpgradeSocketGuard } from "./safety";
export { captureFatalStartupError, initSentry } from "./sentry";
export { startTerminalReaper } from "./terminal/reaper";
export type {
	DeleteInProgressCause,
	TeardownFailureCause,
} from "./trpc/error-types";
export type { AppRouter } from "./trpc/router";
export type { ApiClient, HostServiceContext } from "./types";
// (COMPANION-BRIDGE) Runtime export, not type-only, on purpose: the desktop
// child runs its OWN serve loop (apps/desktop/src/main/host-service/index.ts),
// not serve.ts, so the mount must be reachable from the package root or that
// entry has no line to start the bridge from. That is not hypothetical — the
// bridge shipped once with the mount only in serve.ts, and every production
// child reported enabled-but-never-started while every gate stayed green.
export {
	type CompanionMountInput,
	startCompanionBridgeIfEnabled,
} from "./companion";
