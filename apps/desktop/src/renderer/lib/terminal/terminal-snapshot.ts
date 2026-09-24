import type { SerializeAddon } from "@xterm/addon-serialize";
import type { IBuffer, Terminal } from "@xterm/xterm";

// (ALT-SNAPSHOT-RESTORE)
type SnapshotTerminal = Pick<Terminal, "buffer" | "parser">;
type AlternateMode = 47 | 1047 | 1049;
const alternateModes = new WeakMap<SnapshotTerminal, AlternateMode | null>();

function isAlternateMode(mode: number | number[]): mode is AlternateMode {
	return mode === 47 || mode === 1047 || mode === 1049;
}

export function trackTerminalScreen(terminal: SnapshotTerminal): void {
	if (alternateModes.has(terminal)) return;
	alternateModes.set(terminal, null);
	terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
		if (terminal.buffer.active.type !== "normal") return false;
		const entered = params.find(isAlternateMode);
		if (entered !== undefined) alternateModes.set(terminal, entered);
		return false;
	});
	terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
		if (params.some(isAlternateMode)) alternateModes.set(terminal, null);
		return false;
	});
}

function requireAlternateMode(terminal: SnapshotTerminal): AlternateMode {
	const mode = alternateModes.get(terminal);
	if (mode === undefined || mode === null) {
		throw new Error("Missing xterm alternate-screen mode");
	}
	return mode;
}

export function getTerminalScreen(
	terminal: SnapshotTerminal,
): "normal" | "alternate" | "alternate-1049" {
	if (terminal.buffer.active.type === "normal") return "normal";
	return requireAlternateMode(terminal) === 1049
		? "alternate-1049"
		: "alternate";
}

interface TerminalWithCore {
	_core: {
		_inputHandler: { _curAttrData: object };
		_bufferService: {
			buffers: {
				normal: {
					savedCurAttrData: object;
					savedX: number;
					savedY: number;
					ybase: number;
				};
			};
		};
	};
}

interface BufferSerializer {
	_terminal: Terminal;
	_serializeBufferByScrollback(
		terminal: Terminal,
		buffer: IBuffer,
		scrollback?: number,
	): string;
}

export function preserveSnapshotShellRendition(addon: SerializeAddon): void {
	const serializer = addon as unknown as BufferSerializer;
	const serializeBuffer = serializer._serializeBufferByScrollback;
	if (typeof serializeBuffer !== "function" || !serializer._terminal) {
		throw new Error("Unsupported xterm snapshot serializer");
	}
	trackTerminalScreen(serializer._terminal);
	const serialize = addon.serialize;
	addon.serialize = function (options) {
		const content = serialize.call(this, options);
		if (
			options?.excludeAltBuffer ||
			serializer._terminal.buffer.active.type === "normal"
		) {
			return content;
		}
		const mode = requireAlternateMode(serializer._terminal);
		const boundary = "\x1b[?1049h\x1b[H";
		if (!content.includes(boundary))
			throw new Error("Unsupported xterm alternate snapshot");
		return content.replace(boundary, `\x1b[?${mode}h\x1b[H`);
	};
	serializer._serializeBufferByScrollback = function (
		term,
		buffer,
		scrollback,
	) {
		if (buffer.type === "alternate") {
			return `\x1b[0m${serializeBuffer.call(this, term, buffer, scrollback)}`;
		}
		if (term.buffer.active.type !== "alternate") {
			return serializeBuffer.call(this, term, buffer, scrollback);
		}
		const core = (term as unknown as TerminalWithCore)._core;
		const normal = core._bufferService.buffers.normal;
		if (!normal.savedCurAttrData)
			throw new Error("Missing xterm saved shell rendition");
		const handler = core._inputHandler;
		const current = handler._curAttrData;
		try {
			handler._curAttrData = normal.savedCurAttrData;
			const content = serializeBuffer.call(this, term, buffer, scrollback);
			const savedRow = Math.min(
				term.rows - 1,
				Math.max(0, normal.savedY - normal.ybase),
			);
			const savedCol = Math.min(term.cols - 1, normal.savedX);
			const savedCursor = `\x1b[${savedRow + 1};${savedCol + 1}H`;
			return getTerminalScreen(term) === "alternate-1049"
				? content + savedCursor
				: `${content}${savedCursor}\x1b7\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
		} finally {
			handler._curAttrData = current;
		}
	};
}
