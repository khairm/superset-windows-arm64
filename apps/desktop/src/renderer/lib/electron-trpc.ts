import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "lib/trpc/routers";

/**
 * tRPC React client for Electron IPC communication with main process.
 * For desktop-specific operations: workspaces, terminal, auth, etc.
 */
export const electronTrpc = createTRPCReact<AppRouter>({
	abortOnUnmount: true,
});

export type ElectronRouterOutputs = inferRouterOutputs<AppRouter>;

/** The query-cache handle `electronTrpc.useUtils()` hands back. */
export type ElectronTrpcUtils = ReturnType<typeof electronTrpc.useUtils>;
