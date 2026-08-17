export const AUTO_UPDATE_STATUS = {
	IDLE: "idle",
	CHECKING: "checking",
	DOWNLOADING: "downloading",
	READY: "ready",
	/** Transient: the app just relaunched on a new version after an install */
	UPDATED: "updated",
	ERROR: "error",
} as const;

export type AutoUpdateStatus =
	(typeof AUTO_UPDATE_STATUS)[keyof typeof AUTO_UPDATE_STATUS];

export interface AutoUpdateProgress {
	percent: number;
	transferredBytes: number;
	totalBytes: number;
}

export interface AutoUpdateStatusEvent {
	status: AutoUpdateStatus;
	version?: string;
	error?: string;
	progress?: AutoUpdateProgress;
}

// (CLOUD-SEVERANCE-P1) Points at the FORK's releases, not upstream's. This is
// the single releases URL for the whole app — the menu, the tray and the command
// palette all open it now that the updater is permanently disabled. It was
// upstream's superset-sh URL and currently has no other consumer, which is
// exactly why it is repointed rather than left: a merge that starts using it
// would otherwise silently send our Windows ARM64 users to upstream's x64 build.
export const RELEASES_URL =
	"https://github.com/khairm/superset-windows-arm64/releases";
