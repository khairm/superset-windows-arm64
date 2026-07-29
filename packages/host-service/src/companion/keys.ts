/**
 * (COMPANION-BRIDGE) — K_dev custody, directional key derivation, the bridge's
 * own send-nonce counter, and the persisted replay cache (§3.1, §3.4, §3.5).
 *
 * K_dev is NEVER transmitted in either direction, in any form. There is no
 * endpoint that returns it and no diagnostic that prints it. It is stored under
 * `~/.superset/companion/devices/<keyRef>.key.json` — outside both repos.
 *
 * ---------------------------------------------------------------------------
 * THE STATE ANCHOR — why this file grew one
 * ---------------------------------------------------------------------------
 * Nonce, replay and revocation authority used to live in independently
 * rollbackable flat files with no transaction and nothing binding them
 * together. That single root cause produced three separate failures:
 *
 *  - two bridge lifecycles could own the same send-nonce file, each with a
 *    private counter, and a stale owner's `close()` could LOWER the persisted
 *    high-water mark — after which the next owner resumed below it and
 *    re-emitted nonces a previous owner had already used;
 *  - restoring the counter state while retaining K_dev (VM snapshot, profile
 *    restore, disk rollback) reproduced an identical `(prefix, counter)` under
 *    an unchanged key;
 *  - restoring an older `devices.json` reinstated a revoked device, and because
 *    K_dev had deliberately been retained (§5.1) its writes became valid again.
 *
 * `StateAnchor` is the fix, and it is one object with four jobs:
 *  1. it is the SINGLE writer of the send-nonce high-water mark, guarded by an
 *     owner token and a monotonic check performed against the file on disk, so
 *     a stale owner cannot write at all and no write can ever lower the mark;
 *  2. it carries a `generation` minted once per install and stamped into every
 *     key file, so key material and counter state cannot be recombined across
 *     installs;
 *  3. it carries a monotonic `epoch`, bumped once per mount and mirrored into
 *     `devices.json`, so a rollback of EITHER file relative to the other is
 *     detectable;
 *  4. it carries the device index's `(seq, digest)`, so a rollback of the index
 *     alone — the revocation-reversal case — fails closed instead of silently
 *     re-authorising a revoked phone.
 *
 * `send.highWater` gets one more thing on top, `send-witness.json`
 * (SEND-WITNESS), because the anchor could not police its own most important
 * field. `generation` is per install, `epoch` is per mount and `(seq, digest)`
 * move only with the device authority, so reverting `state-anchor.json` to ANY
 * earlier version written during the same mount matched every check while taking
 * the mark backwards with it — and on win32 `syncDirectory` is a no-op, so the
 * most recent rename really can be lost. The witness is written BEFORE the
 * anchor on every raise and the higher of the two wins at start.
 *
 * HONEST LIMIT, STATED RATHER THAN PAPERED OVER: a rollback of the WHOLE
 * `~/.superset/companion/` tree at once (a full VM snapshot restore) restores
 * the anchor, the index, the witness and the key files together and is not
 * detectable from inside that tree. Detecting it needs a monotonic reference
 * outside the rolled-back volume, which this design does not have. Every PARTIAL
 * rollback — which is what the reviewer demonstrated, and what a "restore my
 * profile" or "roll back one file" actually does — is caught: a rolled-back
 * index or key file fails closed, and a rolled-back anchor is overridden by the
 * witness and logged loudly (resuming at the higher mark, rather than refusing,
 * because that shape is also an ordinary crash between the two writes).
 *
 * The witness bounds a rollback of the ANCHOR, which is the shape a crash can
 * produce, because a crash cannot delete a file. It does not bound a DELIBERATE
 * edit that rolls the anchor back AND removes or rewinds `send-witness.json` in
 * the same act: two files tampered together is the tree case again, stated here
 * rather than left implied. What the witness does guarantee against any single
 * lost rename, torn write or reverted file is that the counter never resumes
 * below a mark that was ever durable.
 *
 * ---------------------------------------------------------------------------
 * WHY `keyRef` IS RANDOM AND NOT THE deviceId
 * ---------------------------------------------------------------------------
 * §4.8 says re-pairing always mints a NEW deviceId, and `device-store`'s
 * `create()` is the guard that enforces it. If the key file were named after the
 * deviceId, a client that replayed an already-registered deviceId would
 * OVERWRITE a live device's K_dev before `create()` ever got to refuse — the
 * record would keep pointing at a file holding a key nobody has, and the
 * previously working phone would be bricked with no recovery but manual file
 * deletion. A random `keyRef` makes that collision impossible by construction
 * rather than by call ordering.
 *
 * ---------------------------------------------------------------------------
 * ID ENCODING IN HKDF `info`
 * ---------------------------------------------------------------------------
 * Every id suffix contributes its RAW BYTES, never its base64url text. See the
 * INTEROP NOTE in `crypto.ts`; the Android client's `KeyDerivation` implements
 * the same convention, and the two MUST NOT drift.
 */

import { open, readFile, unlink } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
	HKDF_LABEL_SEAL_C2S,
	HKDF_LABEL_SEAL_EVT,
	HKDF_LABEL_SEAL_S2C,
	LOG_PREFIX,
	NONCE_COUNTER_BYTES,
	NONCE_PREFIX_BYTES,
} from "./config";
import {
	base64UrlDecode,
	base64UrlEncode,
	createSerialiser,
	hkdfExpandInfo,
	hkdfExpandLabel,
	hkdfInfoWithSuffix,
	isAllZero,
	isCanonicalWireId,
	randomBytes,
	syncDirectory,
	writeFileDurable,
	zero,
} from "./crypto";
import { KEY_BYTES, WIRE_ID_BYTES } from "./limits";
import type { DeviceId, DirectionalKeys, RevokeReason } from "./types";

const KEY_FILE_SUFFIX = ".key.json";
/** Owner read/write only. Ignored on Windows — `ensureCompanionDirs` owns the ACL. */
const KEY_FILE_MODE = 0o600;

const ANCHOR_FILENAME = "state-anchor.json";
/**
 * (SEND-WITNESS) The second, independent durable record of the send-nonce
 * high-water mark. See `readSendWitness` for why it exists at all.
 */
const SEND_WITNESS_FILENAME = "send-witness.json";
/**
 * The pre-anchor send-nonce file. Read ONCE, to carry its high-water mark into
 * the anchor, then deleted. Never re-created.
 */
const LEGACY_SEND_NONCE_FILENAME = "send-nonce.json";

