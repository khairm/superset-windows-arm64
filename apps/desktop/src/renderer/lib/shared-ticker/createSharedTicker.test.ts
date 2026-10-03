import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createSharedTicker } from "./createSharedTicker";
import { redPingTicker, spinnerTicker } from "./tickers";

describe("createSharedTicker", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("starts one interval on the first subscriber and shares it and its epoch", () => {
		const ticker = createSharedTicker(80);
		expect(jest.getTimerCount()).toBe(0);

		let aTicks = 0;
		let bTicks = 0;
		const stopA = ticker.subscribe(() => aTicks++);
		expect(jest.getTimerCount()).toBe(1);
		const stopB = ticker.subscribe(() => bTicks++);
		expect(jest.getTimerCount()).toBe(1);

		jest.advanceTimersByTime(80);
		expect(ticker.getSnapshot()).toBe(1);
		expect(aTicks).toBe(1);
		expect(bTicks).toBe(1);

		stopA();
		expect(jest.getTimerCount()).toBe(1);
		jest.advanceTimersByTime(80);
		expect(ticker.getSnapshot()).toBe(2);
		expect(aTicks).toBe(1);
		expect(bTicks).toBe(2);

		stopB();
	});

	it("clears the interval on the last unsubscribe", () => {
		const ticker = createSharedTicker(80);
		const stopA = ticker.subscribe(() => {});
		const stopB = ticker.subscribe(() => {});
		jest.advanceTimersByTime(80);

		stopA();
		stopB();
		expect(jest.getTimerCount()).toBe(0);
		jest.advanceTimersByTime(800);
		expect(ticker.getSnapshot()).toBe(1);
	});

	it("survives StrictMode's subscribe, unsubscribe, resubscribe order", () => {
		const ticker = createSharedTicker(80);
		let ticks = 0;
		const onTick = () => ticks++;

		ticker.subscribe(onTick)();
		expect(jest.getTimerCount()).toBe(0);
		const stop = ticker.subscribe(onTick);
		expect(jest.getTimerCount()).toBe(1);

		jest.advanceTimersByTime(80);
		expect(ticks).toBe(1);
		expect(ticker.getSnapshot()).toBe(1);

		stop();
		expect(jest.getTimerCount()).toBe(0);
	});

	it("runs the 80 ms and 30 s tickers independently", () => {
		const spinnerStart = spinnerTicker.getSnapshot();
		const redStart = redPingTicker.getSnapshot();
		const stopSpinner = spinnerTicker.subscribe(() => {});
		const stopRed = redPingTicker.subscribe(() => {});
		expect(jest.getTimerCount()).toBe(2);

		jest.advanceTimersByTime(30_000);
		expect(spinnerTicker.getSnapshot() - spinnerStart).toBe(375);
		expect(redPingTicker.getSnapshot() - redStart).toBe(1);

		stopRed();
		expect(jest.getTimerCount()).toBe(1);
		jest.advanceTimersByTime(30_000);
		expect(spinnerTicker.getSnapshot() - spinnerStart).toBe(750);
		expect(redPingTicker.getSnapshot() - redStart).toBe(1);

		stopSpinner();
		expect(jest.getTimerCount()).toBe(0);
	});
});
