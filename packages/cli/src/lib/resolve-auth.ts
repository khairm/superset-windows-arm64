import { type ApiClient, createApiClient } from "./api-client";
import { readConfig, type SupersetConfig } from "./config";
import { resolveLocalOrganizationId } from "./local-org";

export type AuthSource = "override" | "config" | "oauth" | "local";

/** Stands in for a session token. Authenticates nothing; see below. */
const LOCAL_BEARER = "fork-local-mode-no-cloud-session";

export type ResolvedAuth = {
	config: SupersetConfig;
	api: ApiClient;
	bearer: string;
	authSource: AuthSource;
};

export async function resolveAuth(
	apiKeyOption: string | undefined,
): Promise<ResolvedAuth> {
	const config = readConfig();

	// An explicit --api-key wins; otherwise SUPERSET_API_KEY env acts as an
	// override for this invocation (headless/CI). Both beat stored config/OAuth.
	const overrideKey =
		apiKeyOption?.trim() || process.env.SUPERSET_API_KEY?.trim();
	let bearer: string | undefined;
	let authSource: AuthSource;

	if (overrideKey) {
		bearer = overrideKey;
		authSource = "override";
	} else if (config.apiKey?.trim()) {
		bearer = config.apiKey.trim();
		authSource = "config";
	} else {
		// (CLOUD-SEVERANCE-P2) A stored OAuth session in config.json is a STALE
		// CACHE, not a credential — the same status as auth-token.enc on the
		// desktop side. Upstream tried to use it and, once expired, tried to
		// refresh it against the cloud; on this fork that refresh resolves a
		// `.invalid` hostname, fails, and raises "Session expired — run
		// superset auth login" for EVERY command, including `ws`, `terminals`
		// and `agents`, which never needed the cloud and are the whole reason
		// this fallback exists. Since expiry is a matter of time rather than
		// chance, every upgrading user would eventually have hit it. So the
		// branch is gone: a leftover session is ignored, not consulted.
		//
		// The bearer below authenticates nothing. The client it is handed to is
		// severed, and the commands that still work do so by talking to the
		// local host-service over loopback with its own PSK.
		bearer = LOCAL_BEARER;
		authSource = "local";
	}

	// SUPERSET_ORGANIZATION_ID overrides for this invocation (headless/CI, and
	// dev where the CLI must target a specific local org), mirroring how
	// SUPERSET_API_KEY overrides the stored credential. Not persisted.
	//
	// (CLOUD-SEVERANCE-P2) Below that override, the machine's recorded local
	// decision beats config.json: the stored id is a leftover from a cloud
	// session and can name an organization this machine never had data for,
	// while the decision file names the one holding its host.db.
	const organizationId =
		process.env.SUPERSET_ORGANIZATION_ID?.trim() ||
		resolveLocalOrganizationId() ||
		config.organizationId;
	const resolvedConfig: SupersetConfig = { ...config, organizationId };

	const api = createApiClient({ bearer, organizationId });
	return { config: resolvedConfig, api, bearer, authSource };
}
