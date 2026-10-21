import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";

// `mock.module` is process-wide: keep every real export and fake the pin only until this file ends.
const realClaudeAccounts = {
	...(await import(
		"renderer/hooks/host-service/useClaudeAccounts/useClaudeAccounts"
	)),
};
let faking = true;
afterAll(() => {
	faking = false;
});
const pinWorkspaceToMachineDefault = mock<
	typeof realClaudeAccounts.pinWorkspaceToMachineDefault
>(async () => {});
mock.module(
	"renderer/hooks/host-service/useClaudeAccounts/useClaudeAccounts",
	() => ({
		...realClaudeAccounts,
		pinWorkspaceToMachineDefault: (
			...args: Parameters<typeof pinWorkspaceToMachineDefault>
		) =>
			faking
				? pinWorkspaceToMachineDefault(...args)
				: realClaudeAccounts.pinWorkspaceToMachineDefault(...args),
	}),
);

const { pinActiveWorkspace } = await import("./pinActiveWorkspace");
type Collections = Parameters<typeof pinActiveWorkspace>[0];
type PinTarget = import("./pinActiveWorkspace").WorkspacePinTarget;

function fixture(
	options: {
		stamp?: number | null;
		completedAt?: number | null;
		sandbox?: boolean;
		missing?: boolean;
	} = {},
) {
	const collections = {
		v2WorkspaceLocalState: {
			get: () => ({
				workspaceId: "workspace",
				sidebarState: {
					isHidden: false,
					runtimeCleanupPendingAt: options.stamp ?? null,
					completedAt: options.completedAt ?? null,
				},
			}),
		},
	} as unknown as Collections;
	const resolveHostUrl = mock(() => "http://owner:1234");
	const target = {
		workspaces: options.missing
			? []
			: [{ id: "workspace", hostId: "owner", type: "worktree" }],
		cache: {
			isSandboxHost: () => options.sandbox === true,
			resolveHostUrl,
		},
	} as unknown as PinTarget;
	return { collections, target, resolveHostUrl };
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
	pinWorkspaceToMachineDefault.mockClear();
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("returned workspace pin gate", () => {
	test("pins an active workspace with no cleanup stamp at its owner URL", () => {
		const { collections, target, resolveHostUrl } = fixture();
		pinActiveWorkspace(collections, "workspace", target);
		expect(resolveHostUrl).toHaveBeenCalledWith("owner");
		expect(pinWorkspaceToMachineDefault).toHaveBeenCalledWith(
			"http://owner:1234",
			"workspace",
			{ onlyIfFollowing: undefined },
		);
	});

	test("skips a workspace with pending cleanup", () => {
		const { collections, target } = fixture({ stamp: 42 });
		pinActiveWorkspace(collections, "workspace", target);
		expect(pinWorkspaceToMachineDefault).not.toHaveBeenCalled();
	});

	test("skips a workspace outside the active bucket", () => {
		const { collections, target } = fixture({ completedAt: 42 });
		pinActiveWorkspace(collections, "workspace", target);
		expect(pinWorkspaceToMachineDefault).not.toHaveBeenCalled();
	});

	test("silently skips a sandbox host", () => {
		const { collections, target } = fixture({ sandbox: true });
		pinActiveWorkspace(collections, "workspace", target);
		expect(pinWorkspaceToMachineDefault).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	test("warns when the host workspace row is missing", () => {
		const { collections, target } = fixture({ missing: true });
		pinActiveWorkspace(collections, "workspace", target);
		expect(pinWorkspaceToMachineDefault).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[claude-accounts] could not pin returned workspace: workspace missing",
			{ workspaceId: "workspace" },
		);
	});
});

describe("pre-resolved returned workspace pin gate", () => {
	test("pins at the answered owner without a workspace lookup", () => {
		const { collections } = fixture({ missing: true });
		pinActiveWorkspace(
			collections,
			"workspace",
			{
				workspaceType: "worktree",
				isSandbox: false,
			},
			{ hostUrl: "http://answered:1234", onlyIfFollowing: true },
		);
		expect(pinWorkspaceToMachineDefault).toHaveBeenCalledWith(
			"http://answered:1234",
			"workspace",
			{ onlyIfFollowing: true },
		);
	});

	test(`keeps gates for a pre-resolved owner: {"sandbox":true}`, () => {
		const { collections } = fixture({ sandbox: true });
		pinActiveWorkspace(
			collections,
			"workspace",
			{
				workspaceType: "worktree",
				isSandbox: true,
			},
			{ hostUrl: "http://answered:1234", onlyIfFollowing: true },
		);
		expect(pinWorkspaceToMachineDefault).not.toHaveBeenCalled();
	});
});
