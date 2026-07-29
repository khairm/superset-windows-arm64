/**
 * (COMPANION-BRIDGE) — the answer-wide lease (§11.4) and the per-terminal
 * critical section (§11.3).
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEASE COVERS THE WHOLE ANSWER AND NOT EACH KEYSTROKE
 * ---------------------------------------------------------------------------
 * ONE answer holds ONE lease for its entire keystroke sequence. A second device
 * attempting the same question is REFUSED outright — never queued, never
 * serialised behind the first.
 *
 * The failure that forces this, stated precisely: in a multi-select question
 * digits TOGGLE. Phone answering {1,2} while the watch answers {1,3} interleaves
 * as 1 -> 1 -> 2 -> 3 under PERFECTLY SERIALISED, individually-locked
 * keystrokes. That toggles option 1 on and then off again and leaves {2,3} — an
 * answer NEITHER device chose, with every guard passing before every single
 * byte. Per-keystroke locking produces a correct-looking audit log and a wrong
 * answer. Only an answer-wide lease prevents it.
 *
 * Queueing the second device would be the same bug with extra latency: by the
 * time the queue drained, the first answer would have submitted and the picker
 * would be gone, so the queued digits would land in the composer. Hence: refused
 * immediately, `409 lease_held`, no `retryAfterMs` that invites a poll-and-
 * pounce.
 *
 * ---------------------------------------------------------------------------
 * WHY EXTENDING A LEASE MUST BE ABLE TO FAIL
 * ---------------------------------------------------------------------------
 * A lease has a TTL, so it can lapse mid-sequence (a slow screen snapshot is
 * enough). If `extend` silently resurrected a lapsed lease, device A could keep
 * typing into a question device B has meanwhile taken over — exactly the
 * interleaving the lease exists to prevent, reintroduced by the renewal path.
 * `extend` therefore returns an explicit result and the injector STOPS on
 * anything other than `ok`.
 */

import { randomBytes } from "node:crypto";

import { LIMITS } from "./config";
import type {
	AnswerLease,
	DeviceId,
	DurationMs,
	EpochMs,
	LeaseId,
	QuestionId,
	Surface,
	TerminalId,
} from "./types";

// ---------------------------------------------------------------------------
// the answer-wide lease
// ---------------------------------------------------------------------------

/**
 * The result of an implicit acquisition, for either lease kind.
 *
 * `heldBy` is the lease that refused this one — never a queue position. A
 * caller's only options are to report the refusal or to wait for `expiresInMs`
 * and try again; there is deliberately nothing here that offers a slot.
 */
type AcquisitionOf<L extends { expiresAtMs: EpochMs }> =
	| { ok: true; lease: L }
	| { ok: false; heldBy: L; expiresInMs: DurationMs };

export type LeaseAcquisition = AcquisitionOf<AnswerLease>;

/**
 * (MESSAGE-LEASE) The `/v1/message` counterpart, keyed by TERMINAL rather than
 * by question.
 *
 * Bridge-internal, so it is declared here and not in `types.ts`: nothing about it
 * appears on the wire, and PROTOCOL §7.5 does not name it.
 *
 * Why a message needs a lease at all, given the per-terminal lock already
 * serialises writes. The lock QUEUES; it does not refuse. Two devices sending at
 * once therefore both land, one straight after the other, and the second arrives
 * at an agent that the first has already set running — which is the composer
 * steering case, not a harmless duplicate. Worse, the send is no longer one act:
 * the text is framed in, the screen is re-read to prove a composer consumed it,
 * and only then is the submit written. A second device queued behind that
 * sequence would be typing into a composer that already holds someone else's
 * half-sent message. §11.4's reasoning for the answer lease applies unchanged, so
 * the second device is REFUSED (`409 lease_held`), never queued.
 */
export interface MessageLease {
	leaseId: LeaseId;
	terminalId: TerminalId;
	deviceId: DeviceId;
	surface: Surface;
	acquiredAtMs: EpochMs;
	expiresAtMs: EpochMs;
}

export type MessageLeaseAcquisition = AcquisitionOf<MessageLease>;

/**
 * The result of renewing. Anything other than `ok` means this answer no longer
 * owns the question and MUST NOT write another byte.
 *
 * Generic only so the one keyed-lease table below can return it for either kind;
 * the default is the answer lease, which is the only kind whose registry exposes
 * `extend` at all.
 */
