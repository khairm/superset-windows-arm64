import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
	mock,
	spyOn,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { APP_LAUNCH_ID } from "renderer/routes/_authenticated/providers/CollectionsProvider/dashboardSidebarLocal";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, render } = await import("@testing-library/react");
const { SnoozeRemainingBadge } = await import("./SnoozeRemainingBadge");

const NOW = 1_700_000_000_000;

let parentRenders = 0;

function Parent({
	snoozeUntil,
	snoozeLaunchId,
}: {
	snoozeUntil: number | null;
	snoozeLaunchId: string | null;
}) {
	parentRenders += 1;
	return (
		<SnoozeRemainingBadge
			snoozeUntil={snoozeUntil}
			snoozeLaunchId={snoozeLaunchId}
		/>
	);
}

describe("SnoozeRemainingBadge", () => {
	let now: ReturnType<typeof spyOn>;

	beforeEach(() => {
		jest.useFakeTimers();
		now = spyOn(Date, "now").mockReturnValue(NOW);
		parentRenders = 0;
	});

	afterEach(() => {
		cleanup();
		mock.restore();
		jest.useRealTimers();
	});

	afterAll(async () => {
		if (!alreadyRegistered) await GlobalRegistrator.unregister();
	});

	it("counts down on the shared ticker without rendering its parent", () => {
		const view = render(
			<Parent snoozeUntil={NOW + 30 * 60_000} snoozeLaunchId={null} />,
		);
		expect(view.container.textContent).toBe("30m");

		now.mockReturnValue(NOW + 60_000);
		act(() => {
			jest.advanceTimersByTime(60_000);
		});
		expect(view.container.textContent).toBe("29m");
		expect(parentRenders).toBe(1);
	});

	it("shows launch for a launch-only snooze and starts no timer", () => {
		const view = render(
			<Parent snoozeUntil={null} snoozeLaunchId={APP_LAUNCH_ID} />,
		);
		expect(view.container.textContent).toBe("launch");
		expect(jest.getTimerCount()).toBe(0);
	});

	it("still shows 1m past the deadline before the due tick", () => {
		const deadline = NOW + 30_000;
		const view = render(
			<Parent snoozeUntil={deadline} snoozeLaunchId={null} />,
		);
		expect(view.container.textContent).toBe("1m");

		now.mockReturnValue(deadline + 45_000);
		view.rerender(<Parent snoozeUntil={deadline} snoozeLaunchId={null} />);
		expect(view.container.textContent).toBe("1m");

		const fresh = render(
			<Parent snoozeUntil={deadline} snoozeLaunchId={null} />,
		);
		expect(fresh.container.textContent).toBe("1m");
	});
});