/**
 * §3.4 — counters are reserved on disk in blocks, not one at a time.
 *
 * The safety property the spec demands is "a crash must never let a counter
 * repeat". Reserving a block and fsync'ing the block's high-water mark BEFORE
 * any nonce in it is handed out gives exactly that: a crash burns the remainder
 * of the block. An fsync per nonce would give the same property at the cost of a
 * synchronous disk write on every event frame, and `next()` is called from the
 * synchronous seal path where it cannot await anything.
 */
const NONCE_RESERVATION_BLOCK = 65_536n;
/** Refill this far ahead of exhaustion so the async write lands before the block runs out. */
const NONCE_REFILL_THRESHOLD = 8_192n;
/** Counter 0 is reserved for the pairing step-4 response (`pairing.ts`). */
const NONCE_FIRST_COUNTER = 1n;

/**
 * A state-freshness failure. ALWAYS fatal, never caught to be hidden: it means
 * the bridge cannot prove its own counter/revocation state is current, and §3.4
 * rule 4 is explicit that the only correct response is to refuse and re-pair.
 */
export class StateRollbackError extends Error {
	constructor(message: string) {
		super(
			`${LOG_PREFIX} state freshness cannot be proven: ${message}. ` +
				"REFUSING TO START. This is the §3.4 rule-4 / §4.8 path: delete " +
				"~/.superset/companion/devices/ and pair every device again. Emitting " +
				"under state that may have rolled back would repeat a nonce, which " +
				"destroys AES-GCM outright.",
		);
		this.name = "StateRollbackError";
	}
}

// ---------------------------------------------------------------------------
// the state anchor
// ---------------------------------------------------------------------------

interface StoredAnchorFile {
	v: 1;
	/** 16 random bytes, base64url. Minted once per install, never changed. */
	generation: string;
	/** Monotonic, one per mount. Decimal uint64 text. */
	epoch: string;
	send: {
		/** 4 raw bytes as base64url. Install-scoped (§3.4). */
		prefix: string;
		/** The first counter NOBODY may use without reserving again. */
		highWater: string;
		/** The one lifecycle allowed to raise `highWater`. */
		owner: string;
	} | null;
	devices: {
		/** Monotonic; bumps only when the AUTHORITY projection of the index changes. */
		seq: string;
		/** base64url sha256 over that projection. */
		digest: string;
	} | null;
}

export interface AnchorSendState {
	prefix: Uint8Array;
	highWater: bigint;
	owner: string;
}

export interface AnchorDevicesState {
	seq: bigint;
	digest: string;
}

