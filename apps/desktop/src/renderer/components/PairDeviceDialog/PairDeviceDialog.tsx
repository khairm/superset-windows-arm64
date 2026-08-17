import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { ModeToggle } from "./components/ModeToggle";
import { QrCode } from "./components/QrCode";
import { PAIRING_MODES, type PairingMode } from "./pairing-modes";

interface PairDeviceDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The LOCAL host-service. Pairing is an act performed AT the machine — the QR
	 * advertises the private address of whichever machine runs the bridge, and the
	 * typed code is minted by that machine's bridge — so a relayed host would hand
	 * out a credential for the wrong computer.
	 */
	hostUrl: string;
}

/**
 * (COMPANION-PAIRING-UI) The desktop half of §4 pairing: the phone tells the
 * user to "open Superset and choose 'Pair a device'", and this is that.
 *
 * TWO WAYS IN, and the second one exists because the first has a hard
 * prerequisite the user's network may simply refuse:
 *
 *  - QR (§4.1-4.8). The phone scans, and the exchange happens on the LAN.
 *    Requires the phone to be able to reach this machine's private address.
 *  - CODE `(REMOTE-CODE-PAIRING)` (§4.9). The desktop shows 8 digits, the user
 *    types them into the phone, and the SAME exchange happens over the tunnel.
 *    Works from anywhere, including a network that blocks phone -> PC traffic
 *    and therefore makes the QR flow impossible.
 *
 * THE SECRET IS THE SAME SECRET IN BOTH MODES. The QR URI's fragment carries a
 * 256-bit code and the code mode carries 8 digits, and both are the only thing
 * standing between an attacker and a paired device (§4.7 / §4.9). They live in
 * ONE place — `phase.secret` inside the flow component below — and that
 * component is unmounted the moment the dialog closes, so the value has no path
 * to a store, to disk, or to a later render. Neither is ever logged or put in an
 * attribute. The QR is never drawn as text (a screenshot of a QR is a screenshot
 * of something that expires in 120 seconds, while a screenshot of the string is
 * a code someone can retype); the 8 digits ARE drawn as text, because the user
 * has to read them, and they are correspondingly shorter-lived in every other
 * respect — never selectable, never copied anywhere, gone with the dialog.
 */
