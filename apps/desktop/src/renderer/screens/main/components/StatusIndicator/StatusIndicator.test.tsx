import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	jest,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { redPingTicker, spinnerTicker } from "renderer/lib/shared-ticker";

const alreadyRegistered = GlobalRegistrator.isRegistered;
if (!alreadyRegistered) GlobalRegistrator.register();
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { act, cleanup, render } = await import("@testing-library/react");
const { StatusIndicator } = await import("./StatusIndicator");

function Dots({
	red,
	blueClassName,
}: {
	red: boolean;
	blueClassName?: string;
}) {
	return (
		<>
			{red && <StatusIndicator status="permission" />}
			<StatusIndicator status="shell-running" className={blueClassName} />
		</>
	);
}

describe("StatusIndicator pings", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		jest.useRealTimers();
	});

	afterAll(async () => {
		if (!alreadyRegistered) await GlobalRegistrator.unregister();
	});

	it.each([
		"permission",
		"failed",
		"shell-running",
		"background-running",
	])("%s uses the finite ping", (status) => {
		const { container } = render(<StatusIndicator status={status} />);

		expect(container.querySelector(".animate-ping-finite")).not.toBeNull();
		expect(container.querySelector(".animate-ping")).toBeNull();
	});

	it("re-arms red on the shared 30 s ticker and leaves blue alone", () => {
		const stopSpinner = spinnerTicker.subscribe(() => {});
		const view = render(<Dots red />);
		const redPing = () => view.container.querySelector(".bg-red-400");
		const bluePing = () => view.container.querySelector(".bg-blue-400");
		const firstRed = redPing();
		const blue = bluePing();
		expect(firstRed).not.toBeNull();
		expect(blue).not.toBeNull();

		act(() => {
			jest.advanceTimersByTime(30_000);
		});
		const secondRed = redPing();
		expect(secondRed).not.toBeNull();
		expect(secondRed).not.toBe(firstRed);

		act(() => {
			jest.advanceTimersByTime(30_000);
		});
		const thirdRed = redPing();
		expect(thirdRed).not.toBeNull();
		expect(thirdRed).not.toBe(secondRed);
		expect(bluePing()).toBe(blue);

		view.rerender(<Dots red blueClassName="ml-1" />);
		expect(bluePing()).toBe(blue);

		view.rerender(<Dots red={false} blueClassName="ml-1" />);
		expect(redPing()).toBeNull();
		expect(bluePing()).toBe(blue);

		const redEpoch = redPingTicker.getSnapshot();
		const spinnerEpoch = spinnerTicker.getSnapshot();
		act(() => {
			jest.advanceTimersByTime(30_000);
		});
		expect(redPingTicker.getSnapshot()).toBe(redEpoch);
		expect(spinnerTicker.getSnapshot() - spinnerEpoch).toBe(375);

		stopSpinner();
		view.unmount();
		act(() => {
			jest.advanceTimersByTime(30_000);
		});
		expect(redPingTicker.getSnapshot()).toBe(redEpoch);
		expect(spinnerTicker.getSnapshot() - spinnerEpoch).toBe(375);
	});
});