export interface StateAnchor {
	/** Install identity. Stamped into every key file; a mismatch fails closed. */
	readonly generation: string;
	/** The epoch THIS mount owns. Already durable before the anchor is returned. */
	readonly epoch: bigint;
	/** The epoch the previous mount owned; `devices.json` may not exceed it. */
	readonly previousEpoch: bigint;
	/** true only when the anchor file did not exist and was just minted. */
	readonly minted: boolean;
	send(): AnchorSendState | null;
	/**
	 * Takes send-nonce ownership and raises the high-water mark in one durable
	 * write. Refuses to lower the mark. Returns the new owner token.
	 */
	claimSend(prefix: Uint8Array, highWater: bigint): Promise<string>;
	/** Raises the mark. Throws if `owner` is stale or `through` would lower it. */
	raiseSend(owner: string, through: bigint): Promise<void>;
	devices(): AnchorDevicesState | null;
	/** Records the index authority state. Refuses to lower `seq`. */
	commitDevices(seq: bigint, digest: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * One anchor per path per process, enforced. A second `openStateAnchor` for a
 * live path is the in-process shape of the two-owners bug and is refused loudly
 * rather than allowed to interleave writes.
 *
 * Cross-process exclusion is host-service's daemon singleton (`src/daemon`), and
 * on top of that every `raiseSend` re-reads the file and re-checks the owner
 * token before writing, so a second process would be caught at its first
 * reservation rather than silently sharing a counter.
 */
const OPEN_ANCHORS = new Set<string>();

export async function openStateAnchor(rootDir: string): Promise<StateAnchor> {
	if (typeof rootDir !== "string" || rootDir.length === 0) {
		throw new Error(`${LOG_PREFIX} openStateAnchor requires a root directory`);
	}
	const anchorPath = join(rootDir, ANCHOR_FILENAME);
	const witnessPath = join(rootDir, SEND_WITNESS_FILENAME);
	const registryKey = resolvePath(anchorPath);
	if (OPEN_ANCHORS.has(registryKey)) {
		throw new Error(
			`${LOG_PREFIX} the state anchor at ${anchorPath} is already open in this process — two lifecycles cannot own the nonce high-water mark`,
		);
	}
	OPEN_ANCHORS.add(registryKey);

	try {
		const existing = await readAnchorFile(anchorPath);
		const minted = existing === null;
		let previousEpoch = existing === null ? 0n : BigInt(existing.epoch);
		let epoch = previousEpoch + 1n;
		if (epoch > 0xff_ff_ff_ff_ff_ff_ffn) {
			throw new StateRollbackError(
				`the mount epoch reached ${epoch}, which is not a value this install can have legitimately produced`,
			);
		}

		let current: StoredAnchorFile =
			existing === null
				? {
						v: 1,
						generation: base64UrlEncode(randomBytes(16)),
						epoch: epoch.toString(10),
						send: readLegacySendNonceState(
							await readLegacySendNonceText(rootDir),
							rootDir,
						),
						devices: null,
					}
				: { ...existing, epoch: epoch.toString(10) };

		let closed = false;
		const serialise = createSerialiser();

		/**
		 * Read-modify-write against the FILE, not against memory.
		 *
		 * Re-reading costs one `readFile` per reservation (once every ~57 000
		 * nonces) and per authority change, and it is what makes the monotonic and
		 * ownership checks true statements about durable state rather than about
		 * this object's beliefs.
		 *
		 * The epoch is checked here too, not just `generation`. It is documented as
		 * "monotonic, one per mount", and before this check `claimSend` and
		 * `commitDevices` stamped the epoch this object was holding over whatever
		 * was on disk — so a duplicate spawn could push the file's epoch BACKWARDS,
		 * after which `devices.json` legitimately led the anchor and the next clean
		 * start refused with "the anchor was rolled back" and sent the maintainer to
		 * re-pair every device. Neither writer stamps an epoch any more (the
		 * `...onDisk` spread carries the durable one); this refuses the regression
		 * outright if a future one tries.
		 */
		const mutate = async (
			apply: (onDisk: StoredAnchorFile) => StoredAnchorFile,
		): Promise<void> => {
			if (closed) {
				throw new Error(`${LOG_PREFIX} the state anchor is closed`);
			}
			const onDisk = await readAnchorFile(anchorPath);
			if (onDisk === null) {
				throw new StateRollbackError(
					`the state anchor at ${anchorPath} disappeared while the bridge was running`,
				);
			}
			if (onDisk.generation !== current.generation) {
				throw new StateRollbackError(
					`the state anchor at ${anchorPath} was replaced by a different install generation while the bridge was running`,
				);
			}
			const next = apply(onDisk);
			if (BigInt(next.epoch) < BigInt(onDisk.epoch)) {
				throw new StateRollbackError(
					`refusing to lower the anchor's mount epoch from ${onDisk.epoch} to ${next.epoch} — the epoch is what proves devices.json and the anchor belong to the same timeline`,
				);
			}
			await writeAnchorFile(anchorPath, next);
			current = next;
		};

		// The epoch is durable BEFORE anything derived from it is used or handed
		// out, so a crash burns an epoch and never repeats one.
		//
		// It goes through `mutate` when a file already exists, rather than writing
		// the snapshot read at the top of this function. That snapshot was captured
		// across an `await`, so blind-writing it discarded anything another writer
		// had committed in between — including a RAISED `send.highWater`, silently,
		// which is precisely the property this module claims is impossible. Mutating
		// re-reads, re-derives the epoch from the durable one and preserves `send`
		// and `devices` exactly as they are on disk.
		if (existing === null) {
			await writeAnchorFile(anchorPath, current);
			// Two processes that both read ENOENT above would both mint, and the
			// later rename would silently discard the earlier generation — after
			// which each believes it owns a counter the other is also using. The
			// mint is the one write with no durable predecessor to compare against,
			// so it is confirmed by re-reading instead: exactly one of the two finds
			// its own generation on disk and continues, and the other refuses here.
			// A losing process that got past this line would still be stopped at its
			// first `mutate` by the generation check, so this only makes the refusal
			// immediate and legible rather than deferred to an unrelated write.
			const confirmed = await readAnchorFile(anchorPath);
			if (confirmed === null || confirmed.generation !== current.generation) {
				throw new StateRollbackError(
					`the state anchor at ${anchorPath} was minted by another process while this one was minting it — two lifecycles cannot share the send-nonce counter`,
				);
			}
		} else {
			await mutate((onDisk) => {
				previousEpoch = BigInt(onDisk.epoch);
				epoch = previousEpoch + 1n;
				if (epoch > 0xff_ff_ff_ff_ff_ff_ffn) {
					throw new StateRollbackError(
						`the mount epoch reached ${epoch}, which is not a value this install can have legitimately produced`,
					);
				}
				return { ...onDisk, epoch: epoch.toString(10) };
			});
		}
		// Only once the mark it carried is durable in the anchor. Retiring it
		// first would let a crash in between lose the high-water mark entirely and
		// restart the counter under the SAME prefix.
		await retireLegacySendNonceState(rootDir);

		// (SEND-WITNESS) Reconcile the second durable record of the mark, and seed
		// it for installs that predate it. Done AFTER the epoch write so a crash
		// mid-reconcile leaves the pair in the same shape the next start handles.
		const witness = await readSendWitness(witnessPath);
		if (witness !== null) {
			if (witness.generation !== current.generation) {
				throw new StateRollbackError(
					`${witnessPath} was written under install generation ${witness.generation} but the anchor is ${current.generation} — the anchor was deleted or replaced while the send-nonce witness survived, so nothing can prove the counter is current`,
				);
			}
			const witnessed = BigInt(witness.highWater);
			if (current.send === null) {
				throw new StateRollbackError(
					`${witnessPath} witnesses send-nonce high-water ${witnessed} but the anchor carries no send state at all — the anchor's send state was rolled back`,
				);
			}
			if (current.send.prefix !== witness.prefix) {
				throw new StateRollbackError(
					`${witnessPath} witnesses a different send-nonce prefix than the anchor holds — counter state from two installs cannot be recombined`,
				);
			}
			if (witnessed > BigInt(current.send.highWater)) {
				// The anchor's most recent rename was lost (no directory fsync on
				// win32) or a crash landed between the witness write and the anchor
				// write. Either way the witnessed mark is the one that may already
				// have been handed out; resuming below it would repeat nonces.
				console.error(
					`${LOG_PREFIX} send-nonce high-water mark restored from the witness: the anchor says ${current.send.highWater}, the witness says ${witness.highWater}. Resuming from the witness. If this repeats every start, the anchor file is not reaching disk.`,
				);
				// Derived INSIDE the write from what is on disk, never from the
				// snapshot read above: the lift must raise the mark and change
				// nothing else, and a blind write of a pre-read `send` is the exact
				// shape of the bug this module was reviewed for.
				await mutate((onDisk) => {
					if (onDisk.send === null) {
						throw new StateRollbackError(
							`${witnessPath} witnesses send-nonce high-water ${witnessed} but the anchor's send state vanished while it was being lifted`,
						);
					}
					if (BigInt(onDisk.send.highWater) >= witnessed) return onDisk;
					return {
						...onDisk,
						send: { ...onDisk.send, highWater: witness.highWater },
					};
				});
			}
		}
		if (current.send !== null) {
			const send = current.send;
			if (
				witness === null ||
				BigInt(witness.highWater) < BigInt(send.highWater)
			) {
				await writeSendWitness(witnessPath, {
					v: 1,
					generation: current.generation,
					prefix: send.prefix,
					highWater: send.highWater,
				});
			}
		}

		/**
		 * (SEND-WITNESS) Raise the witness BEFORE the anchor, always.
		 *
		 * That order is what makes the loss of the anchor's rename detectable: the
		 * witness is then the higher of the two and the next start resumes from it.
		 * The reverse order would make a lost anchor rename look identical to a
		 * never-attempted one. A crash between the two writes leaves the witness
		 * ahead, which costs at most one skipped block of counters and never
		 * repeats one.
		 *
		 * WHAT ACTUALLY MAKES THE WITNESS'S RENAME DURABLE FIRST — and it is not
		 * the call order on its own. The two renames are issued microseconds apart
		 * and `syncDirectory` is a no-op on win32, so nothing here forces either
		 * directory entry. What separates them is the ANCHOR's own write: every
		 * `mutate` goes through `writeFileDurable`, whose `handle.sync()` on the
		 * anchor's tmp file is a FlushFileBuffers, and that forces NTFS's volume
		 * metadata log — which by then already carries the witness's rename record.
		 * The anchor's content fsync is therefore what PUBLISHES the witness's
		 * rename, and it is why a crash cannot discard the witness while keeping
		 * the anchor at a mark nonces were issued from.
		 *
		 * THAT MAKES THE PAIRING LOAD-BEARING: a `raiseWitness` must always be
		 * followed by an anchor `mutate` before any nonce above the raised mark is
		 * emitted. Both call sites below do exactly that, unconditionally, and
		 * `reserve` only advances `reservedThrough` after `raiseSend` resolves. A
		 * witness-only path — a periodic refresh, a raise whose `mutate` producer
		 * throws and then issues anyway — would put both renames in one unflushed
		 * log window, where a hard reset takes both and the counter silently
		 * resumes at a used value with nothing logged. Do not add one.
		 *
		 * RAISE ONLY, ENFORCED AGAINST THE FILE. An unconditional write here would
		 * be a hole in the middle of the fix: `raiseSend` writes the witness before
		 * `mutate` decides whether the raise is legal at all, so a stale owner's
		 * refill — the case `mutate` correctly refuses — would still have LOWERED
		 * the witness on its way to being refused, and a lowered witness cannot
		 * bound a rolled-back anchor. The witness is therefore read back and a
		 * lower value is refused outright rather than written, which also means a
		 * witness whose own rename was lost is repaired on the next raise instead
		 * of being trusted. A raise to the value already durable writes nothing.
		 */
		const raiseWitness = async (
			prefix: string,
			highWater: bigint,
		): Promise<void> => {
			const onDisk = await readSendWitness(witnessPath);
			if (onDisk !== null) {
				if (onDisk.generation !== current.generation) {
					throw new StateRollbackError(
						`${witnessPath} is witnessing install generation ${onDisk.generation} but this bridge is running ${current.generation} — the send-nonce witness was replaced while the bridge was running`,
					);
				}
				if (onDisk.prefix !== prefix) {
					throw new StateRollbackError(
						`${witnessPath} is witnessing a different send-nonce prefix than the one being raised — counter state from two installs cannot be recombined`,
					);
				}
				const durable = BigInt(onDisk.highWater);
				if (highWater < durable) {
					throw new StateRollbackError(
						`refusing to lower the send-nonce witness from ${durable} to ${highWater} — the witness is the only record that can prove a rolled-back anchor went backwards, so it may only ever be raised`,
					);
				}
				if (highWater === durable) return;
			}
			await writeSendWitness(witnessPath, {
				v: 1,
				generation: current.generation,
				prefix,
				highWater: highWater.toString(10),
			});
		};

		return {
			generation: current.generation,
			epoch,
			previousEpoch,
			minted,

			send(): AnchorSendState | null {
				return current.send === null ? null : decodeSend(current.send);
			},

			claimSend(prefix, highWater) {
				return serialise(async () => {
					if (prefix.length !== NONCE_PREFIX_BYTES) {
						throw new Error(
							`${LOG_PREFIX} send-nonce prefix must be ${NONCE_PREFIX_BYTES} bytes, got ${prefix.length}`,
						);
					}
					const owner = base64UrlEncode(randomBytes(16));
					await raiseWitness(base64UrlEncode(prefix), highWater);
					await mutate((onDisk) => {
						if (onDisk.send !== null) {
							const durable = decodeSend(onDisk.send);
							if (highWater < durable.highWater) {
								throw new StateRollbackError(
									`refusing to claim the send-nonce counter at ${highWater} when ${durable.highWater} is already durable — a lower mark re-issues nonces that were handed out`,
								);
							}
							if (base64UrlEncode(durable.prefix) !== base64UrlEncode(prefix)) {
								throw new StateRollbackError(
									"the send-nonce prefix on disk does not match the one being claimed",
								);
							}
						}
						return {
							...onDisk,
							send: {
								prefix: base64UrlEncode(prefix),
								highWater: highWater.toString(10),
								owner,
							},
						};
					});
					return owner;
				});
			},

			raiseSend(owner, through) {
				return serialise(async () => {
					const held = current.send;
					if (held === null) {
						throw new StateRollbackError(
							"the send-nonce state vanished from the anchor while the bridge was running",
						);
					}
					await raiseWitness(held.prefix, through);
					await mutate((onDisk) => {
						if (onDisk.send === null) {
							throw new StateRollbackError(
								"the send-nonce state vanished from the anchor while the bridge was running",
							);
						}
						const durable = decodeSend(onDisk.send);
						if (durable.owner !== owner) {
							throw new StateRollbackError(
								"a newer lifecycle owns the send-nonce counter — this owner is stale and must not write",
							);
						}
						if (through < durable.highWater) {
							throw new StateRollbackError(
								`refusing to lower the send-nonce high-water mark from ${durable.highWater} to ${through}`,
							);
						}
						return {
							...onDisk,
							send: { ...onDisk.send, highWater: through.toString(10) },
						};
					});
				});
			},

			devices(): AnchorDevicesState | null {
				return current.devices === null
					? null
					: {
							seq: BigInt(current.devices.seq),
							digest: current.devices.digest,
						};
			},

			commitDevices(seq, digest) {
				return serialise(async () => {
					await mutate((onDisk) => {
						if (onDisk.devices !== null) {
							const durableSeq = BigInt(onDisk.devices.seq);
							if (seq < durableSeq) {
								throw new StateRollbackError(
									`refusing to lower the device-index sequence from ${durableSeq} to ${seq} — that is how a revoked device comes back`,
								);
							}
							if (seq === durableSeq && digest !== onDisk.devices.digest) {
								throw new StateRollbackError(
									`the device index changed without advancing its sequence (${seq})`,
								);
							}
						}
						return {
							...onDisk,
							devices: { seq: seq.toString(10), digest },
						};
					});
				});
			},

			async close(): Promise<void> {
				if (closed) return;
				closed = true;
				// Drain whatever is still enqueued before releasing the registry slot.
				// The serialiser owns its chain, so the way to wait for it is to queue
				// behind it: this no-op runs strictly after the last pending write has
				// settled, and cannot itself reject.
				await serialise(async () => undefined);
				OPEN_ANCHORS.delete(registryKey);
			},
		};
	} catch (error) {
		OPEN_ANCHORS.delete(registryKey);
		throw error;
	}
}

function decodeSend(stored: NonNullable<StoredAnchorFile["send"]>): {
	prefix: Uint8Array;
	highWater: bigint;
	owner: string;
} {
	const prefix = base64UrlDecode(stored.prefix);
	if (prefix.length !== NONCE_PREFIX_BYTES) {
		throw new StateRollbackError(
			`the anchor's send-nonce prefix is ${prefix.length} bytes, expected ${NONCE_PREFIX_BYTES}`,
		);
	}
	const highWater = BigInt(stored.highWater);
	if (highWater < 0n) {
		throw new StateRollbackError(
			"the anchor's send-nonce high-water mark is negative",
		);
	}
	return { prefix, highWater, owner: stored.owner };
}

/**
 * Reads the anchor.
 *
 * ABSENT is `null` and is the only tolerated failure — it is the first run.
 * UNPARSABLE or MALFORMED THROWS. An earlier revision responded to corrupt
 * nonce state by minting a fresh random 32-bit prefix, which is failing OPEN on
 * the one input that must never be permissive: a random prefix can collide with
 * one already in use, and a collision plus a counter restarting at 1 is
 * guaranteed nonce reuse.
 */
async function readAnchorFile(
	anchorPath: string,
): Promise<StoredAnchorFile | null> {
	let text: string;
	try {
		text = await readFile(anchorPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StateRollbackError(
			`${anchorPath} is not valid JSON (${(error as Error).message})`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new StateRollbackError(`${anchorPath} is not a JSON object`);
	}
	const record = parsed as Partial<StoredAnchorFile>;
	if (record.v !== 1) {
		throw new StateRollbackError(
			`${anchorPath} has version ${String(record.v)}, expected 1`,
		);
	}
	if (!isCanonicalWireId(record.generation)) {
		throw new StateRollbackError(`${anchorPath} has no usable generation`);
	}
	if (typeof record.epoch !== "string" || !/^[0-9]+$/.test(record.epoch)) {
		throw new StateRollbackError(`${anchorPath} has no usable epoch`);
	}
	const send = record.send;
	if (send !== null && send !== undefined) {
		if (
			typeof send.prefix !== "string" ||
			typeof send.highWater !== "string" ||
			!/^[0-9]+$/.test(send.highWater) ||
			typeof send.owner !== "string" ||
			send.owner.length === 0
		) {
			throw new StateRollbackError(`${anchorPath} has malformed send state`);
		}
	}
	const devices = record.devices;
	if (devices !== null && devices !== undefined) {
		if (
			typeof devices.seq !== "string" ||
			!/^[0-9]+$/.test(devices.seq) ||
			typeof devices.digest !== "string" ||
			devices.digest.length === 0
		) {
			throw new StateRollbackError(`${anchorPath} has malformed device state`);
		}
	}
	return {
		v: 1,
		generation: record.generation,
		epoch: record.epoch,
		send: send ?? null,
		devices: devices ?? null,
	};
}

async function writeAnchorFile(
	anchorPath: string,
	file: StoredAnchorFile,
): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(file, null, "\t")}\n`, "utf8");
	await writeFileDurable(anchorPath, bytes, KEY_FILE_MODE);
}

/**
 * (SEND-WITNESS) The mark, mirrored into a file the anchor's own anti-rollback
 * machinery does not write.
 *
 * WHY. `writeFileDurable` gives content durability and rename ORDER, but
 * `syncDirectory` is a no-op on win32 — libuv maps `fs.rename` to
 * `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` with no `MOVEFILE_WRITE_THROUGH`,
 * so the most recent rename can sit in the NTFS log for seconds. A hard reset in
 * that window reverts `state-anchor.json` to its PREVIOUS version, and nothing
 * in `assertNoRollback` can see it: `generation` is per-install, `epoch` is per
 * mount, and `(seq, digest)` only move when the device authority moves — so a
 * revert to any earlier version written during the SAME mount matches every
 * witness that existed. `send.highWater` lived in exactly one file, next to the
 * fields meant to police it, and reverted with them. Each mount does exactly one
 * `claimSend`, so the exposure was one lost rename per mount, not a rare race.
 *
 * WHAT THIS BUYS. Two files, two directory entries, two renames. Losing the
 * anchor's rename alone is now visible: the witness still carries the higher
 * mark, and `openStateAnchor` resumes from it. Losing the witness's rename alone
 * is harmless — the reconciliation only ever takes the MAXIMUM, so a witness
 * behind the anchor is ignored.
 *
 * LOSING BOTH IN ONE CRASH IS NOT THE TREE CASE, AND IS NOT OUT OF SCOPE. Two
 * renames issued microseconds apart can sit in the same unflushed NTFS log
 * window, and nothing about writing one first would separate them. What separates
 * them is that the anchor is written with `writeFileDurable`, whose content
 * `handle.sync()` forces the volume metadata log — publishing the witness's
 * earlier rename record along with it — and no nonce above a raised mark is
 * emitted until that anchor write has resolved (`reserve` advances
 * `reservedThrough` only after `raiseSend` returns). So the pair is ordered by an
 * fsync, not by call order, and the guarantee survives exactly as long as every
 * `raiseWitness` is followed by an anchor write before anything is issued. See
 * the invariant stated at `raiseWitness` itself; a witness-only write path would
 * silently restore the original rewind, which is why one must not be added.
 *
 * WHY THIS RESUMES RATHER THAN REFUSES. The witness is written BEFORE the
 * anchor, so "witness ahead of anchor" is also the ordinary shape of a crash
 * landing between the two writes. Refusing there would take the bridge down and
 * demand a full re-pair for an ordinary power cut. Resuming at the maximum
 * enforces the actual invariant — never resume below a mark that was ever
 * durable — without a false positive, and it is loud: the lift is logged as an
 * error with both marks.
 *
 * ABSENT is `null` (first run, or an install that predates this file).
 * UNPARSABLE or MALFORMED THROWS, for the same reason `readAnchorFile` does: a
 * witness that cannot be read cannot bound the counter, and guessing is the
 * failure this file exists to prevent.
 */
interface StoredSendWitness {
	v: 1;
	/** Must equal the anchor's install generation. */
	generation: string;
	/** 4 raw bytes as base64url. Must equal the anchor's send prefix. */
	prefix: string;
	/** The first counter NOBODY may use without reserving again. */
	highWater: string;
}

async function readSendWitness(
	witnessPath: string,
): Promise<StoredSendWitness | null> {
	let text: string;
	try {
		text = await readFile(witnessPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StateRollbackError(
			`${witnessPath} is not valid JSON (${(error as Error).message}), so the send-nonce mark it witnesses is unknown`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new StateRollbackError(`${witnessPath} is not a JSON object`);
	}
	const record = parsed as Partial<StoredSendWitness>;
	if (record.v !== 1) {
		throw new StateRollbackError(
			`${witnessPath} has version ${String(record.v)}, expected 1`,
		);
	}
	if (!isCanonicalWireId(record.generation)) {
		throw new StateRollbackError(`${witnessPath} has no usable generation`);
	}
	if (typeof record.prefix !== "string" || record.prefix.length === 0) {
		throw new StateRollbackError(`${witnessPath} has no usable send prefix`);
	}
	if (
		typeof record.highWater !== "string" ||
		!/^[0-9]+$/.test(record.highWater)
	) {
		throw new StateRollbackError(
			`${witnessPath} has no usable high-water mark`,
		);
	}
	return {
		v: 1,
		generation: record.generation,
		prefix: record.prefix,
		highWater: record.highWater,
	};
}

async function writeSendWitness(
	witnessPath: string,
	file: StoredSendWitness,
): Promise<void> {
	const bytes = Buffer.from(`${JSON.stringify(file, null, "\t")}\n`, "utf8");
	await writeFileDurable(witnessPath, bytes, KEY_FILE_MODE);
}

/**
 * Carries a pre-anchor `send-nonce.json` high-water mark into a freshly minted
 * anchor.
 *
 * Skipping it would restart the counter under the SAME install prefix, which is
 * the nonce-reuse this whole module exists to prevent. A file that exists but
 * cannot be read is therefore fatal, not ignorable. Retiring the file is a
 * SEPARATE step (`retireLegacySendNonceState`) that runs only after the anchor
 * carrying the mark is durable.
 */
async function readLegacySendNonceText(
	rootDir: string,
): Promise<string | null> {
	try {
		return await readFile(join(rootDir, LEGACY_SEND_NONCE_FILENAME), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function readLegacySendNonceState(
	text: string | null,
	rootDir: string,
): StoredAnchorFile["send"] {
	if (text === null) return null;
	const legacyPath = join(rootDir, LEGACY_SEND_NONCE_FILENAME);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StateRollbackError(
			`the pre-anchor ${legacyPath} exists but is unparsable (${(error as Error).message}), so the counter it already handed out is unknown`,
		);
	}
	const record = parsed as Partial<{
		v: number;
		prefix: string;
		reservedThrough: string;
	}>;
	if (
		record.v !== 1 ||
		typeof record.prefix !== "string" ||
		typeof record.reservedThrough !== "string" ||
		!/^[0-9]+$/.test(record.reservedThrough)
	) {
		throw new StateRollbackError(
			`the pre-anchor ${legacyPath} exists but is malformed, so the counter it already handed out is unknown`,
		);
	}
	const prefix = base64UrlDecode(record.prefix);
	if (prefix.length !== NONCE_PREFIX_BYTES) {
		throw new StateRollbackError(
			`the pre-anchor ${legacyPath} holds a ${prefix.length}-byte prefix, expected ${NONCE_PREFIX_BYTES}`,
		);
	}
	return {
		prefix: record.prefix,
		highWater: record.reservedThrough,
		// Not a live owner — the first `claimSend` replaces it. A non-empty
		// placeholder keeps the file shape valid for `readAnchorFile`.
		owner: "legacy-migration-unowned",
	};
}

async function retireLegacySendNonceState(rootDir: string): Promise<void> {
	try {
		await unlink(join(rootDir, LEGACY_SEND_NONCE_FILENAME));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	await syncDirectory(rootDir);
}

// ---------------------------------------------------------------------------
// §3.1 — K_dev custody
// ---------------------------------------------------------------------------

export interface KeyStore {
	/** Persists a freshly derived K_dev for a newly paired device. */
	put(deviceId: DeviceId, deviceKey: Uint8Array): Promise<string>;
	/** Loads K_dev by the record's `keyRef`. Returns null for an unknown device. */
	load(keyRef: string): Promise<Uint8Array | null>;
	/**
	 * Writes the revocation tombstone INTO the key file (§5.1 keeps the key, so
	 * the device can still open its own sealed 403). Idempotent.
	 */
	markRevoked(
		keyRef: string,
		atMs: number,
		reason: RevokeReason,
	): Promise<void>;
	/**
	 * The tombstone, or null when the key file says the device is live. `null`
	 * for a missing key file too — a device with no key material cannot be
	 * authorised by anything, so there is nothing to re-apply.
	 */
	revocationOf(
		keyRef: string,
	): Promise<{ revokedAtMs: number; revokeReason: RevokeReason } | null>;
	/** Wipes a revoked device's key material. */
	destroy(keyRef: string): Promise<void>;
}

interface StoredKeyFile {
	v: 2;
	keyRef: string;
	deviceId: DeviceId;
	/**
	 * The install generation this key was minted under. Binds key material to the
	 * anchor: a key file and a counter state from different installs can never be
	 * recombined into a "fresh-looking" pair.
	 */
	anchorGeneration: string;
	/** K_dev, 32 raw bytes as base64url. NEVER logged, never returned on the wire. */
	k: string;
	createdAtMs: number;
	/**
	 * (REVOKE-TOMBSTONE) Revocation recorded next to the key, not only in the
	 * index. Restoring an older `devices.json` therefore cannot re-authorise a
	 * revoked device: `device-store` re-applies whatever this says at load.
	 */
	revokedAtMs: number | null;
	revokeReason: RevokeReason | null;
}

export function createKeyStore(
	devicesDir: string,
	anchor: StateAnchor,
): KeyStore {
	if (typeof devicesDir !== "string" || devicesDir.length === 0) {
		throw new Error(
			`${LOG_PREFIX} createKeyStore requires a devices directory`,
		);
	}
	if (!anchor || typeof anchor.generation !== "string") {
		throw new Error(`${LOG_PREFIX} createKeyStore requires the state anchor`);
	}

	const pathFor = (keyRef: string): string => {
		if (!isCanonicalWireId(keyRef)) {
			// Validated at the boundary: a keyRef reaches here from a persisted
			// device record, and a malformed one must never be turned into a path.
			throw new Error(
				`${LOG_PREFIX} malformed keyRef ${JSON.stringify(keyRef)} — expected a canonical 22-character base64url id`,
			);
		}
		return join(devicesDir, `${keyRef}${KEY_FILE_SUFFIX}`);
	};

	const readKeyFile = async (keyRef: string): Promise<StoredKeyFile | null> => {
		let text: string;
		try {
			text = await readFile(pathFor(keyRef), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} is not a JSON object`,
			);
		}
		const record = parsed as Partial<StoredKeyFile>;
		if (record.v !== 2 || typeof record.k !== "string") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} is malformed (v=${String(record.v)})`,
			);
		}
		if (record.keyRef !== keyRef) {
			// The file was renamed or swapped. Fail loud: silently trusting it
			// would let a mis-filed key decrypt for the wrong device record.
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} records a different keyRef`,
			);
		}
		if (record.anchorGeneration !== anchor.generation) {
			throw new StateRollbackError(
				`key file for ${keyRef} was minted under install generation ${String(record.anchorGeneration)} but the state anchor is ${anchor.generation} — key material and counter state are from different installs`,
			);
		}
		if (typeof record.deviceId !== "string") {
			throw new Error(`${LOG_PREFIX} key file for ${keyRef} has no deviceId`);
		}
		const revokedAtMs = record.revokedAtMs ?? null;
		const revokeReason = record.revokeReason ?? null;
		if ((revokedAtMs === null) !== (revokeReason === null)) {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} has revokedAtMs and revokeReason out of step`,
			);
		}
		if (revokedAtMs !== null && typeof revokedAtMs !== "number") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} has a non-numeric revokedAtMs`,
			);
		}
		if (revokeReason !== null && typeof revokeReason !== "string") {
			throw new Error(
				`${LOG_PREFIX} key file for ${keyRef} has a non-string revokeReason`,
			);
		}
		return {
			v: 2,
			keyRef,
			deviceId: record.deviceId as DeviceId,
			anchorGeneration: record.anchorGeneration,
			k: record.k,
			createdAtMs:
				typeof record.createdAtMs === "number" ? record.createdAtMs : 0,
			revokedAtMs,
			revokeReason,
		};
	};

	const writeKeyFile = async (file: StoredKeyFile): Promise<void> => {
		const bytes = Buffer.from(JSON.stringify(file), "utf8");
		try {
			await writeFileDurable(pathFor(file.keyRef), bytes, KEY_FILE_MODE);
		} finally {
			// The serialised K_dev leaves the heap as soon as it has been written,
			// win or lose.
			bytes.fill(0);
		}
	};

	return {
		async put(deviceId, deviceKey) {
			if (deviceKey.length !== KEY_BYTES) {
				throw new Error(
					`${LOG_PREFIX} K_dev must be ${KEY_BYTES} bytes, got ${deviceKey.length}`,
				);
			}
			// Random, so a repeated deviceId can never address an existing key file.
			const keyRef = base64UrlEncode(randomBytes(16));
			const target = pathFor(keyRef);
			// `wx` first, purely to prove the random keyRef is unused; the durable
			// write then replaces it. Without the exclusive probe a (astronomically
			// unlikely) collision would silently overwrite a live device's key.
			const probe = await open(target, "wx", KEY_FILE_MODE);
			await probe.close();
			await writeKeyFile({
				v: 2,
				keyRef,
				deviceId,
				anchorGeneration: anchor.generation,
				k: base64UrlEncode(deviceKey),
				createdAtMs: Date.now(),
				revokedAtMs: null,
				revokeReason: null,
			});
			return keyRef;
		},

		async load(keyRef) {
			const record = await readKeyFile(keyRef);
			if (record === null) return null;
			const key = base64UrlDecode(record.k);
			if (key.length !== KEY_BYTES) {
				zero(key);
				throw new Error(
					`${LOG_PREFIX} key file for ${keyRef} holds ${key.length} bytes, expected ${KEY_BYTES}`,
				);
			}
			return key;
		},

		async markRevoked(keyRef, atMs, reason) {
			const record = await readKeyFile(keyRef);
			if (record === null) {
				// No key material to invalidate. The index record is still revoked by
				// the caller; there is simply nothing here to stamp.
				return;
			}
			if (record.revokedAtMs !== null) {
				// Idempotent: the first revocation time is the truthful one.
				return;
			}
			await writeKeyFile({
				...record,
				revokedAtMs: atMs,
				revokeReason: reason,
			});
		},

		async revocationOf(keyRef) {
			const record = await readKeyFile(keyRef);
			if (record === null) return null;
			if (record.revokedAtMs === null || record.revokeReason === null) {
				return null;
			}
			return {
				revokedAtMs: record.revokedAtMs,
				revokeReason: record.revokeReason,
			};
		},

		async destroy(keyRef) {
			const target = pathFor(keyRef);
			// Overwrite before unlink. HONEST LIMIT: on a copy-on-write or
			// log-structured filesystem this does not reach the original blocks; it
			// is a reduction of the window, not an erasure guarantee.
			try {
				const handle = await open(target, "r+");
				try {
					const { size } = await handle.stat();
					if (size > 0) {
						const scrub = Buffer.alloc(size, 0);
						await handle.write(scrub, 0, scrub.length, 0);
						await handle.sync();
					}
				} finally {
					await handle.close();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return;
			}
			await unlink(target).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			await syncDirectory(devicesDir);
		},
	};
}

