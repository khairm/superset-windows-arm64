import { installTerminalWheelEventHandler } from "@superset/shared/terminal-wheel-handler";
import { FitAddon } from "@xterm/addon-fit";
import type { ProgressAddon } from "@xterm/addon-progress";
import type { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as XTerm } from "@xterm/xterm";
import { DEFAULT_TERMINAL_SCROLLBACK } from "shared/constants";
import {
	applyTerminalFontFamilyCssVariable,
	type TerminalAppearance,
} from "./appearance";
import { scheduleFontSettleRefit } from "./font-settle";
import {
	cancelParserIdleWork,
	createParserIdleGate,
	type ParserIdleGate,
	runWhenParserIdle,
	wrapWrite,
} from "./parser-idle-gate";
import { loadAddons } from "./terminal-addons";
import { installImagePasteFallback } from "./terminal-image-paste-fallback";
import { installTerminalKeyEventHandler } from "./terminal-key-event-handler";
import { getTerminalParkingContainer } from "./terminal-parking";

const SERIALIZE_SCROLLBACK = 1000;
const STORAGE_KEY_PREFIX = "terminal-buffer:";
const DIMS_KEY_PREFIX = "terminal-dims:";
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const RESIZE_DEBOUNCE_MS = 75;

export interface TerminalRuntime {
	terminalId: string;
	terminal: XTerm;
	fitAddon: FitAddon;
	serializeAddon: SerializeAddon;
	searchAddon: SearchAddon | null;
	progressAddon: ProgressAddon | null;
	wrapper: HTMLDivElement;
	container: HTMLDivElement | null;
	gate: ParserIdleGate;
	resizeObserver: ResizeObserver | null;
	_disposeResizeObserver: (() => void) | null;
	lastCols: number;
	lastRows: number;
	_disposeAddons: (() => void) | null;
	_disposeImagePasteFallback: (() => void) | null;
}