export type LeaseExtension<L = AnswerLease> =
	| { ok: true; lease: L }
	/** The TTL lapsed. Another device may already hold the question. */
	| { ok: false; reason: "expired" }
	/** Released by this answer's own completion/failure path, or never held. */
	| { ok: false; reason: "released" }
	/** The question is held under a DIFFERENT leaseId now. */
	| { ok: false; reason: "taken_over" };

export interface LeaseRegistry {
	/** Implicit acquisition by the first `/v1/answer` for a questionId. */
	acquire(input: {
		questionId: QuestionId;
		deviceId: DeviceId;
		surface: Surface;
		nowMs: EpochMs;
	}): LeaseAcquisition;
	/**
	 * Extends to `now + answerLeaseTtlMs` after each successful keystroke.
	 *
	 * NOTE: this deliberately returns a result rather than `void`. A renewal that
	 * cannot succeed is the signal to abandon the sequence, and a `void` renewal
	 * would hide it.
	 */
	extend(leaseId: LeaseId, nowMs: EpochMs): LeaseExtension;
	/** Released on `confirmed`, on any `guard_failed`, and on TTL expiry. */
	release(leaseId: LeaseId): void;

	/**
	 * (MESSAGE-LEASE) Implicit acquisition by the first `/v1/message` for a
	 * terminal. A second device is REFUSED, never queued — see `MessageLease`.
	 *
	 * There is deliberately no `extendMessage`: a message send is bounded by the
	 * terminal lock's own timeout plus one screen-advance wait, and a renewal
	 * point would be an invitation to hold the terminal open indefinitely. If the
	 * TTL lapses mid-send the lock still serialises the bytes; what lapses is only
	 * the refusal of a second device, and that is stated rather than hidden.
	 *
	 * The shared table underneath CAN extend — it is the same code the answer
	 * lease uses — so the absence is enforced here, at the registry surface: the
	 * message instance's `extend` is simply never exposed. Do not widen this
	 * interface to reach it.
	 */
	acquireMessage(input: {
		terminalId: TerminalId;
		deviceId: DeviceId;
		surface: Surface;
		nowMs: EpochMs;
	}): MessageLeaseAcquisition;
	/** Released on every exit path of `/v1/message`, success or failure. */
	releaseMessage(leaseId: LeaseId): void;

	/**
	 * Drops lapsed leases of BOTH kinds. Returns how many.
	 *
	 * Expiry is otherwise LAZY — `acquire`/`acquireMessage` evict a lapsed lease
	 * only when the same key is looked up again — so a question or terminal that
	 * is never revisited keeps its record until the process exits. This is what
	 * bounds that, and it is wired into the bridge's hourly maintenance interval
	 * in `index.ts`. It is housekeeping, not correctness: a lapsed lease refuses
	 * nobody.
	 */
	sweep(nowMs: EpochMs): number;
}

/** 16 raw bytes -> 22 base64url chars (PROTOCOL §0.1). */
function mintLeaseId(): LeaseId {
	return randomBytes(16).toString("base64url");
}

/**
 * ONE keyed lease table, instantiated twice.
 *
 * The answer lease and the message lease differ in exactly two things: what they
 * are keyed by (`questionId` vs `terminalId`) and the field name that key lands
 * on in the stored lease. Acquisition, the three-way `extend` result, release,
 * the lapsed-entry eviction rule and the sweep were copy-pasted, and the two
 * copies had already drifted textually. The semantics they encode are stated at
 * the top of this file and on `LeaseRegistry`, and are unchanged here.
 *
 * The subtle rule, and the reason `drop` exists rather than two inline deletes:
 * the key index is cleared ONLY when it still points at the lease being dropped.
 * A key that has already been re-taken under a newer leaseId belongs to that
 * holder, and an older lease's release must not evict it.
 *
 * `keyOf` reads the key back off a stored lease rather than the table keeping a
 * parallel map, so the two indices cannot disagree about which key a lease is
 * filed under.
 */
function createLeaseTable<
	K,
	L extends { leaseId: LeaseId; expiresAtMs: EpochMs },