// ---------------------------------------------------------------------------
// §3.1 — steady-state key schedule
// ---------------------------------------------------------------------------

/**
 * Rejects a K_dev that is the wrong length OR all zero.
 *
 * The all-zero test is not decoration. Once `zero()` / `zeroDirectionalKeys`
 * are in use on the request path, an already-wiped buffer is a REAL input this
 * function can receive, and 32 zero bytes are a perfectly valid HKDF PRK: the
 * derivation would succeed and hand back keys that decrypt nothing, presenting
 * as an unexplained storm of `unknown_device` tag failures with no diagnostic
 * pointing anywhere near the wipe. A genuine K_dev is HKDF output, so all-zero
 * is unreachable at 2^-256 and can only mean "this buffer was consumed".
 *
 * Mirrors the all-zero rejection `x25519` already performs in `crypto.ts`, for
 * the same reason: silently agreeing on a key that is not secret is worse than
 * refusing.
 */
function assertDeviceKey(deviceKey: Uint8Array): void {
	if (deviceKey.length !== KEY_BYTES) {
		throw new Error(
			`${LOG_PREFIX} K_dev must be ${KEY_BYTES} bytes, got ${deviceKey.length}`,
		);
	}
	if (isAllZero(deviceKey)) {
		throw new Error(
			`${LOG_PREFIX} K_dev is all zero — the buffer has already been wiped, or the key file was truncated. Load it again; deriving from a wiped buffer would produce keys that silently fail every GCM tag.`,
		);
	}
}