function createTerminal(
	cols: number,
	rows: number,
	appearance: TerminalAppearance,
): {
	terminal: XTerm;
	fitAddon: FitAddon;
	serializeAddon: SerializeAddon;
} {
	const fitAddon = new FitAddon();
	const serializeAddon = new SerializeAddon();
	const terminal = new XTerm({
		cols,
		rows,
		cursorBlink: true,
		fontFamily: appearance.fontFamily,
		fontSize: appearance.fontSize,
		theme: appearance.theme,
		allowProposedApi: true,
		scrollback: DEFAULT_TERMINAL_SCROLLBACK,
		macOptionIsMeta: false,
		cursorStyle: "block",
		cursorInactiveStyle: "outline",
		vtExtensions: { kittyKeyboard: true },
		scrollbar: { showScrollbar: false },
	});
	terminal.loadAddon(fitAddon);
	terminal.loadAddon(serializeAddon);
	// [WISPR-DIAG v2] Renderer instrumentation to diagnose why Wispr Flow's UIA
	// injection silently no-ops into the xterm terminal while keyboard + Ctrl+V
	// (and Wispr into the search popup / tab-title input) all work. Logging only,
	// no behaviour change. All lines are [agent-dots] [wispr-diag] -prefixed so the
	// (W.1) main.ts console-message forwarder persists them to electron-log main.log.
	//
	// Three probes:
	//   (1) Per xterm <textarea>: every input/composition/key/focus event, snapshotted
	//       SYNCHRONOUSLY + at microtask + at requestAnimationFrame, so we see whether
	//       xterm clears an injected value before Wispr's read-back probe can see it.
	//   (2) A value-setter hook on the textarea logging old/new + a stack trace, to
	//       attribute exactly WHO clears the value (xterm's _onData reset vs Wispr).
	//   (3) A document-level focusin UIA-profile scanner (installed once) that dumps
	//       role/aria-*/contentEditable/rect/computed-style/parent-chain for ANY focused
	//       element — lets us diff a WORKING Wispr target (search input) against the
	//       xterm textarea that fails.
	(function installWisprDiag() {
		const tryAttach = () => {
			const el = (terminal as any).element as HTMLElement | undefined;
			if (!el) { setTimeout(tryAttach, 50); return; }
			const ta = el.querySelector("textarea") as HTMLTextAreaElement | null;
			if (!ta) { setTimeout(tryAttach, 50); return; }
			const rectOf = (node: Element) => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
			try {
				console.log("[agent-dots] [wispr-diag] textarea-init " + JSON.stringify({
					origin: "v2",
					screenReaderModeOption: (terminal as any).options?.screenReaderMode ?? null,
					role: ta.getAttribute("role"),
					ariaMultiline: ta.getAttribute("aria-multiline"),
					ariaLabel: ta.getAttribute("aria-label"),
					ariaHidden: ta.getAttribute("aria-hidden"),
					tabIndex: ta.tabIndex,
					contentEditable: ta.isContentEditable,
					readOnly: ta.readOnly,
					parentTag: ta.parentElement ? ta.parentElement.tagName : null,
					parentRole: ta.parentElement ? ta.parentElement.getAttribute("role") : null,
					rect: rectOf(ta),
				}));
			} catch (_e) { /* never block on logging */ }

			const snap = (phase: string, ev: any) => {
				try {
					const cs = getComputedStyle(ta);
					const r = ta.getBoundingClientRect();
					console.log("[agent-dots] [wispr-diag] ta-event " + JSON.stringify({
						origin: "v2",
						phase,
						type: ev ? ev.type : null,
						inputType: ev && "inputType" in ev ? ev.inputType : null,
						data: ev && "data" in ev ? ev.data : null,
						isComposing: ev && "isComposing" in ev ? ev.isComposing : null,
						isTrusted: ev ? ev.isTrusted : null,
						keyCode: ev && "keyCode" in ev ? ev.keyCode : null,
						code: ev && "code" in ev ? ev.code : null,
						key: ev && "key" in ev ? ev.key : null,
						ctrlKey: ev && "ctrlKey" in ev ? ev.ctrlKey : null,
						altKey: ev && "altKey" in ev ? ev.altKey : null,
						metaKey: ev && "metaKey" in ev ? ev.metaKey : null,
						shiftKey: ev && "shiftKey" in ev ? ev.shiftKey : null,
						valueLen: ta.value.length,
						valueTail: ta.value.slice(-24),
						activeIsTa: document.activeElement === ta,
						visibility: cs.visibility,
						display: cs.display,
						opacity: cs.opacity,
						rectW: Math.round(r.width),
						rectH: Math.round(r.height),
					}));
				} catch (_e) { /* never block on logging */ }
			};
			const onEv = (ev: any) => {
				snap("sync", ev);
				queueMicrotask(() => snap("microtask", ev));
				requestAnimationFrame(() => snap("raf", ev));
			};
			const eventTypes = ["input", "beforeinput", "change", "keydown", "keypress", "keyup",
				"compositionstart", "compositionupdate", "compositionend", "focus", "blur"];
			for (const t of eventTypes) {
				ta.addEventListener(t, onEv, true);
			}

			// (2) Hook the value setter (pass-through) to attribute clears with a stack.
			try {
				const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
				if (desc && desc.get && desc.set && !(ta as any).__wisprValueHooked) {
					(ta as any).__wisprValueHooked = true;
					const getV = desc.get;
					const setV = desc.set;
					Object.defineProperty(ta, "value", {
						configurable: true,
						get() { return getV.call(this); },
						set(v) {
							const old = getV.call(this);
							setV.call(this, v);
							if (old !== v && (String(old).length > 0 || String(v).length > 0)) {
								try {
									console.log("[agent-dots] [wispr-diag] value-set " + JSON.stringify({
										origin: "v2",
										oldLen: String(old).length,
										oldTail: String(old).slice(-24),
										newLen: String(v).length,
										newTail: String(v).slice(-24),
										activeIsTa: document.activeElement === ta,
										stack: (new Error().stack || "").split("\n").slice(1, 6).join(" || "),
									}));
								} catch (_e) { /* never block on logging */ }
							}
						},
					});
				}
			} catch (_e) { /* never block on logging */ }
		};
		tryAttach();

		// (3) Global (install once across all terminals): focusin UIA-profile scanner.
		if (!(window as any).__wisprDiagGlobal) {
			(window as any).__wisprDiagGlobal = true;
			const profile = (node: Element | null): any => {
				if (!node) { return null; }
				const attrs: Record<string, string> = {};
				try {
					for (const a of Array.from(node.attributes)) {
						if (a.name === "role" || a.name.indexOf("aria-") === 0) { attrs[a.name] = a.value; }
					}
				} catch (_e) { /* ignore */ }
				let chain = "";
				let p: Element | null = node.parentElement;
				let depth = 0;
				while (p && depth < 6) {
					const role = p.getAttribute("role");
					const label = p.getAttribute("aria-label");
					chain += " > " + p.tagName + (role ? "[role=" + role + "]" : "") + (label ? "[aria-label=" + label + "]" : "");
					p = p.parentElement;
					depth++;
				}
				const cs = getComputedStyle(node);
				const r = node.getBoundingClientRect();
				return {
					tag: node.tagName,
					attrs,
					contentEditable: (node as any).isContentEditable ?? null,
					tabIndex: (node as any).tabIndex ?? null,
					inputType: (node as any).type ?? null,
					readOnly: (node as any).readOnly ?? null,
					rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
					visibility: cs.visibility,
					display: cs.display,
					opacity: cs.opacity,
					position: cs.position,
					chain,
				};
			};
			document.addEventListener("focusin", (e: any) => {
				try {
					console.log("[agent-dots] [wispr-diag] focusin " + JSON.stringify({
						origin: "v2",
						info: profile(e.target as Element),
					}));
				} catch (_e) { /* never block on logging */ }
			}, true);
			console.log("[agent-dots] [wispr-diag] global-focusin-scanner-installed");
		}
	})();

	return { terminal, fitAddon, serializeAddon };
}

