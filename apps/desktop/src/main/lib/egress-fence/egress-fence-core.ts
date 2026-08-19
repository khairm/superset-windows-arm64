/**
 * (EGRESS-FENCE) core — pure logic, no electron import, so it is unit-testable.
 *
 * LOG ONLY. Nothing here cancels a request. This phase exists to PROVE the
 * allowlist in scripts/check-cloud-severance.mjs is complete before a later
 * phase starts blocking; a fence that blocked on day one would break features
 * we have not finished inventorying.
 *
 * WHAT IT RECORDS, AND WHY SO LITTLE: origin (`scheme://host:port`), method,
 * resourceType and an initiator class — never a full URL, path, query or
 * fragment. The companion pairing secret travels in a URL FRAGMENT and other
 * URLs carry bearer tokens, so a log of full URLs would be a credential file
 * sitting in the user's profile. Origin is the whole question this phase asks
 * ("what hosts does the app talk to"), so nothing is lost.
 */

export type InitiatorClass = "app-renderer" | "webview" | "unknown";

/** Stand-in origin for a URL that will not parse. Never the URL itself. */
export const UNPARSEABLE_ORIGIN = "<unparseable>";

/** Bounded so a pathological caller cannot grow this map without limit. */
export const DEFAULT_MAX_ENTRIES = 512;

export interface EgressObservationInput {
	url: string;
	method: string;
	resourceType: string;
	initiator: InitiatorClass;
}

export interface EgressObservation {
	origin: string;
	method: string;
	resourceType: string;
	initiator: InitiatorClass;
	firstSeenAt: number;
	count: number;
}

export interface EgressFenceStats {
	/** Distinct tracked keys. */
	tracked: number;
	/** Requests dropped because the map hit its cap (a loud signal, not silent). */
	droppedAtCap: number;
	/**
	 * Count of requests from browser-pane webviews. Deliberately a bare COUNT
	 * with no origins: `persist:superset` is shared by the app renderer AND the
	 * browser pane's <webview> (see usePersistentWebview.ts and
	 * browserRuntimeRegistry.ts, both `partition: "persist:superset"`), so the
	 * user's arbitrary browsing arrives on this listener too. Logging those
	 * origins would turn this into a browsing-history file and would drown the
	 * app's own egress in noise.
	 */
	webviewSkipped: number;
	/**
	 * Count of requests we could NOT positively attribute to the app renderer —
	 * no webContentsId, or an id whose webContents was already destroyed.
	 *
	 * Also a bare count, and that is the whole point: a browser-pane site that
	 * registers a SERVICE WORKER (any PWA) fetches on this partition with no
	 * webContentsId at all, and a webview's in-flight requests can complete
	 * after it is destroyed. Both arrive here indistinguishable from app
	 * traffic, so logging unattributed origins would leak exactly the browsing
	 * history the webview exemption exists to protect — and could flood the
	 * entry cap with it.
	 *
	 * The cost is real and accepted: unattributable APP traffic (for example a
	 * main-process `net.fetch` issued against this session) is now invisible
	 * here too. The fence therefore proves what the RENDERER talks to, and this
	 * counter is the honest measure of how much it could not see.
	 */
	unattributedSkipped: number;
}

/**
 * `scheme://host[:port]`, or bare `scheme:` for schemes with no host
 * (`data:`, `blob:`, `sentry-ipc:`) so no payload or blob id can leak.
 * Returns null only when the URL will not parse at all.
 */
export function toOrigin(rawUrl: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}
	// `URL.origin` is the string "null" for non-special schemes, so build it.
	if (!parsed.hostname) return parsed.protocol;
	const port = parsed.port ? `:${parsed.port}` : "";
	return `${parsed.protocol}//${parsed.hostname}${port}`;
}

