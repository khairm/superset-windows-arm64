/**
 * (COMPANION-BRIDGE) — the read-only event stream (§9).
 *
 * Fixes the two defects measured in the upstream `/events` socket: it duplicated
 * events 2-3x and sent no snapshot on connect. This one de-duplicates and its
 * FIRST frame on every connection is always a full snapshot.
 *
 * HARD RULE (§1.3): every write is an individual sealed HTTP request. No write
 * is ever carried by a WebSocket frame. Authenticating a HANDSHAKE says nothing
 * about a frame sent forty minutes later, so this module is structurally
 * incapable of causing a write:
 *
 *   - its dependency object (`EventStreamDeps`) contains READERS ONLY — a key
 *     store, a device store, a nonce source and a snapshot source. There is no
 *     pty writer, no answer path, no question mutator, nothing that can change
 *     desktop state;
 *   - it imports nothing from answer.ts, read-api.ts, push.ts or pairing.ts, so
 *     no write is even in scope. That import list is the enforcement, and any
 *     future edit that adds one is visible at the top of this file;
 *   - exactly two client->server frame types are accepted (`ack`, `pong`) and
 *     anything else closes the socket with 1008 WITHOUT being parsed, dispatched
 *     or acted on. Both accepted frames are hints: `ack` is accepted and then
 *     discarded, `pong` at worst prevents a timeout.
 */

import type { NodeWebSocket } from "@hono/node-ws";
import type { Hono } from "hono";
import type { AccessValidator } from "./access-jwt";
import {
	EVENT_MAX_CONNECTIONS_PER_DEVICE,
	EVENT_RING_BUFFER_EVENTS,
	EVENT_RING_BUFFER_MS,
	EVENT_TICKET_TTL_MS,
	EVENT_WS_PING_INTERVAL_MS,
	HEARTBEAT_INTERVAL_FOREGROUND_MS,
} from "./config";
import {
	base64UrlDecode,
	base64UrlEncode,
	buildEventAad,
	randomBytes,
	seal,
	zero,
} from "./crypto";
import type { DeviceStore } from "./device-store";
import type { BridgeLogger } from "./http";
import { headersOf } from "./http";
import type { KeyStore, SendNonceSource } from "./keys";
import { deriveEventKey } from "./keys";
import type {
	DeviceId,
	EventFrame,
	EventId,
	EventTicketRequest,
	EventTicketResponse,
	EventType,
	ProtocolVersion,
	QuestionSummary,
	RevokeReason,
	SealedRequestContext,
	StatusCounts,
	Ticket,
	TreeResponse,
} from "./types";
import { CleartextError, ENVELOPE_KIND_EVENT } from "./types";

// ---------------------------------------------------------------------------
// local constants
//
// NOTE for the config owner: `EVENT_MAX_TOTAL_SOCKETS` and the send-buffer cap
// belong in config.ts alongside the other §15 constants. They are declared here
// because this task owns http.ts and ws.ts only; moving them is a one-line
// change and is reported.
// ---------------------------------------------------------------------------

/**
 * A hard ceiling on concurrent sockets across ALL devices. §9.1 bounds a single
 * device to one connection; this bounds the process. Without it a client that
 * reconnects in a loop while the per-device eviction races could pin an
 * unbounded number of half-open sockets.
 */
const EVENT_MAX_TOTAL_SOCKETS = 8;

/**
 * With no ACK-based flow control, a client that stops draining would grow the
 * host's send buffer without bound. Frames are small, so passing this means the
 * client is effectively gone: drop it and let it reconnect with `since`.
 */
const WS_SEND_BUFFER_CAP_BYTES = 8 * 1024 * 1024;

/** Two missed pongs and the socket is closed (§9.3.7). */
const MAX_MISSED_PONGS = 2;

const SOCKET_OPEN = 1;

/** §9.1 — the selected subprotocol. The ticket is NEVER echoed. */
export const COMPANION_SUBPROTOCOL = "sc.v1";
const TICKET_SUBPROTOCOL_PREFIX = "tkt.";

// ---------------------------------------------------------------------------
// tickets (§9.1)
// ---------------------------------------------------------------------------

