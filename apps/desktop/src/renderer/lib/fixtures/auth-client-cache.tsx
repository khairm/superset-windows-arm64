import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost" });
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { App: { localOrganizationId: string } }).App = {
	localOrganizationId: "org-1",
};

const fakeCollections = {};
mock.module(
	"renderer/routes/_authenticated/providers/CollectionsProvider/collections",
	() => ({
		getCollections: () => fakeCollections,
		preloadCollections: async () => {},
		evictInactiveOrgCollections: () => {},
	}),
);

const { act, cleanup, render } = await import("@testing-library/react");
const { useState } = await import("react");
const { authClient, getSeveredOrganizationResult, getSeveredSessionResult } =
	await import("../auth-client");
const { CollectionsProvider, useCollections } = await import(
	"renderer/routes/_authenticated/providers/CollectionsProvider"
);

afterAll(() => cleanup());

describe("severed auth results", () => {
	test("the session result and its refetch keep identity across calls", () => {
		const first = getSeveredSessionResult();
		expect(getSeveredSessionResult()).toBe(first);
		expect(getSeveredSessionResult().refetch).toBe(first.refetch);
		expect(authClient.useSession()).toBe(first);
	});

	test("the organization result and its refetch keep identity across calls", () => {
		const first = getSeveredOrganizationResult();
		expect(getSeveredOrganizationResult()).toBe(first);
		expect(getSeveredOrganizationResult().refetch).toBe(first.refetch);
		expect(authClient.useActiveOrganization()).toBe(first);
	});

	test("a CollectionsProvider re-render keeps the context value", async () => {
		const seen: ReturnType<typeof useCollections>[] = [];
		let rerender: (value: number) => void = () => {};
		function Probe() {
			seen.push(useCollections());
			return null;
		}
		function Parent() {
			const [, setTick] = useState(0);
			rerender = setTick;
			return (
				<CollectionsProvider>
					<Probe />
				</CollectionsProvider>
			);
		}
		render(<Parent />);
		await act(async () => rerender(1));
		expect(seen.length).toBeGreaterThan(1);
		expect(seen.at(-1)).toBe(seen[0]);
	});
});