/**
 * Classify a request's initiator from the resolved webContents.
 *
 * `app-renderer` requires POSITIVE proof of app ownership, not merely "is not a
 * webview". Browser panes set `allowpopups`, so a site can win a real
 * BrowserWindow — `getType() === "window"`, indistinguishable by type from the
 * app's own chrome — on the shared persist:superset partition. Type alone would
 * therefore log a browsed site's origins as app egress. Only webContents the app
 * itself registered count.
 *
 * @param contents resolved webContents info, or null when the id was absent or
 *                 already destroyed
 * @param isAppOwned membership test for ids the app registered as its own
 */
export function classifyInitiator(
	contents: { id: number; type: string } | null,
	isAppOwned: (id: number) => boolean,
): InitiatorClass {
	if (!contents) return "unknown";
	if (contents.type === "webview") return "webview";
	return isAppOwned(contents.id) ? "app-renderer" : "unknown";
}

// --- app-owned webContents registry -------------------------------------

const appOwnedWebContentsIds = new Set<number>();

/** Called when the app creates one of its OWN windows (see MainWindow). */
export function registerAppWebContents(id: number): void {
	appOwnedWebContentsIds.add(id);
}

export function unregisterAppWebContents(id: number): void {
	appOwnedWebContentsIds.delete(id);
}

export function isAppOwnedWebContents(id: number): boolean {
	return appOwnedWebContentsIds.has(id);
}

/** Test-only: empty the registry. */
export function resetAppWebContentsForTests(): void {
	appOwnedWebContentsIds.clear();
}

export interface EgressFenceCore {
	record(input: EgressObservationInput): void;
	/** Observations first seen or incremented since the previous drain. */
	drainChanged(): EgressObservation[];
	snapshot(): EgressObservation[];
	stats(): EgressFenceStats;
}

export function createEgressFenceCore(options?: {
	now?: () => number;
	maxEntries?: number;
}): EgressFenceCore {
	const now = options?.now ?? Date.now;
	const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;

	const observations = new Map<string, EgressObservation>();
	const changed = new Set<string>();
	let droppedAtCap = 0;
	let webviewSkipped = 0;
	let unattributedSkipped = 0;

	return {
		record(input) {
			// ALLOWLIST, not denylist: an origin is logged only when the request
			// was POSITIVELY identified as the app's own renderer. Webview
			// browsing and anything unattributable (service workers, destroyed
			// webContents) are counted and dropped, because "not provably a
			// webview" is not the same as "provably the app".
			if (input.initiator !== "app-renderer") {
				if (input.initiator === "webview") webviewSkipped++;
				else unattributedSkipped++;
				return;
			}
			const origin = toOrigin(input.url) ?? UNPARSEABLE_ORIGIN;
			// Method and initiator join the key because "the renderer POSTs to X"
			// and "something unattributed GETs X" are different facts, and the
			// cardinality stays tiny (a handful of methods and resource types).
			const key = `${input.initiator}|${input.method}|${input.resourceType}|${origin}`;
			const existing = observations.get(key);
			if (existing) {
				existing.count++;
				changed.add(key);
				return;
			}
			if (observations.size >= maxEntries) {
				// Refuse to grow, and refuse to evict silently: an eviction would
				// make the log lie about what has been seen.
				droppedAtCap++;
				return;
			}
			observations.set(key, {
				origin,
				method: input.method,
				resourceType: input.resourceType,
				initiator: input.initiator,
				firstSeenAt: now(),
				count: 1,
			});
			changed.add(key);
		},

		drainChanged() {
			const out: EgressObservation[] = [];
			for (const key of changed) {
				const observation = observations.get(key);
				if (observation) out.push({ ...observation });
			}
			changed.clear();
			return out;
		},

		snapshot() {
			return [...observations.values()].map((o) => ({ ...o }));
		},

		stats() {
			return {
				tracked: observations.size,
				droppedAtCap,
				webviewSkipped,
				unattributedSkipped,
			};
		},
	};
}

export function formatObservation(observation: EgressObservation): string {
	return `${observation.initiator} ${observation.method} ${observation.resourceType} ${observation.origin} first=${new Date(observation.firstSeenAt).toISOString()} count=${observation.count}`;
}