/** §3.1 — K_c2s / K_s2c from K_dev. Cached per device; never persisted separately. */
export function deriveDirectionalKeys(deviceKey: Uint8Array): DirectionalKeys {
	assertDeviceKey(deviceKey);
	return {
		c2s: hkdfExpandLabel(deviceKey, HKDF_LABEL_SEAL_C2S, KEY_BYTES),
		s2c: hkdfExpandLabel(deviceKey, HKDF_LABEL_SEAL_S2C, KEY_BYTES),
	};
}

/**
 * Best-effort wipe of a derived directional pair once a request is done with it.
 *
 * Exists so the sealed pipeline has ONE call to make rather than two `zero()`s
 * it can half-forget; the same honest limit as `zero` applies.
 */
export function zeroDirectionalKeys(keys: DirectionalKeys): void {
	zero(keys.c2s);
	zero(keys.s2c);
}

/**
 * §3.1 — K_evt for one WebSocket stream, bound to the ticket id.
 *
 * Takes the ticket id's RAW 16 BYTES, not its base64url text. The client derives
 * the same key from the same 16 bytes; passing the 22-char string here would
 * produce a 37-byte `info` against the client's 31-byte one and every frame
 * would fail its GCM tag while the sealed HTTP path kept working — a permanent
 * reconnect ladder that looks like a transport bug.
 */
