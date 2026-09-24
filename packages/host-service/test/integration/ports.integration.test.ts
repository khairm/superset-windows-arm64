import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { createTestHost, type TestHost } from "../helpers/createTestHost";

describe("ports router integration", () => {
	let host: TestHost;

	beforeEach(async () => {
		host = await createTestHost();
	});

	afterEach(async () => {
		// Optional chain so a setup failure in beforeEach (which leaves
		// `host` undefined at runtime) doesn't mask the original error
		// with a teardown crash.
		await host?.dispose();
	});

	test("getAll returns [] when no ports are tracked for the workspace", async () => {
		const result = await host.trpc.ports.getAll.query({
			workspaceIds: ["no-such-workspace"],
		});
		expect(result).toEqual([]);
	});

	test("getAll requires at least one workspaceId", async () => {
		await expect(
			host.trpc.ports.getAll.query({ workspaceIds: [] }),
		).rejects.toBeInstanceOf(TRPCClientError);
	});

	test("getAll requires authentication", async () => {
		await expect(
			host.unauthenticatedTrpc.ports.getAll.query({ workspaceIds: ["x"] }),
		).rejects.toBeInstanceOf(TRPCClientError);
	});
});

// (FORK-PORTS-OFF)
describe("disabled ports routes", () => {
	let host: TestHost;

	beforeEach(async () => {
		host = await createTestHost();
	});

	afterEach(async () => {
		await host?.dispose();
	});

	test("kill reports not killed and forwarding is not registered", async () => {
		expect(
			await host.trpc.ports.kill.mutate({
				workspaceId: "workspace",
				terminalId: "terminal",
				port: 3000,
			}),
		).toEqual({ success: false, error: "Port scanning is disabled" });
		const response = await host.fetch(
			"http://host-service.test/fwd?workspaceId=workspace",
			{
				headers: { authorization: `Bearer ${host.psk}` },
			},
		);
		expect(response.status).toBe(404);
	});
});