// --- install proof ------------------------------------------------------

let fenceInstalled = false;

export function markEgressFenceInstalled(): void {
	fenceInstalled = true;
}

export function isEgressFenceInstalled(): boolean {
	return fenceInstalled;
}

/**
 * A RUNTIME proof that the fence is in place before the window that generates
 * traffic exists — not a comment asking the next person to keep the ordering.
 * Called from MainWindow(); throws rather than booting an unobserved window.
 */
export function assertEgressFenceInstalled(): void {
	if (fenceInstalled) return;
	throw new Error(
		"(EGRESS-FENCE) main window is being created before the egress fence was installed — the first requests would go unobserved. Install the fence (installEgressFence()) in the boot path before MainWindow().",
	);
}

/** Test-only: reset the install flag. */
export function resetEgressFenceInstalledForTests(): void {
	fenceInstalled = false;
}

// --- (CLOUD-SEVERANCE-P2) (FENCE-BLOCK): the decision --------------------

/**
 * Schemes that never leave this machine, plus the app's own protocol.
 * `superset-app:` is how the renderer loads itself; `devtools:`/`file:` are
 * tooling; `blob:`/`data:` are in-memory.
 */
const LOCAL_SCHEMES = new Set([
	"superset-app:",
	// The fork's other two protocols, registered beside superset-app: in the
	// boot path. No request on them has ever been observed reaching this
	// listener, but omitting them while listing their sibling would mean the
	// day one does, the app silently loses its bundled fonts or file icons.
	"superset-font:",
	"superset-icon:",
	"devtools:",
	"file:",
	"blob:",
	"data:",
	"chrome-extension:",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Resource types allowed to reach a remote origin from the app renderer.
 *
 * This carve-out is not a loophole, it is the difference between a fence and a
 * broken feature: the browser pane's URL suggestions render `<img
 * src={faviconUrl}>` in the APP renderer rather than inside the webview, so
 * blocking cross-origin images would silently strip every favicon from a
 * feature the user still has. Images cannot exfiltrate a response — the
 * renderer gets pixels, not data it can read — and the CSP already permits
 * exactly this with `img-src https: http:`.
 */
const REMOTE_ALLOWED_RESOURCE_TYPES = new Set(["image"]);

export interface FenceDecisionInput {
	url: string;
	resourceType: string;
	initiator: InitiatorClass;
}

/**
 * Should this request be cancelled?
 *
 * THE RULE: only requests positively attributed to the APP's own renderer are
 * ever blocked. Two exemptions carry the design:
 *
 *   - `webview` — the browser panes. The user's browsing is not this fork's
 *     business, and blocking it would break a feature that has nothing to do
 *     with Superset's cloud.
 *   - `unknown` — traffic with no resolvable webContents. This is NOT laziness:
 *     a site in a browser pane that registers a service worker fetches with no
 *     webContentsId at all, and a destroyed webview's in-flight requests land
 *     here too. Blocking "unknown" would break arbitrary PWAs the user visits
 *     while catching nothing — every process that could still phone home (main,
 *     the host-service, the CLI, agent CLIs, the pty-daemon) bypasses this
 *     listener entirely and is covered by the build-time gate instead.
 */
export function shouldBlockEgress(input: FenceDecisionInput): boolean {
	if (input.initiator !== "app-renderer") return false;

	// The overwhelming majority of app-renderer traffic is the renderer loading
	// itself over superset-app://, and this runs on every request — so answer
	// that case before paying for a URL parse.
	if (input.url.startsWith("superset-app://")) return false;

	let parsed: URL;
	try {
		parsed = new URL(input.url);
	} catch {
		// An app-renderer request whose URL will not parse cannot be shown to be
		// local, and the app has no legitimate use for one.
		return true;
	}

	if (LOCAL_SCHEMES.has(parsed.protocol)) return false;
	if (LOOPBACK_HOSTS.has(parsed.hostname)) return false;

	return !REMOTE_ALLOWED_RESOURCE_TYPES.has(input.resourceType);
}