export interface EventTicket {
	ticketId: string;
	deviceId: DeviceId;
	/** 12 bytes, bound into every frame's AAD. */
	streamSeed: Uint8Array;
	/** The protocol negotiated by the session that requested it (§3.3). */
	protocolVersion: ProtocolVersion;
	expiresAtMs: number;
	/** Burned on the FIRST upgrade attempt, whether it succeeds or fails. */
	redeemed: boolean;
	since: number | null;
}

// ---------------------------------------------------------------------------
// publication shapes
// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** Every frame except `snapshot`, which is minted per socket on connect. */
type BroadcastFrame = Exclude<EventFrame, { t: "snapshot" }>;

/**
 * What a producer hands to `publish`. `eid`, `gseq`, `seq` and `tsMs` are the
 * stream's to assign: `gseq` must be globally monotonic and GAP-FREE, and `seq`
 * is per socket, so neither can be supplied from outside.
 */
export type EventPublication = DistributiveOmit<
	BroadcastFrame,
	"eid" | "gseq" | "seq" | "tsMs"
>;

/** A frame as retained in the ring buffer: global identity, no per-socket `seq`. */
interface StoredEvent {
	eid: EventId;
	gseq: number;
	tsMs: number;
	t: EventType;
	d: unknown;
}

// ---------------------------------------------------------------------------
// dependencies — READERS ONLY (see the file header)
// ---------------------------------------------------------------------------

/** §9.3.2 — the snapshot is a complete `TreeResponse` plus pending questions. */
export interface EventSnapshotSource {
	snapshot(input: {
		deviceId: DeviceId;
	}): Promise<{ tree: TreeResponse; pendingQuestions: QuestionSummary[] }>;
	/** For the periodic `heartbeat` frame (§9.4). */
	counts(): Promise<StatusCounts>;
}

