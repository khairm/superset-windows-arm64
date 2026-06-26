// (AUTO-RESUME) MAIN -> host-service fire-time send. The host-service child owns the live
// v2 PTYs, the OSC-133 idle signal, and the agent<->terminal binding, so the actual write
// (with preflight) happens there via terminal.writeInputIfIdle. We reach it over the same
// local HTTP + PSK-bearer channel the coordinator already uses for health.check.

import { getHostServiceCoordinator } from "../../host-service-coordinator";
import { readManifest } from "../../host-service-manifest";

export const RESUME_MESSAGE = "resume from exactly where everything was left";

/**
 * Org of a currently-running host-service, from the in-process coordinator (the
 * authoritative live-instance registry) rather than re-deriving from disk.
 */
export function findActiveOrganizationId(): string | null {
	return getHostServiceCoordinator().getActiveOrganizationIds()[0] ?? null;
}

export type SendOutcome = { sent: true } | { sent: false; reason: string };

interface SendArgs {
	organizationId: string;
	workspaceId: string;
	terminalId: string;
	expectedAgentSessionId?: string;
	data?: string;
}

export async function sendResumeViaHost(args: SendArgs): Promise<SendOutcome> {
	const manifest = readManifest(args.organizationId);
	if (!manifest) return { sent: false, reason: "no_manifest" };

	const input = {
		terminalId: args.terminalId,
		workspaceId: args.workspaceId,
		expectedAgentSessionId: args.expectedAgentSessionId,
		data: args.data ?? RESUME_MESSAGE,
	};

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5_000);
	try {
		const res = await fetch(
			`${manifest.endpoint}/trpc/terminal.writeInputIfIdle`,
			{
				method: "POST",
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${manifest.authToken}`,
					"content-type": "application/json",
				},
				// superjson transformer: a plain object input is wrapped as { json }.
				body: JSON.stringify({ json: input }),
			},
		);
		if (!res.ok) return { sent: false, reason: `http_${res.status}` };
		const body = (await res.json()) as {
			result?: { data?: { json?: SendOutcome } };
		};
		const data = body.result?.data?.json;
		if (data && typeof data === "object" && "sent" in data) return data;
		return { sent: false, reason: "bad_response" };
	} catch (error) {
		return {
			sent: false,
			reason: error instanceof Error ? error.name : "fetch_error",
		};
	} finally {
		clearTimeout(timeout);
	}
}
