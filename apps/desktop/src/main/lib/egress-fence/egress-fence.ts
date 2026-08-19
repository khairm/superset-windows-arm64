import { session, webContents } from "electron";
import log from "electron-log/main";
import {
	classifyInitiator,
	createEgressFenceCore,
	type EgressFenceCore,
	formatObservation,
	type InitiatorClass,
	isAppOwnedWebContents,
	markEgressFenceInstalled,
	shouldBlockEgress,
	toOrigin,
	UNPARSEABLE_ORIGIN,
} from "./egress-fence-core";

/**
 * (EGRESS-FENCE) (FENCE-BLOCK) BLOCKING egress fence for the app's Electron
 * session. Phase 1 shipped this as log-only to prove the allowlist was complete
 * before anything started cancelling; (CLOUD-SEVERANCE-P2) turns it on.
 *
 * WHAT THIS CAN AND CANNOT SEE — read before trusting it as a severance proof.
 * It observes `session.fromPartition("persist:superset")` webRequests ONLY:
 * requests made by the renderer, the preload and the browser-pane webviews.
 * Every one of the following BYPASSES it entirely:
 *
 *   - main-process `fetch`/`net.request`/node http from the Electron main process
 *   - electron-updater (its own net stack; disabled anyway on this fork)
 *   - @sentry/electron's main-process transport, and the renderer's Sentry too
 *     (IPCMode.Classic ships renderer events THROUGH main, not over the session)
 *   - the host-service child process (separate node process, own network stack)
 *   - the bundled superset CLI, and any agent CLI (claude/codex/…) we spawn
 *   - the pty-daemon and anything a user runs inside a terminal
 *
 * So a clean fence log does NOT prove the app is silent. It proves the app's
 * RENDERER is. Narrower still: an origin is recorded only for a request
 * positively attributed to a non-webview webContents. Traffic with no
 * webContentsId (service workers — including one registered by a site in a
 * browser pane) or a destroyed one is counted but never logged, because it is
 * indistinguishable from the user's browsing. The build-time gate
 * (scripts/check-cloud-severance.mjs) is what covers the processes and the
 * traffic this listener cannot attribute.
 */

const PARTITION = "persist:superset";
const FLUSH_INTERVAL_MS = 60_000;

let core: EgressFenceCore | null = null;

/**
 * Classify by resolving the requesting webContents. Absent (main-process or
 * service-worker traffic) and stale (webContents destroyed between the request
 * and this callback) ids must never throw — the callback runs on every request.
 *
 * The app-ownership test is what stops a popup a browsed site opened (a real
 * window on this partition, thanks to `allowpopups`) from being logged as the
 * app's own egress.
 */
function classify(webContentsId: number | undefined): InitiatorClass {
	if (typeof webContentsId !== "number") return "unknown";
	try {
		const contents = webContents.fromId(webContentsId);
		if (!contents || contents.isDestroyed()) {
			return classifyInitiator(null, isAppOwnedWebContents);
		}
		return classifyInitiator(
			{ id: contents.id, type: contents.getType() },
			isAppOwnedWebContents,
		);
	} catch {
		return "unknown";
	}
}

function flush(activeCore: EgressFenceCore): void {
	const changed = activeCore.drainChanged();
	if (changed.length === 0) return;
	const stats = activeCore.stats();
	log.info(
		`[egress-fence] ${changed.length} origin(s) changed (tracked=${stats.tracked} webviewSkipped=${stats.webviewSkipped} unattributedSkipped=${stats.unattributedSkipped} droppedAtCap=${stats.droppedAtCap})`,
	);
	for (const observation of changed) {
		log.info(`[egress-fence]   ${formatObservation(observation)}`);
	}
	if (stats.droppedAtCap > 0) {
		log.warn(
			`[egress-fence] entry cap reached — ${stats.droppedAtCap} request(s) went unrecorded; the log is INCOMPLETE`,
		);
	}
}

/**
 * Register the observer. MUST run before the main window is created; the flag
 * this sets is asserted by MainWindow().
 */
export function installEgressFence(): void {
	if (core) return;
	const activeCore = createEgressFenceCore();
	core = activeCore;

	session
		.fromPartition(PARTITION)
		.webRequest.onBeforeRequest((details, callback) => {
			let cancel = false;
			try {
				const initiator = classify(details.webContentsId);
				activeCore.record({
					url: details.url,
					method: details.method,
					resourceType: details.resourceType,
					initiator,
				});
				cancel = shouldBlockEgress({
					url: details.url,
					resourceType: details.resourceType,
					initiator,
				});
				if (cancel) {
					// Origin only, never the full URL: a blocked request is exactly
					// the kind that might carry a token or a pairing secret.
					log.warn(
						`[egress-fence] (FENCE-BLOCK) BLOCKED ${details.resourceType} to ${
							toOrigin(details.url) ?? UNPARSEABLE_ORIGIN
						}`,
					);
				}
			} catch (error) {
				// A fault in the fence must not break the app. Failing OPEN is the
				// right side to fail on here: the build-time gate, not this
				// listener, is what proves the cloud is unreachable.
				log.warn("[egress-fence] failed to evaluate a request:", error);
				cancel = false;
			}
			callback({ cancel });
		});

	const interval = setInterval(() => flush(activeCore), FLUSH_INTERVAL_MS);
	interval.unref();

	markEgressFenceInstalled();
	log.info(
		// The literal "(FENCE-BLOCK)" is load-bearing, not decoration: the
		// build gate asserts it is PRESENT in the shipped main bundle, because
		// a fence quietly reverted to log-only produces bytes otherwise
		// identical to a blocking one. It lives in a runtime string because
		// comments do not survive the bundler.
		`[egress-fence] (FENCE-BLOCK) installed on ${PARTITION} — BLOCKING app-renderer egress to non-loopback origins; webview + unattributed traffic exempt; origins only, never full URLs`,
	);
}

/** Current observations, for diagnostics. */
export function getEgressFenceSnapshot() {
	return core?.snapshot() ?? [];
}