export interface EventStreamDeps {
	devices: DeviceStore;
	keys: KeyStore;
	/** The bridge's own send-side nonce state; independent prefix and counter (§3.4). */
	sendNonce: SendNonceSource;
	snapshots: EventSnapshotSource;
	logger: BridgeLogger;
	/** Test seam only. Production passes nothing and gets the wall clock. */
	now?: () => number;
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

export interface EventStreamServer {
	/**
	 * §9.1 — mints a single-use, device-bound ticket. A WebSocket handshake
	 * cannot carry a sealed body, so authorisation is a ticket obtained over the
	 * sealed HTTP path first. The ticket then travels in
	 * `Sec-WebSocket-Protocol`, never in a query string — a query string is
	 * logged by every proxy on the path.
	 */
	issueTicket(
		ctx: SealedRequestContext,
		request: EventTicketRequest,
	): Promise<EventTicketResponse>;
	/**
	 * Publishes to every live socket. `gseq` is global per bridge boot and
	 * GAP-FREE — a client that sees it jump by more than 1 refetches the tree
	 * rather than inferring.
	 */
	publish(frame: EventPublication): void;
	/**
	 * The global sequence the last minted event carried, or 0 before the first
	 * one. `/v1/tree` stamps it so a client can tell whether the tree it just
	 * fetched is newer than the last frame it processed, and `/v1/heartbeat`
	 * compares against it for `treeStale`.
	 *
	 * It MUST come from here rather than being synthesised by the composition
	 * root: a tree that always reports `gseq: 0` makes the client's very first
	 * live frame look like a sequence gap (§9.3.3 -> refetch the tree), and the
	 * refetched tree reports 0 again — a refetch per event, forever, with the
	 * `treeStale` backstop wired to the same lie and therefore never true.
	 */
	currentGseq(): number;
	/**
	 * §9.4 — emits `revoked` as the LAST frame on that device's socket, then
	 * closes it with 1008.
	 */
	revoke(deviceId: DeviceId, reason: RevokeReason): void;
	/** Redeems a ticket. Burned on this call whether the upgrade then succeeds or not. */
	redeemTicket(ticket: Ticket, nowMs: number): EventTicket;
	/** A second socket for the same device closes the OLDER one with 1008. */
	attach(socket: unknown, ticket: EventTicket): Promise<void>;
	/**
	 * §1.3 — records the effect of one of the TWO accepted client frames. `ack` is
	 * accepted and discarded (the ring is global and no ack has ever trimmed it);
	 * `pong` clears the liveness counter. Nothing else is reachable from here.
	 */
	noteClientFrame(
		socket: unknown,
		frame: { kind: "ack"; seq: number } | { kind: "pong" },
	): void;
	/**
	 * The transport told us this socket is gone.
	 *
	 * (WS-CLOSE-WIPE) There was NO close path at all. A client-initiated close —
	 * the ordinary case: the phone backgrounds, the tunnel drops, the user swipes
	 * the app away — left the `LiveSocket` registered with `closed: false` and its
	 * K_evt live in the heap until the pong watchdog happened to reap it several
	 * ping intervals later, or until something tried to emit to it. `revoke()`
	 * would still find it in `byDevice` and try to seal a farewell frame onto a
	 * dead socket, and `attach()` would log "replacing older event socket" for a
	 * socket that closed minutes ago.
	 *
	 * Idempotent, and safe for a socket that was never attached (an upgrade that
	 * failed before `attach` resolved): an unknown socket is a no-op.
	 */
	noteClientClose(socket: unknown): void;
	stop(): Promise<void>;
}

/** Structural slice of hono/ws's WSContext; `raw` is the underlying `ws` socket. */
type StreamSocket = {
	send: (data: Uint8Array) => void;
	close: (code?: number, reason?: string) => void;
	readyState: number;
	raw?: {
		readonly bufferedAmount?: number;
		ping?: () => void;
		on?: (event: string, listener: () => void) => void;
	};
};

interface LiveSocket {
	ticketId: string;
	deviceId: DeviceId;
	deviceIdBytes: Uint8Array;
	socket: StreamSocket;
	keyEvt: Uint8Array;
	streamSeed: Uint8Array;
	protocolVersion: ProtocolVersion;
	/** Per-socket, monotonic from 1, gap-free, and bound into the AAD (§3.3). */
	nextSeq: number;
	snapshotSent: boolean;
	/** Live frames that arrived while the snapshot was still being built. */
	queued: StoredEvent[];
	/** Highest `gseq` already delivered on this socket; live frames at or below it are dropped. */
	highestGseq: number;
	missedPongs: number;
	closed: boolean;
}

export function createEventStreamServer(
	deps: EventStreamDeps,
): EventStreamServer {
	const now = deps.now ?? (() => Date.now());

	const tickets = new Map<Ticket, EventTicket>();
	const sockets = new Map<string, LiveSocket>();
	const byDevice = new Map<DeviceId, LiveSocket>();
	/** Reverse lookup for the two accepted client frames; keyed on the WSContext. */
	const bySocket = new WeakMap<object, LiveSocket>();
	const ring: StoredEvent[] = [];
	let gseq = 0;
	let stopped = false;

	// -- ring buffer (§9.3.6): 1 024 events or 10 minutes, whichever is smaller --
	function retain(event: StoredEvent): void {
		ring.push(event);
		const cutoffMs = event.tsMs - EVENT_RING_BUFFER_MS;
		while (
			ring.length > EVENT_RING_BUFFER_EVENTS ||
			(ring.length > 0 && (ring[0]?.tsMs ?? 0) < cutoffMs)
		) {
			ring.shift();
		}
	}

	function ringCovers(since: number): boolean {
		const oldest = ring[0];
		// `since` is the last gseq the client processed, so the buffer covers it
		// when the next event after it is still retained.
		if (oldest === undefined) return since === gseq;
		return oldest.gseq <= since + 1;
	}

	// -- emission ------------------------------------------------------------

	/**
	 * §9.3.5 — the bridge guarantees each `eid` at most once per socket, and it
	 * does so STRUCTURALLY rather than by remembering what it has sent.
	 *
	 * There used to be a per-socket `Set<EventId>` plus a parallel insertion-order
	 * array plus an eviction pass, all to answer "have I sent this one?". Nothing
	 * could ever answer YES: the only place two emit paths can name the same
	 * event is the overlap between the ring replay and `live.queued` (an event
	 * that arrived while the snapshot was being built is BOTH retained and
	 * queued), and the queued flush already skips it with `event.gseq <=
	 * live.highestGseq` — one integer compare against a per-socket high-water mark
	 * that every emit raises. Every other path — the snapshot, the replay over a
	 * ring that holds each event once, `broadcast` over each socket once,
	 * `revoke`'s freshly minted frame — visits an event once by construction, and
	 * the whole `attach` sequence from the resolved snapshot to the queued flush
	 * is synchronous, so nothing can interleave into it.
	 *
	 * DO NOT "tidy" this into a `gseq` gate inside `emit`. The replay path
	 * deliberately DESCENDS: `highestGseq` is set to the snapshot's `gseq` (which
	 * is the current global counter, i.e. at or above every retained event) before
	 * the tail is replayed, so a gate here would silently deliver an empty resume
	 * — a snapshot and nothing else — on every reconnect that asked for one.
	 */
	function emit(live: LiveSocket, event: StoredEvent): void {
		if (live.closed) return;
		if (live.socket.readyState !== SOCKET_OPEN) {
			dropSocket(live, 1006, "socket not open");
			return;
		}
		if ((live.socket.raw?.bufferedAmount ?? 0) > WS_SEND_BUFFER_CAP_BYTES) {
			deps.logger.warn("[companion] event socket back-pressure, dropping", {
				deviceId: live.deviceId,
			});
			dropSocket(live, 1013, "stream back-pressure");
			return;
		}

		const seq = live.nextSeq;
		let body: Uint8Array;
		try {
			body = seal(
				live.keyEvt,
				ENVELOPE_KIND_EVENT,
				live.deviceIdBytes,
				deps.sendNonce.next(),
				event.tsMs,
				new TextEncoder().encode(
					JSON.stringify({
						eid: event.eid,
						gseq: event.gseq,
						seq,
						tsMs: event.tsMs,
						t: event.t,
						d: event.d,
					}),
				),
				(headerBytes) =>
					buildEventAad(headerBytes, {
						protocolVersion: live.protocolVersion,
						streamSeed: live.streamSeed,
						// Binding `frameSeq` means frames cannot be reordered, dropped or
						// replayed by anything on the path without a tag failure (§3.3).
						frameSeq: seq,
					}),
			);
		} catch (error) {
			// A sealing failure is a bridge fault. Fail the socket loudly rather than
			// skipping a frame and leaving the client with a silent gap.
			deps.logger.error("[companion] failed to seal event frame", {
				deviceId: live.deviceId,
				t: event.t,
				error,
			});
			dropSocket(live, 1011, "frame seal failure");
			return;
		}

		live.nextSeq = seq + 1;
		live.highestGseq = Math.max(live.highestGseq, event.gseq);
		live.socket.send(body);
	}

	function dropSocket(live: LiveSocket, code: number, reason: string): void {
		if (live.closed) return;
		live.closed = true;
		sockets.delete(live.ticketId);
		if (byDevice.get(live.deviceId) === live) byDevice.delete(live.deviceId);
		// The single teardown funnel, so this is the single place K_evt is wiped.
		// `emit` returns on `live.closed` before it reads `keyEvt`, so nothing can
		// seal a frame with the zeroed buffer; `bySocket` is a WeakMap holding the
		// same object, which is exactly why the key must be wiped explicitly rather
		// than left for the collector.
		zero(live.keyEvt);
		try {
			live.socket.close(code, reason);
		} catch {
			// best-effort; close may race an already-closing socket
		}
	}

	function mintEvent(t: EventType, d: unknown): StoredEvent {
		gseq += 1;
		return {
			eid: base64UrlEncode(randomBytes(12)),
			gseq,
			tsMs: now(),
			t,
			d,
		};
	}

	function broadcast(event: StoredEvent): void {
		for (const live of sockets.values()) {
			if (!live.snapshotSent) {
				// Ordering matters more than latency: nothing may precede the snapshot.
				live.queued.push(event);
				continue;
			}
			emit(live, event);
		}
	}

	// -- timers --------------------------------------------------------------

	// §9.4 — a `heartbeat` frame every 60 s, so an idle socket still proves
	// liveness. It is a real event and takes a gseq, which keeps the sequence
	// gap-free for every client.
	const heartbeatTimer = setInterval(() => {
		if (stopped || sockets.size === 0) return;
		void deps.snapshots
			.counts()
			.then((counts) => {
				broadcastAndRetain(
					mintEvent("heartbeat", { serverTimeMs: now(), counts }),
				);
			})
			.catch((error: unknown) => {
				deps.logger.error("[companion] heartbeat frame failed", { error });
			});
	}, HEARTBEAT_INTERVAL_FOREGROUND_MS);

	// §9.3.7 — a WebSocket ping every 30 s; two missed pongs close the socket.
	//
	// The counter is incremented ONLY when a ping actually went out. Incrementing
	// unconditionally would close healthy sockets every 60 s on any runtime where
	// `raw.ping` is unavailable — a liveness check that kills what it measures.
	// `attach` refuses such a socket outright, so reaching the failure branch here
	// means the socket broke mid-life, which is itself a reason to close it.
	const pingTimer = setInterval(() => {
		if (stopped) return;
		for (const live of [...sockets.values()]) {
			if (live.missedPongs >= MAX_MISSED_PONGS) {
				deps.logger.warn("[companion] event socket missed pongs, closing", {
					deviceId: live.deviceId,
				});
				dropSocket(live, 1001, "no pong");
				continue;
			}
			const ping = live.socket.raw?.ping;
			if (typeof ping !== "function") {
				deps.logger.error("[companion] event socket lost its ping primitive", {
					deviceId: live.deviceId,
				});
				dropSocket(live, 1011, "liveness unavailable");
				continue;
			}
			try {
				ping.call(live.socket.raw);
				live.missedPongs += 1;
			} catch (error) {
				deps.logger.warn("[companion] ws ping failed", {
					deviceId: live.deviceId,
					error,
				});
				dropSocket(live, 1011, "ping failed");
			}
		}
	}, EVENT_WS_PING_INTERVAL_MS);

	// Timers must not hold the process open when everything else has stopped.
	heartbeatTimer.unref?.();
	pingTimer.unref?.();

	function broadcastAndRetain(event: StoredEvent): void {
		retain(event);
		broadcast(event);
	}

	function pruneTickets(nowMs: number): void {
		for (const [key, ticket] of tickets) {
			if (ticket.redeemed || ticket.expiresAtMs <= nowMs) tickets.delete(key);
		}
	}

	return {
		async issueTicket(ctx, request) {
			const nowMs = now();
			pruneTickets(nowMs);
			const ticket = base64UrlEncode(randomBytes(32));
			const record: EventTicket = {
				ticketId: base64UrlEncode(randomBytes(16)),
				deviceId: ctx.device.deviceId,
				streamSeed: randomBytes(12),
				protocolVersion: ctx.protocolVersion,
				expiresAtMs: nowMs + EVENT_TICKET_TTL_MS,
				redeemed: false,
				since: request.since,
			};
			tickets.set(ticket, record);
			return {
				ticket,
				streamSeed: base64UrlEncode(record.streamSeed),
				ticketId: record.ticketId,
				expiresInMs: EVENT_TICKET_TTL_MS,
				maxConnections: EVENT_MAX_CONNECTIONS_PER_DEVICE,
			};
		},

		redeemTicket(ticket, nowMs) {
			const record = tickets.get(ticket);
			// Single use, and burned on the FIRST attempt whether it succeeds or
			// fails (§9.1) — so it is deleted before any other check can reject it.
			tickets.delete(ticket);
			if (!record) throw new CleartextError(403, "access_denied");
			if (record.redeemed) throw new CleartextError(403, "access_denied");
			if (record.expiresAtMs <= nowMs)
				throw new CleartextError(403, "access_denied");
			record.redeemed = true;
			return record;
		},

		publish(frame) {
			if (stopped) return;
			broadcastAndRetain(mintEvent(frame.t, frame.d));
		},

		currentGseq() {
			return gseq;
		},

		revoke(deviceId, reason) {
			const live = byDevice.get(deviceId);
			if (!live) return;
			// §9.4 — `revoked` is the last frame before the socket closes with 1008.
			const event = mintEvent("revoked", { reason });
			retain(event);
			if (live.snapshotSent) emit(live, event);
			dropSocket(live, 1008, "revoked");
		},

		async attach(socket, ticket) {
			const nowMs = now();
			if (stopped) {
				(socket as StreamSocket).close(1001, "bridge stopping");
				return;
			}

			// §9.1 — `maxConnections: 1`. A new phone process should win over a
			// zombie, so the OLDER socket is the one that goes.
			const existing = byDevice.get(ticket.deviceId);
			if (existing) {
				deps.logger.info("[companion] replacing older event socket", {
					deviceId: ticket.deviceId,
				});
				dropSocket(existing, 1008, "replaced by a newer connection");
			}

			if (sockets.size >= EVENT_MAX_TOTAL_SOCKETS) {
				deps.logger.error("[companion] event socket cap reached, refusing", {
					cap: EVENT_MAX_TOTAL_SOCKETS,
					deviceId: ticket.deviceId,
				});
				(socket as StreamSocket).close(1013, "too many connections");
				return;
			}

			const device = await deps.devices.get(ticket.deviceId);
			if (!device || device.revokedAtMs !== null) {
				(socket as StreamSocket).close(1008, "unknown or revoked device");
				return;
			}
			const deviceKey = await deps.keys.load(device.keyRef);
			if (!deviceKey) {
				deps.logger.error("[companion] event socket device has no key", {
					deviceId: device.deviceId,
				});
				(socket as StreamSocket).close(1011, "key unavailable");
				return;
			}

			// K_dev's ONLY job on this path is to produce K_evt. It is wiped the
			// instant that is done: a live socket can sit open for hours, and holding
			// the device master key in the heap for all of it — when the stream key
			// derived from it is the only thing any later line uses — is custody this
			// path has no reason to keep.
			const keyEvt = deriveEventKey(
				deviceKey,
				base64UrlDecode(ticket.ticketId),
			);
			zero(deviceKey);

			const live: LiveSocket = {
				ticketId: ticket.ticketId,
				deviceId: ticket.deviceId,
				deviceIdBytes: base64UrlDecode(ticket.deviceId),
				socket: socket as StreamSocket,
				keyEvt,
				streamSeed: ticket.streamSeed,
				protocolVersion: ticket.protocolVersion,
				nextSeq: 1,
				snapshotSent: false,
				queued: [],
				highestGseq: ticket.since ?? 0,
				missedPongs: 0,
				closed: false,
			};
			sockets.set(live.ticketId, live);
			byDevice.set(live.deviceId, live);
			bySocket.set(socket as object, live);

			// §9.3.7 — liveness needs both halves of the ping/pong primitive. A
			// socket that cannot be pinged cannot be proven alive, and the phone's
			// watchdog reads this stream's silence as "lost contact" (§7.7). Refusing
			// it here is the loud failure; silently serving an unmeasurable socket
			// would be the quiet one.
			const raw = live.socket.raw;
			if (typeof raw?.ping !== "function" || typeof raw.on !== "function") {
				deps.logger.error(
					"[companion] event socket has no ping/pong primitive; refusing",
					{ deviceId: live.deviceId },
				);
				dropSocket(live, 1011, "liveness unavailable");
				return;
			}
			// A native pong clears the liveness counter; a `{"t":"pong"}` text frame
			// does the same through `noteClientFrame`.
			raw.on("pong", () => {
				live.missedPongs = 0;
			});

			// §9.3.1 — the FIRST frame on every connection is `snapshot` with seq 1.
			// No exceptions, no "only if you asked". Anything that arrives while it
			// is being built is queued, never emitted ahead of it.
			let snapshot: Awaited<ReturnType<EventSnapshotSource["snapshot"]>>;
			try {
				snapshot = await deps.snapshots.snapshot({ deviceId: live.deviceId });
			} catch (error) {
				deps.logger.error("[companion] snapshot failed; refusing the socket", {
					deviceId: live.deviceId,
					error,
				});
				// Failing loud is correct: a socket with no snapshot would silently
				// violate §9.3.1 and the client would close it anyway.
				dropSocket(live, 1011, "snapshot unavailable");
				return;
			}
			if (live.closed) return;

			// §9.3.6 — resume replays the missed tail when the ring still holds it.
			const since = ticket.since;
			const replayed = since !== null && ringCovers(since);

			// The frame's `gseq` is the tree's own — "the global event sequence this
			// tree is consistent with" (§7.2) — NOT the counter's current value. The
			// counter may have advanced during the await, and stamping the newer
			// number would tell the client the snapshot already includes events it
			// does not, silently losing them. It also must not CONSUME a gseq: that
			// would punch a gap in every other socket's sequence.
			live.highestGseq = snapshot.tree.gseq;
			emit(live, {
				eid: base64UrlEncode(randomBytes(12)),
				gseq: snapshot.tree.gseq,
				tsMs: nowMs,
				t: "snapshot",
				d: {
					...snapshot.tree,
					pendingQuestions: snapshot.pendingQuestions,
					replayed,
				},
			});
			live.snapshotSent = true;

			if (replayed && since !== null) {
				for (const event of ring) {
					if (event.gseq > since) emit(live, event);
				}
			}
			// Flush whatever arrived during the await, skipping anything the snapshot
			// or the replay already covered.
			const queued = live.queued;
			live.queued = [];
			for (const event of queued) {
				if (event.gseq <= live.highestGseq) continue;
				emit(live, event);
			}
		},

		noteClientFrame(socket, frame) {
			const live = bySocket.get(socket as object);
			if (!live) return;
			if (frame.kind === "pong") {
				live.missedPongs = 0;
				return;
			}
			// `ack` is ACCEPTED and then deliberately FORGOTTEN. §9 requires the
			// server to accept the frame; it does not require it to remember one,
			// and there is nothing an ack could advance: the replay buffer is the
			// GLOBAL ring, which `retain` trims by count and age only, so no ack has
			// ever truncated anything. The cursor field that used to hold
			// `max(seq)` had no reader in this process or any other — keeping it
			// only invited a future edit to believe the server tracks per-client
			// delivery, which it does not.
		},

		noteClientClose(socket) {
			const live = bySocket.get(socket as object);
			if (!live) return;
			// 1000 is what we would send; the peer has already gone, so `close()`
			// inside `dropSocket` is the best-effort no-op it is written to be. The
			// point of routing through it is that deregistration and the K_evt wipe
			// happen on exactly one code path.
			dropSocket(live, 1000, "client closed");
		},

		async stop() {
			stopped = true;
			clearInterval(heartbeatTimer);
			clearInterval(pingTimer);
			for (const live of [...sockets.values()]) {
				dropSocket(live, 1001, "bridge stopping");
			}
			tickets.clear();
			ring.length = 0;
		},
	};
}

// ---------------------------------------------------------------------------
// §1.3 — the ONLY two client -> server frames the bridge may accept
// ---------------------------------------------------------------------------

/**
 * Returns `null` when the frame is acceptable, or a close reason when it is not.
 *
 * This function is the whole client->server surface. It parses at most a
 * two-field object, and the two accepted types are hints: `ack` is accepted and
 * discarded, `pong` at worst prevents a timeout. NEITHER can change
 * desktop state, and there is no branch here that reaches code which could.
 * Anything else is refused BEFORE its contents are inspected or dispatched.
 */
export function classifyClientFrame(
	raw: unknown,
):
	| { kind: "ack"; seq: number }
	| { kind: "pong" }
	| { kind: "reject"; reason: string } {
	if (typeof raw !== "string") {
		return { kind: "reject", reason: "binary frames are not accepted" };
	}
	if (raw.length > 256) {
		return { kind: "reject", reason: "frame too large" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "reject", reason: "not JSON" };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { kind: "reject", reason: "not an object" };
	}
	const frame = parsed as { t?: unknown; seq?: unknown; ts?: unknown };
	if (frame.t === "ack") {
		if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq)) {
			return { kind: "reject", reason: "ack.seq must be an integer" };
		}
		return { kind: "ack", seq: frame.seq };
	}
	if (frame.t === "pong") {
		if (typeof frame.ts !== "number" || !Number.isSafeInteger(frame.ts)) {
			return { kind: "reject", reason: "pong.ts must be an integer" };
		}
		return { kind: "pong" };
	}
	return { kind: "reject", reason: "unrecognised frame type" };
}