export function PairDeviceDialog({
	open,
	onOpenChange,
	hostUrl,
}: PairDeviceDialogProps) {
	/**
	 * Which way in. Lives HERE rather than in the flow so the description can
	 * change with it — and it is not a secret, unlike everything the flow holds.
	 */
	const [mode, setMode] = useState<PairingMode>("qr");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Pair a device</DialogTitle>
					<DialogDescription>
						{PAIRING_MODES[mode].description}
					</DialogDescription>
				</DialogHeader>
				<ModeToggle mode={mode} onModeChange={setMode} />
				{/* Unmounting is what destroys the pairing secret; do not hoist this.
				    Keyed on the mode so switching starts a clean flow rather than
				    leaving the previous mode's countdown running underneath. */}
				{open && (
					<PairingFlow
						key={mode}
						mode={mode}
						hostUrl={hostUrl}
						onClose={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * The one live secret, in the one shape the renderer ever holds it in.
 *
 * A union, so a QR render cannot accidentally be handed a code (or the reverse)
 * and silently draw nothing. It carries NO mode tag: `PairingFlow` is keyed on
 * the mode and remounts when it changes, so the mode is already a prop of the
 * only component that holds this, and a second copy could only ever disagree
 * with it. The two members are told apart structurally.
 */
type PairingSecret = { qrUri: string } | { code: string };

type PairingPhase =
	| { kind: "opening" }
	| { kind: "open"; secret: PairingSecret; expiresAtMs: number }
	/**
	 * The countdown reached zero, so the secret is dead and dropped — but the
	 * OUTCOME is the host-service's to state, not ours. A local clock saying
	 * "120 s elapsed" cannot tell an expiry from a pairing that landed a moment
	 * before it, which is exactly the bug this phase exists to stop.
	 */
	| { kind: "closing"; expiresAtMs: number }
	| { kind: "closed-early" }
	| { kind: "expired" }
	/**
	 * `title` is carried rather than hard-coded at the render site: this phase is
	 * now reached from three different places (the open failed, the window went
	 * missing, the verdict became unreadable) and heading all three "Could not
	 * open a pairing window" would misdescribe two of them.
	 */
	| { kind: "failed"; title: string; message: string };

/** The window is 120 s; a second's resolution on the verdict is plenty. */
const PAIRING_STATE_POLL_MS = 1_000;

/**
 * The bridge allows ONE pairing window per process — of EITHER kind — so two
 * overlapping window operations can produce a close that lands after a later
 * open and silently takes the new window down. Chaining every call removes that
 * by construction: a close started when the dialog closed (or when the user
 * switched modes) always finishes before the open of the window that replaces
 * it.
 */
let pairingOperations: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
	const next = pairingOperations.then(operation, operation);
	// The chain must survive a rejection, or one failure wedges every later call.
	pairingOperations = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `12345678` -> `1234-5678`. Presentation only; the digits are what is typed. */
function groupCode(code: string): string {
	const half = Math.ceil(code.length / 2);
	return `${code.slice(0, half)}-${code.slice(half)}`;
}

function PairingFlow({
	mode,
	hostUrl,
	onClose,
}: {
	mode: PairingMode;
	hostUrl: string;
	onClose: () => void;
}) {
	const [phase, setPhase] = useState<PairingPhase>({ kind: "opening" });
	// QUANTIZED, not raw milliseconds. The tick has to stay fast so the window can
	// close promptly, but the only thing rendered is whole seconds — storing the raw
	// remainder re-rendered the dialog (QR included) four times per displayed second
	// with identical output. An unchanged integer makes React bail out instead.
	const [secondsLeft, setSecondsLeft] = useState(0);
	// Guards against a response landing after unmount, which would both set state
	// on a dead component and resurrect a pairing secret we just discarded.
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// `useCallback` keyed on `hostUrl` and `mode` alone, matching the mount effect
	// below: a fresh identity every render would make that effect re-run and open
	// a second window the first one still holds.
	const openWindow = useCallback((): void => {
		setPhase({ kind: "opening" });
		void serialize(async () => {
			const client = getHostServiceClientByUrl(hostUrl);
			// Close first: our countdown and the server's timer expire at the same
			// instant, so a "Show a new code" click moments later can otherwise race
			// a window the server has not finished retiring and be refused as
			// "already open". Closing something already closed is a stated no-op.
			await client.companion.closePairing.mutate();
			if (mode === "code") {
				const handle = await client.companion.openRemotePairing.mutate();
				return {
					secret: { code: handle.code },
					expiresAtMs: handle.expiresAtMs,
				};
			}
			const handle = await client.companion.openPairing.mutate();
			return {
				secret: { qrUri: handle.qrUri },
				expiresAtMs: handle.expiresAtMs,
			};
		}).then(
			(opened) => {
				if (!mounted.current) return;
				// Seeded here so the first paint already shows the real countdown
				// rather than 0 for one tick, in the same quantized whole seconds the
				// tick uses.
				setSecondsLeft(
					Math.max(0, Math.ceil((opened.expiresAtMs - Date.now()) / 1000)),
				);
				setPhase({
					kind: "open",
					secret: opened.secret,
					expiresAtMs: opened.expiresAtMs,
				});
			},
			(error: unknown) => {
				if (!mounted.current) return;
				setPhase({
					kind: "failed",
					title: "Could not open a pairing window.",
					message: describe(error),
				});
			},
		);
	}, [hostUrl, mode]);

	// Opens on mount, and takes the window down on unmount — the user who
	// dismissed the dialog should not leave 0.0.0.0:47611 accepting pairing
	// attempts, or a live code answering `/v1/pair/*`, for the rest of the window.
	useEffect(() => {
		openWindow();
		return () => {
			void serialize(() =>
				getHostServiceClientByUrl(hostUrl).companion.closePairing.mutate(),
			).catch((error: unknown) => {
				// The dialog is gone, so there is nobody to tell; the window still
				// expires on its own 120 s timer. Never silent, though.
				console.error(
					"(COMPANION-PAIRING-UI) closing the pairing window failed",
					describe(error),
				);
			});
		};
	}, [hostUrl, openWindow]);

	const expiresAtMs = phase.kind === "open" ? phase.expiresAtMs : null;
	useEffect(() => {
		if (expiresAtMs === null) return;
		const tick = (): void => {
			const left = expiresAtMs - Date.now();
			setSecondsLeft(Math.max(0, Math.ceil(left / 1000)));
			// Hands over to the server rather than declaring the outcome: at this
			// instant the secret is certainly dead, and which way it died is a fact
			// only the bridge holds.
			if (left <= 0) setPhase({ kind: "closing", expiresAtMs });
		};
		// Still 250 ms: the DISPLAY only needs 1 Hz, but the handover above must not
		// wait up to a second after the window has actually expired.
		const timer = setInterval(tick, 250);
		tick();
		return () => clearInterval(timer);
	}, [expiresAtMs]);

	/**
	 * THE VERDICT. `pairingState` is read-only — it never opens or closes a
	 * window — so polling it cannot disturb the one being reported on, and it is
	 * deliberately NOT put through `serialize`: that chain exists to stop two
	 * window OPERATIONS overlapping, and a read has no business waiting behind a
	 * close or delaying one.
	 *
	 * Runs through `closing` as well as `open`, because the pairing this is
	 * looking for can land in the last second of the window.
	 */
	const trackedExpiresAtMs =
		phase.kind === "open" || phase.kind === "closing"
			? phase.expiresAtMs
			: null;
	useEffect(() => {
		if (trackedExpiresAtMs === null) return;
		let cancelled = false;
		let inFlight = false;
		const poll = (): void => {
			// A stalled read must not queue a second one behind it.
			if (inFlight) return;
			inFlight = true;
			getHostServiceClientByUrl(hostUrl)
				.companion.pairingState.query()
				.then(
					(state) => {
						inFlight = false;
						if (cancelled || !mounted.current) return;
						if (state.kind === "none") {
							// We are holding a window the host-service does not have. The
							// only ways here are a bridge restart or a close from outside
							// this dialog; both mean the secret on screen is dead, and saying
							// so is better than counting down against nothing.
							setPhase({
								kind: "failed",
								title: "The pairing window is gone.",
								message:
									"The host-service no longer has it — the companion bridge restarted, or the window was closed from somewhere else.",
							});
							return;
						}
						// A verdict about a window that is not the one on screen (a stale
						// response that crossed a reopen, or the window the OTHER mode
						// just replaced) decides nothing here.
						if (state.expiresAtMs !== trackedExpiresAtMs) return;
						if (state.pairingKind !== PAIRING_MODES[mode].pairingKind) return;
						if (state.kind === "open") return;
						setPhase(
							state.kind === "closed-early"
								? { kind: "closed-early" }
								: { kind: "expired" },
						);
					},
					(error: unknown) => {
						inFlight = false;
						if (cancelled || !mounted.current) return;
						// The bridge lives inside the host-service this call just failed to
						// reach, so a failure here is the window being unreachable, not a
						// blip to ride out. Never keep counting down as if all were well.
						setPhase({
							kind: "failed",
							title: "Could not check the pairing window.",
							message: describe(error),
						});
					},
				);
		};
		const timer = setInterval(poll, PAIRING_STATE_POLL_MS);
		poll();
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [trackedExpiresAtMs, hostUrl, mode]);

	if (phase.kind === "opening") {
		return (
			<div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
				<LuLoaderCircle className="size-4 animate-spin" />
				Opening a pairing window…
			</div>
		);
	}

	if (phase.kind === "failed") {
		return (
			<>
				<div className="py-4">
					<p className="text-sm font-medium">{phase.title}</p>
					<p className="mt-1 text-sm text-muted-foreground select-text cursor-text">
						{phase.message}
					</p>
				</div>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Close
					</Button>
					<Button type="button" onClick={openWindow}>
						Try again
					</Button>
				</DialogFooter>
			</>
		);
	}

	if (phase.kind === "closing") {
		return (
			<div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
				<LuLoaderCircle className="size-4 animate-spin" />
				Finishing up…
			</div>
		);
	}

	if (phase.kind === "closed-early") {
		return (
			<>
				<div className="py-4">
					<p className="text-sm font-medium">The pairing window closed.</p>
					<p className="mt-1 text-sm text-muted-foreground">
						It ended before its 120 seconds were up, which is what a completed
						pairing does — your phone will be showing the result. A window also
						closes early if repeated bad attempts burn the code, so if your
						phone did not confirm, show a new one.
					</p>
				</div>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Close
					</Button>
					<Button type="button" onClick={openWindow}>
						Show a new code
					</Button>
				</DialogFooter>
			</>
		);
	}

	if (phase.kind === "expired") {
		return (
			<>
				<div className="py-4">
					<p className="text-sm font-medium">This code has expired.</p>
					<p className="mt-1 text-sm text-muted-foreground">
						A pairing window lasts 120 seconds and works once. If your phone
						finished in time it will say so on its own screen — otherwise show a
						new code and try again.
					</p>
				</div>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Close
					</Button>
					<Button type="button" onClick={openWindow}>
						Show a new code
					</Button>
				</DialogFooter>
			</>
		);
	}

	const minutes = Math.floor(secondsLeft / 60);
	const seconds = secondsLeft % 60;

	return (
		<>
			<div className="flex flex-col items-center gap-3 py-2">
				{"qrUri" in phase.secret ? (
					<div className="rounded-lg bg-white p-3">
						<QrCode
							value={phase.secret.qrUri}
							label="Pairing QR code for Superset Companion"
							className="size-56"
						/>
					</div>
				) : (
					<div className="flex flex-col items-center gap-2 py-6">
						{/* Read aloud and typed, never copied: no `select-text` here, and
						    the grouping is presentation — the phone takes the 8 digits. */}
						<p className="text-4xl font-semibold tabular-nums tracking-[0.2em]">
							{groupCode(phase.secret.code)}
						</p>
						<p className="text-xs text-muted-foreground">
							Type this into Superset Companion on your phone.
						</p>
					</div>
				)}
				<p
					className="text-sm tabular-nums text-muted-foreground"
					aria-live="polite"
				>
					Expires in {minutes}:{String(seconds).padStart(2, "0")}
				</p>
			</div>
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onClose}>
					Cancel
				</Button>
			</DialogFooter>
		</>
	);
}