export function deriveEventKey(
	deviceKey: Uint8Array,
	ticketIdBytes: Uint8Array,
): Uint8Array {
	assertDeviceKey(deviceKey);
	if (ticketIdBytes.length !== WIRE_ID_BYTES) {
		throw new Error(
			`${LOG_PREFIX} ticketId must be ${WIRE_ID_BYTES} raw bytes, got ${ticketIdBytes.length}`,
		);
	}
	return hkdfExpandInfo(
		deviceKey,
		hkdfInfoWithSuffix(HKDF_LABEL_SEAL_EVT, ticketIdBytes),
		KEY_BYTES,
	);
}

// ---------------------------------------------------------------------------
// §3.4 — the bridge's own send nonces
// ---------------------------------------------------------------------------

/**
 * The bridge's own send-side nonce state for K_s2c / K_evt, with an independent
 * prefix and counter. Write-ahead persisted: increment and fsync BEFORE use, so
 * a crash burns counters and never repeats one.
 */
export interface SendNonceSource {
	next(): Uint8Array;
	/** Flushes the reservation state and stops the source. */
	close(): Promise<void>;
}

/**
 * The single send-nonce source for one mount.
 *
 * OWNERSHIP IS THE POINT. The source takes an owner token from the anchor at
 * construction and every later write presents it. If a newer lifecycle has
 * claimed the counter, this source's next write throws and the source POISONS
 * itself — a stale owner must not be able to write at all, and must not keep
 * emitting either. The high-water mark can only ever move up: `claimSend` and
 * `raiseSend` both re-read the durable value and refuse anything lower, so the
 * "older source closes last and rewinds the mark" path is closed by the anchor
 * rather than by call ordering.
 */