>(options: {
	ttlMs: DurationMs;
	keyOf: (lease: L) => K;
	mint: (input: {
		leaseId: LeaseId;
		key: K;
		deviceId: DeviceId;
		surface: Surface;
		acquiredAtMs: EpochMs;
		expiresAtMs: EpochMs;
	}) => L;
}) {
	const byLeaseId = new Map<LeaseId, L>();
	const byKey = new Map<K, LeaseId>();

	/** The live lease for a key, evicting it if it has lapsed. */
	function live(key: K, nowMs: EpochMs): L | null {
		const leaseId = byKey.get(key);
		if (leaseId === undefined) return null;
		const lease = byLeaseId.get(leaseId);
		if (lease === undefined) {
			byKey.delete(key);
			return null;
		}
		if (lease.expiresAtMs <= nowMs) {
			byLeaseId.delete(leaseId);
			byKey.delete(key);
			return null;
		}
		return lease;
	}

	/**
	 * Drops the lease, and its key index ONLY if that index still points at it.
	 * A key already re-taken under a newer leaseId belongs to that holder.
	 */
	function drop(leaseId: LeaseId, lease: L): void {
		byLeaseId.delete(leaseId);
		const key = options.keyOf(lease);
		if (byKey.get(key) === leaseId) byKey.delete(key);
	}

	return {
		acquire(input: {
			key: K;
			deviceId: DeviceId;
			surface: Surface;
			nowMs: EpochMs;
		}): AcquisitionOf<L> {
			const held = live(input.key, input.nowMs);
			if (held !== null) {
				// Refused outright, including for the same device: a second
				// concurrent attempt from one phone interleaves exactly as badly as
				// two devices do. Idempotent REPLAY of one attempt is handled by the
				// requestId attempt store, before this is ever called.
				return {
					ok: false,
					heldBy: held,
					expiresInMs: held.expiresAtMs - input.nowMs,
				};
			}
			const lease = options.mint({
				leaseId: mintLeaseId(),
				key: input.key,
				deviceId: input.deviceId,
				surface: input.surface,
				acquiredAtMs: input.nowMs,
				expiresAtMs: input.nowMs + options.ttlMs,
			});
			byLeaseId.set(lease.leaseId, lease);
			byKey.set(input.key, lease.leaseId);
			return { ok: true, lease };
		},

		extend(leaseId: LeaseId, nowMs: EpochMs): LeaseExtension<L> {
			const lease = byLeaseId.get(leaseId);
			if (lease === undefined) return { ok: false, reason: "released" };
			if (lease.expiresAtMs <= nowMs) {
				drop(leaseId, lease);
				return { ok: false, reason: "expired" };
			}
			if (byKey.get(options.keyOf(lease)) !== leaseId) {
				return { ok: false, reason: "taken_over" };
			}
			const extended: L = { ...lease, expiresAtMs: nowMs + options.ttlMs };
			byLeaseId.set(leaseId, extended);
			return { ok: true, lease: extended };
		},

		release(leaseId: LeaseId): void {
			const lease = byLeaseId.get(leaseId);
			if (lease === undefined) return;
			drop(leaseId, lease);
		},

		sweep(nowMs: EpochMs): number {
			let dropped = 0;
			for (const [leaseId, lease] of [...byLeaseId]) {
				if (lease.expiresAtMs > nowMs) continue;
				drop(leaseId, lease);
				dropped += 1;
			}
			return dropped;
		},
	};
}

export function createLeaseRegistry(
	options: { ttlMs?: DurationMs } = {},
): LeaseRegistry {
	const ttlMs = options.ttlMs ?? LIMITS.answerLeaseTtlMs;
	if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
		throw new Error(
			`(COMPANION-BRIDGE) lease ttlMs must be a positive integer, got ${ttlMs}`,
		);
	}

	const answerLeases = createLeaseTable<QuestionId, AnswerLease>({
		ttlMs,
		keyOf: (lease) => lease.questionId,
		mint: ({ leaseId, key, deviceId, surface, acquiredAtMs, expiresAtMs }) => ({
			leaseId,
			questionId: key,
			deviceId,
			surface,
			acquiredAtMs,
			expiresAtMs,
		}),
	});

	/** (MESSAGE-LEASE) A separate table: a message lease is never an answer lease. */
	const messageLeases = createLeaseTable<TerminalId, MessageLease>({
		ttlMs,
		keyOf: (lease) => lease.terminalId,
		mint: ({ leaseId, key, deviceId, surface, acquiredAtMs, expiresAtMs }) => ({
			leaseId,
			terminalId: key,
			deviceId,
			surface,
			acquiredAtMs,
			expiresAtMs,
		}),
	});

	return {
		acquire({ questionId, deviceId, surface, nowMs }) {
			return answerLeases.acquire({
				key: questionId,
				deviceId,
				surface,
				nowMs,
			});
		},

		extend(leaseId, nowMs) {
			return answerLeases.extend(leaseId, nowMs);
		},

		release(leaseId) {
			answerLeases.release(leaseId);
		},

		acquireMessage({ terminalId, deviceId, surface, nowMs }) {
			// Refused outright, including for the same device — the same reasoning as
			// `acquire`. Idempotent REPLAY of one send is handled by the requestId
			// message-attempt store, before this is ever called.
			//
			// `messageLeases.extend` exists and is deliberately NOT surfaced: see
			// `LeaseRegistry.acquireMessage`.
			return messageLeases.acquire({
				key: terminalId,
				deviceId,
				surface,
				nowMs,
			});
		},

		releaseMessage(leaseId) {
			messageLeases.release(leaseId);
		},

		sweep(nowMs) {
			return answerLeases.sweep(nowMs) + messageLeases.sweep(nowMs);
		},
	};
}