// ---------------------------------------------------------------------------
// §9.1 — subprotocol negotiation and the upgrade route
// ---------------------------------------------------------------------------

/**
 * `ws`'s `handleProtocols`. The bridge echoes `sc.v1` and NEVER echoes the
 * ticket. Returning `false` aborts the handshake, which is the right answer for
 * a client that did not offer the subprotocol at all.
 */
export function selectCompanionSubprotocol(
	protocols: Set<string> | string[],
): string | false {
	const offered = Array.isArray(protocols) ? protocols : [...protocols];
	return offered.includes(COMPANION_SUBPROTOCOL)
		? COMPANION_SUBPROTOCOL
		: false;
}

/** Parsed out of `Sec-WebSocket-Protocol`, never out of a query string (§9.1). */
export function extractTicket(headerValue: string | undefined): Ticket | null {
	if (!headerValue) return null;
	for (const raw of headerValue.split(",")) {
		const token = raw.trim();
		if (!token.startsWith(TICKET_SUBPROTOCOL_PREFIX)) continue;
		const ticket = token.slice(TICKET_SUBPROTOCOL_PREFIX.length);
		if (ticket.length === 43 && /^[A-Za-z0-9_-]+$/.test(ticket)) return ticket;
		return null;
	}
	return null;
}

export interface EventStreamRouteOptions {
	app: Hono;
	upgradeWebSocket: NodeWebSocket["upgradeWebSocket"];
	events: EventStreamServer;
	accessValidator: AccessValidator;
	logger: BridgeLogger;
	now: () => number;
	/** Test/embedding hook; production uses the protocol path. */
	path?: string;
}