export async function createSendNonceSource(
	anchor: StateAnchor,
): Promise<SendNonceSource> {
	if (!anchor || typeof anchor.claimSend !== "function") {
		throw new Error(
			`${LOG_PREFIX} createSendNonceSource requires the state anchor`,
		);
	}

	const durable = anchor.send();
	// A fresh random prefix is minted ONLY when there is provably no prior send
	// state (a brand-new install). Corrupt state does not reach here: the anchor
	// throws rather than inventing a prefix.
	const prefix =
		durable === null ? randomBytes(NONCE_PREFIX_BYTES) : durable.prefix;
	// Everything up to the persisted high-water mark may already have been handed
	// out before the crash. Resume AT it, never below it.
	let counter =
		durable === null || durable.highWater < NONCE_FIRST_COUNTER
			? NONCE_FIRST_COUNTER
			: durable.highWater;

	let reservedThrough = counter;
	let closed = false;
	/** Set when this source has provably lost ownership. Never cleared. */
	let poisoned: string | null = null;
	let refilling: Promise<void> | null = null;

	// The first block is reserved, owned and durable BEFORE the source is handed
	// out, so the very first nonce this process emits is already covered.
	const owner = await anchor.claimSend(
		prefix,
		counter + NONCE_RESERVATION_BLOCK,
	);
	reservedThrough = counter + NONCE_RESERVATION_BLOCK;

	const reserve = async (): Promise<void> => {
		const target = counter + NONCE_RESERVATION_BLOCK;
		try {
			await anchor.raiseSend(owner, target);
		} catch (error) {
			if (error instanceof StateRollbackError) {
				poisoned = error.message;
				// Said ONCE, at the moment it becomes true, and in terms of the
				// symptom the operator will actually see. Poisoning is permanent by
				// design, and without this line the only evidence is `503
				// bridge_unavailable` on every sealed response and dropped event
				// sockets, from a process whose last log line says `listening`.
				console.error(
					`${LOG_PREFIX} SEND-NONCE SOURCE POISONED — this bridge can no longer seal any response or event frame. Every sealed request will now answer 503 bridge_unavailable and every event socket will drop, for as long as this process lives. It does not recover on its own: restart host-service. Cause: ${error.message}`,
				);
			}
			throw error;
		}
		if (target > reservedThrough) reservedThrough = target;
	};

	const scheduleRefill = (): void => {
		if (closed || poisoned !== null || refilling !== null) return;
		refilling = reserve()
			.catch((error: unknown) => {
				// Not swallowed: the next `next()` past the reservation throws, and
				// this is the line that says why.
				console.error(
					`${LOG_PREFIX} send-nonce reservation refill failed — the bridge will refuse to seal once the current block is exhausted:`,
					error,
				);
			})
			.finally(() => {
				refilling = null;
			});
	};

	return {
		next(): Uint8Array {
			if (closed) {
				throw new Error(`${LOG_PREFIX} send-nonce source is closed`);
			}
			if (poisoned !== null) {
				throw new Error(
					`${LOG_PREFIX} send-nonce source lost ownership of the counter and refuses to emit: ${poisoned}`,
				);
			}
			if (counter >= reservedThrough) {
				// Refusing is the only safe answer: emitting an unreserved counter
				// would let a crash repeat it, and a repeated (key, nonce) pair
				// destroys AES-GCM outright.
				scheduleRefill();
				throw new Error(
					`${LOG_PREFIX} send-nonce reservation exhausted at ${counter} — refusing to emit an unreserved nonce`,
				);
			}
			const value = counter;
			counter += 1n;
			if (reservedThrough - counter <= NONCE_REFILL_THRESHOLD) {
				scheduleRefill();
			}
			const nonce = new Uint8Array(NONCE_PREFIX_BYTES + NONCE_COUNTER_BYTES);
			nonce.set(prefix, 0);
			Buffer.from(
				nonce.buffer,
				nonce.byteOffset,
				nonce.length,
			).writeBigUInt64BE(value, NONCE_PREFIX_BYTES);
			return nonce;
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			if (refilling !== null) await refilling;
			try {
				if (poisoned === null) {
					// NEVER below what was already reserved. Burning the unspent tail of
					// the block is free; rewinding into it is the bug this guards.
					await anchor.raiseSend(
						owner,
						counter > reservedThrough ? counter : reservedThrough,
					);
				}
			} finally {
				zero(prefix);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// §3.5 — the replay cache
// ---------------------------------------------------------------------------
//
// It lives ENTIRELY in `crypto.ts` (`ReplayCache` / `createReplayCache`). This
// module used to carry a thin adapter over it whose only job was to hide the
// clock argument; callers pass their own request-instant now, so the adapter is
// gone and there is exactly one admit/compact/retention implementation.
