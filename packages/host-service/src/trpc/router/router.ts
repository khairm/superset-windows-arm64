import { router } from "../index";
import { agentToolingRouter } from "./agent-tooling";
import { agentsRouter } from "./agents";
import { attachmentsRouter } from "./attachments";
import { authRouter } from "./auth";
import { browserRouter } from "./browser/browser";
import { claudeAccountsRouter } from "./claude-accounts/claude-accounts";
// (COMPANION-ROUTER-MOUNT) fork-only: the desktop-side pairing + panic surface.
// This token is registered in FEATURES.md against THIS file, not against the
// companion/ directory — a marker satisfied only by fork-only files cannot
// notice when a merge drops the seam that reaches them. Without this mount the
// pairing window and the panic switch are unreachable code.
import { companionRouter } from "./companion";
import { configRouter } from "./config";
import { filesystemRouter } from "./filesystem";
import { gitRouter } from "./git";
import { githubRouter } from "./github";
import { healthRouter } from "./health";
import { hostRouter } from "./host";
import { issuesRouter } from "./issues";
import { notificationsRouter } from "./notifications";
import { portsRouter } from "./ports";
import { projectRouter } from "./project";
import { pullRequestsRouter } from "./pull-requests";
import { settingsRouter } from "./settings";
// (SIDEBAR-MIRROR) fork-only: the renderer's write door for its sidebar
// curation. Registered against THIS file as well as the router directory for
// the same reason the companion mount is — a marker satisfied only by
// fork-only files cannot notice when a merge drops the seam that reaches them,
// and without this mount the mirror is never written and every consumer
// silently falls back to the uncurated `host.db` set.
import { sidebarMirrorRouter } from "./sidebar-mirror";
import { terminalRouter } from "./terminal";
import { terminalAgentsRouter } from "./terminal-agents";
import { usageRouter } from "./usage";
import { workspaceRouter } from "./workspace";
import { workspaceCleanupRouter } from "./workspace-cleanup";
import { workspaceCreationRouter } from "./workspace-creation";
import { workspacesRouter } from "./workspaces";

export const appRouter = router({
	agents: agentsRouter,
	agentTooling: agentToolingRouter,
	attachments: attachmentsRouter,
	auth: authRouter,
	browser: browserRouter,
	claudeAccounts: claudeAccountsRouter,
	health: healthRouter,
	host: hostRouter,
	// (COMPANION-ROUTER-MOUNT) fork-only.
	companion: companionRouter,
	config: configRouter,
	filesystem: filesystemRouter,
	git: gitRouter,
	github: githubRouter,
	issues: issuesRouter,
	notifications: notificationsRouter,
	pullRequests: pullRequestsRouter,
	project: projectRouter,
	ports: portsRouter,
	settings: settingsRouter,
	// (SIDEBAR-MIRROR) fork-only.
	sidebarMirror: sidebarMirrorRouter,
	terminal: terminalRouter,
	terminalAgents: terminalAgentsRouter,
	usage: usageRouter,
	workspace: workspaceRouter,
	workspaces: workspacesRouter,
	workspaceCleanup: workspaceCleanupRouter,
	workspaceCreation: workspaceCreationRouter,
});

export type AppRouter = typeof appRouter;