/**
 * `GET /v1/events` with `Upgrade: websocket`.
 *
 * The guard runs BEFORE the upgrade so an unauthorised client gets a real HTTP
 * status rather than a 101 followed by an immediate close: Access is validated,
 * then the ticket is redeemed (and burned). Only then is the socket upgraded.
 */
export function registerEventStreamRoute(
	options: EventStreamRouteOptions,
): void {
	const {
		app,
		upgradeWebSocket,
		events,
		accessValidator,
		logger,
		now,
		path = "/v1/events",
	} = options;

	// The redeemed ticket travels from the guard to the upgrade handler keyed on
	// the Request instance, so it never touches a query string or a global.
	const redeemed = new WeakMap<Request, EventTicket>();

	app.get(
		path,
		async (c, next) => {
			const nowMs = now();
			try {
				// The SAME header projection the sealed pipeline feeds the validator
				// (`http.headersOf`). Two copies of "how this bridge presents headers
				// to `AccessValidator`" is one too many on a pre-auth path.
				const headers = headersOf(c.req.raw);
				// The edge is not the security boundary and is not trusted (§2.1).
				await accessValidator.validate(headers);

				const ticket = extractTicket(headers["sec-websocket-protocol"]);
				if (!ticket) throw new CleartextError(403, "access_denied");
				redeemed.set(c.req.raw, events.redeemTicket(ticket, nowMs));
			} catch (error) {
				if (error instanceof CleartextError) {
					return new Response(
						JSON.stringify({
							code: error.code,
							serverTimeMs: nowMs,
							retryAfterMs: error.retryAfterMs,
						}),
						{
							status: error.statusCode,
							headers: { "content-type": "application/json; charset=utf-8" },
						},
					);
				}
				logger.error("[companion] /v1/events guard failed", { error });
				return new Response(
					JSON.stringify({
						code: "bridge_unavailable",
						serverTimeMs: nowMs,
						retryAfterMs: null,
					}),
					{
						status: 503,
						headers: { "content-type": "application/json; charset=utf-8" },
					},
				);
			}
			await next();
		},
		upgradeWebSocket((c) => {
			const ticket = redeemed.get(c.req.raw);
			redeemed.delete(c.req.raw);
			return {
				onOpen: (_event, ws) => {
					if (!ticket) {
						// Unreachable: the guard rejects before the upgrade. Loud anyway.
						logger.error("[companion] upgrade reached with no ticket");
						ws.close(1011, "no ticket");
						return;
					}
					void events.attach(ws, ticket).catch((error: unknown) => {
						logger.error("[companion] failed to attach event socket", {
							deviceId: ticket.deviceId,
							error,
						});
						try {
							ws.close(1011, "attach failed");
						} catch {
							// best-effort; close may race an already-closing socket
						}
					});
				},
				onMessage: (event, ws) => {
					const verdict = classifyClientFrame(event.data);
					if (verdict.kind === "reject") {
						// §1.3 — closed with 1008 and logged, and its contents are NEVER
						// parsed, dispatched or acted on.
						logger.warn("[companion] rejecting client frame on /v1/events", {
							reason: verdict.reason,
						});
						ws.close(1008, "unsupported frame");
						return;
					}
					// `ack` and `pong` are hints only — liveness and an advisory cursor.
					events.noteClientFrame(ws, verdict);
				},
				onError: (error: unknown) => {
					logger.warn("[companion] event socket error", { error });
				},
				onClose: (_event, ws) => {
					// (WS-CLOSE-WIPE) The only signal that a client-initiated close
					// happened. Without it the socket stayed registered and its K_evt
					// stayed in the heap until the pong watchdog reaped it.
					events.noteClientClose(ws);
				},
			};
		}),
	);
}