// ---------------------------------------------------------------------------
// the per-terminal critical section
// ---------------------------------------------------------------------------

/**
 * Waiting for the lock timed out. NOTHING was written: the callback never ran.
 * The waiter is removed from the queue at the same moment, so it can never run
 * "late" — a delayed injection is precisely the stale-byte failure this whole
 * module exists to prevent.
 */
export class TerminalLockTimeoutError extends Error {
	constructor(
		readonly terminalId: TerminalId,
		readonly waitedMs: DurationMs,
	) {
		super(
			`(COMPANION-BRIDGE) timed out after ${waitedMs}ms waiting for the terminal lock on ${terminalId}; nothing was written`,
		);
		this.name = "TerminalLockTimeoutError";
	}
}

export interface TerminalLockRegistry {
	/**
	 * Runs `fn` with exclusive access to `terminalId`. Read-screen, guard
	 * evaluation and the write MUST all happen inside one call — checking and
	 * then writing as two separate acts proves the picker was there at the moment
	 * of checking, not at the moment of writing.
	 */
	runExclusive<T>(
		terminalId: TerminalId,
		timeoutMs: DurationMs,
		fn: () => Promise<T>,
	): Promise<T>;
}

/**
 * An in-process async mutex, and an HONEST one about its reach.
 *
 * It serialises everything that goes through THIS host-service process — the
 * companion bridge's own answers and messages. It does NOT and cannot order a
 * keypress the user made at the desktop: that byte is already queued inside the
 * detached pty daemon, downstream of the emulator mirror the guards read, so no
 * lock on this side can sequence it (PROTOCOL §11.7). That residual is accepted
 * and mitigated by the audit log, not by this lock.
 *
 * It is also why the bridge runs in-process with the pty writer at all: a lock
 * held in the Electron main process would leave a real gap between "the screen
 * said the picker was up" and "the byte reached the pty".
 */
export function createTerminalLockRegistry(): TerminalLockRegistry {
	/** Tail of the queue per terminal. Never rejects. */
	const tails = new Map<TerminalId, Promise<void>>();

	return {
		async runExclusive<T>(
			terminalId: TerminalId,
			timeoutMs: DurationMs,
			fn: () => Promise<T>,
		): Promise<T> {
			if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
				throw new Error(
					`(COMPANION-BRIDGE) runExclusive timeoutMs must be a positive integer, got ${timeoutMs}`,
				);
			}

			const previous = tails.get(terminalId) ?? Promise.resolve();

			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			// Our slot goes into the queue BEFORE we await, so a later caller
			// queues behind us rather than racing us.
			const mine = previous.then(() => held);
			tails.set(terminalId, mine);

			const startedWaitingMs = Date.now();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await new Promise<void>((resolve, reject) => {
					timer = setTimeout(() => {
						reject(
							new TerminalLockTimeoutError(
								terminalId,
								Date.now() - startedWaitingMs,
							),
						);
					}, timeoutMs);
					previous.then(resolve, resolve);
				});
			} catch (error) {
				// Hand the queue on immediately. `fn` has NOT run and never will:
				// this frame throws out before reaching it.
				//
				// The map entry is deliberately NOT removed here. `previous` may
				// still be running, and deleting our slot would let the next caller
				// start concurrently with it — a lock violation. Our slot resolves
				// on its own once `previous` finishes, and the next successful
				// holder clears it.
				release();
				throw error;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}

			try {
				return await fn();
			} finally {
				release();
				if (tails.get(terminalId) === mine) tails.delete(terminalId);
			}
		},
	};
}