function persistBuffer(terminalId: string, serializeAddon: SerializeAddon) {
	try {
		const data = serializeAddon.serialize({ scrollback: SERIALIZE_SCROLLBACK });
		localStorage.setItem(`${STORAGE_KEY_PREFIX}${terminalId}`, data);
	} catch {}
}

function restoreBuffer(terminalId: string, terminal: XTerm) {
	try {
		const data = localStorage.getItem(`${STORAGE_KEY_PREFIX}${terminalId}`);
		if (data) terminal.write(data);
	} catch {}
}

function clearPersistedBuffer(terminalId: string) {
	try {
		localStorage.removeItem(`${STORAGE_KEY_PREFIX}${terminalId}`);
	} catch {}
}

function persistDimensions(terminalId: string, cols: number, rows: number) {
	try {
		localStorage.setItem(
			`${DIMS_KEY_PREFIX}${terminalId}`,
			JSON.stringify({ cols, rows }),
		);
	} catch {}
}

function loadSavedDimensions(
	terminalId: string,
): { cols: number; rows: number } | null {
	try {
		const raw = localStorage.getItem(`${DIMS_KEY_PREFIX}${terminalId}`);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (typeof parsed.cols === "number" && typeof parsed.rows === "number") {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

function clearPersistedDimensions(terminalId: string) {
	try {
		localStorage.removeItem(`${DIMS_KEY_PREFIX}${terminalId}`);
	} catch {}
}

function hostIsVisible(container: HTMLDivElement | null): boolean {
	if (!container) return false;
	return container.clientWidth > 0 && container.clientHeight > 0;
}

function measureAndResize(
	runtime: TerminalRuntime,
	onResize?: () => void,
): void {
	if (!hostIsVisible(runtime.container)) return;
	const { terminal } = runtime;

	runWhenParserIdle(runtime.gate, () => {
		if (!hostIsVisible(runtime.container)) return;

		const buffer = terminal.buffer.active;
		const wasPinnedToBottom = buffer.viewportY >= buffer.baseY;
		const savedViewportY = buffer.viewportY;
		const prevCols = terminal.cols;
		const prevRows = terminal.rows;

		runtime.fitAddon.fit();
		runtime.lastCols = terminal.cols;
		runtime.lastRows = terminal.rows;

		if (wasPinnedToBottom) {
			terminal.scrollToBottom();
		} else {
			const targetY = Math.min(savedViewportY, terminal.buffer.active.baseY);
			if (terminal.buffer.active.viewportY !== targetY) {
				terminal.scrollToLine(targetY);
			}
		}

		terminal.refresh(0, Math.max(0, terminal.rows - 1));

		if (terminal.cols !== prevCols || terminal.rows !== prevRows) {
			onResize?.();
		}
	});
}

function createResizeScheduler(
	runtime: TerminalRuntime,
	onResize?: () => void,
): {
	observe: ResizeObserverCallback;
	dispose: () => void;
} {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const dispose = () => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	const run = () => {
		timeoutId = null;
		measureAndResize(runtime, onResize);
	};

	const observe: ResizeObserverCallback = (entries) => {
		if (
			entries.some(
				(entry) =>
					entry.contentRect.width <= 0 || entry.contentRect.height <= 0,
			)
		) {
			dispose();
			return;
		}
		dispose();
		timeoutId = setTimeout(run, RESIZE_DEBOUNCE_MS);
	};

	return { observe, dispose };
}

export function createRuntime(
	terminalId: string,
	appearance: TerminalAppearance,
	options: { initialBuffer?: string } = {},
): TerminalRuntime {
	const savedDims = loadSavedDimensions(terminalId);
	const cols = savedDims?.cols ?? DEFAULT_COLS;
	const rows = savedDims?.rows ?? DEFAULT_ROWS;

	const { terminal, fitAddon, serializeAddon } = createTerminal(
		cols,
		rows,
		appearance,
	);

	const gate = createParserIdleGate();
	terminal.write = wrapWrite(gate, terminal.write.bind(terminal));

	const wrapper = document.createElement("div");
	wrapper.style.width = "100%";
	wrapper.style.height = "100%";
	applyTerminalFontFamilyCssVariable(wrapper, appearance.fontFamily);
	terminal.open(wrapper);

	installTerminalKeyEventHandler(terminal);
	installTerminalWheelEventHandler(terminal);

	// Activate Unicode 11 widths (inside loadAddons) before restoring the buffer,
	// else CJK/emoji/ZWJ widths get baked wrong into the replay. (#3572)
	const addonsResult = loadAddons(terminal);
	if (options.initialBuffer !== undefined) {
		terminal.write(options.initialBuffer);
	} else {
		restoreBuffer(terminalId, terminal);
	}

	const disposeImagePasteFallback = installImagePasteFallback(
		terminal,
		wrapper,
	);

	return {
		terminalId,
		terminal,
		fitAddon,
		serializeAddon,
		searchAddon: addonsResult.searchAddon,
		progressAddon: addonsResult.progressAddon,
		wrapper,
		container: null,
		gate,
		resizeObserver: null,
		_disposeResizeObserver: null,
		lastCols: cols,
		lastRows: rows,
		_disposeAddons: addonsResult.dispose,
		_disposeImagePasteFallback: disposeImagePasteFallback,
	};
}

export function attachToContainer(
	runtime: TerminalRuntime,
	container: HTMLDivElement,
	onResize?: () => void,
	options: { focus?: boolean } = {},
) {
	// If we're already attached to this exact container, do nothing. Prevents
	// redundant refresh/fit from transient remounts during provider key
	// churn — VSCode setVisible() is idempotent for the same host element.
	const sameContainer =
		runtime.container === container &&
		runtime.wrapper.parentElement === container;
	if (sameContainer && runtime.resizeObserver) {
		return;
	}

	runtime.container = container;
	container.appendChild(runtime.wrapper);
	measureAndResize(runtime, onResize);
	scheduleFontSettleRefit(
		runtime.terminal,
		() => hostIsVisible(runtime.container),
		() => measureAndResize(runtime, onResize),
	);

	runtime._disposeResizeObserver?.();
	runtime._disposeResizeObserver = null;
	runtime.resizeObserver?.disconnect();
	const scheduler = createResizeScheduler(runtime, onResize);
	const observer = new ResizeObserver(scheduler.observe);
	observer.observe(container);
	runtime.resizeObserver = observer;
	runtime._disposeResizeObserver = scheduler.dispose;

	if (options.focus !== false) {
		runtime.terminal.focus();
	}
}

export function detachFromContainer(runtime: TerminalRuntime) {
	persistBuffer(runtime.terminalId, runtime.serializeAddon);
	persistDimensions(runtime.terminalId, runtime.lastCols, runtime.lastRows);
	runtime._disposeResizeObserver?.();
	runtime._disposeResizeObserver = null;
	runtime.resizeObserver?.disconnect();
	runtime.resizeObserver = null;
	cancelParserIdleWork(runtime.gate);
	// Park instead of .remove() so xterm survives the React unmount —
	// see getTerminalParkingContainer.
	getTerminalParkingContainer().appendChild(runtime.wrapper);
	runtime.container = null;
}

export function updateRuntimeAppearance(
	runtime: TerminalRuntime,
	appearance: TerminalAppearance,
	onResize?: () => void,
) {
	const { terminal } = runtime;
	terminal.options.theme = appearance.theme;

	const fontChanged =
		terminal.options.fontFamily !== appearance.fontFamily ||
		terminal.options.fontSize !== appearance.fontSize;

	if (fontChanged) {
		applyTerminalFontFamilyCssVariable(runtime.wrapper, appearance.fontFamily);
		terminal.options.fontFamily = appearance.fontFamily;
		terminal.options.fontSize = appearance.fontSize;
		measureAndResize(runtime, onResize);
		// The freshly-selected font may still be loading — schedule a follow-up
		// refit once it resolves so dimensions track the rendered glyphs.
		scheduleFontSettleRefit(
			runtime.terminal,
			() => hostIsVisible(runtime.container),
			() => measureAndResize(runtime, onResize),
		);
	}
}

export function disposeRuntime(
	runtime: TerminalRuntime,
	options: { clearPersistedState?: boolean } = {},
) {
	const clearPersistedState = options.clearPersistedState ?? true;
	if (!clearPersistedState) {
		persistBuffer(runtime.terminalId, runtime.serializeAddon);
		persistDimensions(runtime.terminalId, runtime.lastCols, runtime.lastRows);
	}
	runtime._disposeImagePasteFallback?.();
	runtime._disposeImagePasteFallback = null;
	runtime._disposeAddons?.();
	runtime._disposeAddons = null;
	runtime._disposeResizeObserver?.();
	runtime._disposeResizeObserver = null;
	runtime.resizeObserver?.disconnect();
	runtime.resizeObserver = null;
	cancelParserIdleWork(runtime.gate);
	runtime.container = null;
	runtime.wrapper.remove();
	runtime.terminal.dispose();
	if (clearPersistedState) {
		clearPersistedBuffer(runtime.terminalId);
		clearPersistedDimensions(runtime.terminalId);
	}
}
