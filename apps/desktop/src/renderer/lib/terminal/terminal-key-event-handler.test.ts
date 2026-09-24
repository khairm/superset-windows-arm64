import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import type { Terminal as XTerm } from "@xterm/xterm";
import * as hotkeys from "renderer/hotkeys";
import { createTerminalKeyEventHandler } from "./terminal-key-event-handler";

// (WISPR-QUIET) (AC)
const clipboardDescriptor = Object.getOwnPropertyDescriptor(
	navigator,
	"clipboard",
);
const readText = mock(async () => "dictated text");
let resolveHotkey: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
let errorLog: ReturnType<typeof spyOn>;

beforeEach(() => {
	readText.mockReset();
	readText.mockResolvedValue("dictated text");
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { readText },
	});
	resolveHotkey = spyOn(hotkeys, "resolveHotkeyFromEvent").mockReturnValue(
		null,
	);
	log = spyOn(console, "log").mockImplementation(() => {});
	errorLog = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	resolveHotkey.mockRestore();
	log.mockRestore();
	errorLog.mockRestore();
	if (clipboardDescriptor) {
		Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
	} else {
		Reflect.deleteProperty(navigator, "clipboard");
	}
});

function fixture(platform = "Win32") {
	const paste = mock(() => {});
	const input = mock(() => {});
	const terminal = {
		paste,
		input,
		hasSelection: () => false,
	} as unknown as XTerm;
	return {
		paste,
		input,
		handle: createTerminalKeyEventHandler(terminal, { platform }),
	};
}

function key(overrides: Partial<KeyboardEvent> = {}) {
	return {
		type: "keydown",
		key: "v",
		code: "",
		keyCode: 86,
		ctrlKey: true,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		preventDefault: mock(() => {}),
		...overrides,
	} as unknown as KeyboardEvent;
}

describe("Windows synthetic paste", () => {
	for (const overrides of [
		{},
		{ key: "Unidentified" },
		{ key: "V", keyCode: 0 },
	]) {
		test(`pastes synthetic Ctrl+V without logging ${JSON.stringify(overrides)}`, async () => {
			const { handle, paste, input } = fixture();
			const event = key(overrides);
			expect(handle(event)).toBe(false);
			expect(event.preventDefault).toHaveBeenCalledTimes(1);
			await Promise.resolve();
			expect(readText).toHaveBeenCalledTimes(1);
			expect(paste).toHaveBeenCalledWith("dictated text");
			expect(input).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
			expect(errorLog).not.toHaveBeenCalled();
		});
	}

	test("leaves manual Ctrl+V to the browser paste event", () => {
		const { handle, paste } = fixture();
		const event = key({ code: "KeyV" });
		expect(handle(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
		expect(paste).not.toHaveBeenCalled();
	});

	test("does not repeat paste on keyup", () => {
		const { handle } = fixture();
		const event = key({ type: "keyup" });
		expect(handle(event)).toBe(false);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(readText).not.toHaveBeenCalled();
	});

	test("reports clipboard read failures with the actual error", async () => {
		const error = new Error("Clipboard access denied");
		readText.mockRejectedValue(error);
		const { handle, paste } = fixture();
		expect(handle(key())).toBe(false);
		await Promise.resolve();
		expect(errorLog).toHaveBeenCalledWith(
			"[terminal] Clipboard read failed",
			error,
		);
		expect(paste).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	test("does not send an empty clipboard to the terminal", async () => {
		readText.mockResolvedValue("");
		const { handle, paste } = fixture();
		handle(key());
		await Promise.resolve();
		expect(paste).not.toHaveBeenCalled();
		expect(errorLog).not.toHaveBeenCalled();
	});

	test("does not intercept other platforms or modified chords", () => {
		for (const platform of ["Linux", "darwin"]) {
			expect(fixture(platform).handle(key())).toBe(true);
		}
		for (const modifiers of [
			{ altKey: true },
			{ metaKey: true },
			{ ctrlKey: false },
		]) {
			expect(fixture().handle(key(modifiers))).toBe(true);
		}
		expect(readText).not.toHaveBeenCalled();
	});
});
