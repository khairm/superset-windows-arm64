import { Badge } from "@superset/ui/badge";
import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@superset/ui/context-menu";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import type { ReactNode } from "react";
import { LuCheck, LuUserRound } from "react-icons/lu";
import {
	type ClaudeAccount,
	useClaudeAccountCapability,
	useClaudeAccountRoster,
	useClaudeWorkspaceAccountState,
	useSetClaudeWorkspaceAccount,
} from "renderer/hooks/host-service/useClaudeAccounts";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { useNow } from "renderer/hooks/useNow";
import { formatResetCompact } from "renderer/lib/formatResetTime";
import {
	FIVE_HOUR_WINDOW_MS,
	formatUsagePct,
	USAGE_PACE_CLASS,
	usagePaceLevel,
	WEEKLY_WINDOW_MS,
} from "../../../../utils/claudeUsagePace";

function PctSpan({
	percent,
	resetsAt,
	windowMs,
	now,
}: {
	percent: number | null;
	resetsAt: string | null;
	windowMs: number;
	now: number;
}) {
	if (percent === null) {
		return <span className="w-9 text-right">—</span>;
	}
	return (
		<span
			className={cn(
				"w-9 text-right",
				USAGE_PACE_CLASS[usagePaceLevel(percent, resetsAt, windowMs, now)],
			)}
		>
			{formatUsagePct(percent)}
		</span>
	);
}

function ResetSpan({
	resetsAt,
	windowMs,
	now,
}: {
	resetsAt: string | null;
	windowMs: number;
	now: number;
}) {
	const countdown = formatResetCompact(resetsAt, windowMs, now);
	return (
		<span className="w-14 text-right">
			{countdown !== "" && (
				<>
					→<span className="text-fuchsia-500">{countdown}</span>
				</>
			)}
		</span>
	);
}

const METRICS_CLASS =
	"flex items-center gap-1 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground";

function AccountMetrics({
	account,
	now,
}: {
	account: ClaudeAccount;
	now: number;
}) {
	if (account.dead) {
		return <div className={METRICS_CLASS}>RE-LOGIN needed</div>;
	}
	if (
		account.fivePct === null &&
		account.sevenPct === null &&
		account.fablePct === null
	) {
		return <div className={METRICS_CLASS}>no data yet</div>;
	}
	return (
		<div className={METRICS_CLASS}>
			5h
			<PctSpan
				percent={account.fivePct}
				resetsAt={account.fiveResetsAt}
				windowMs={FIVE_HOUR_WINDOW_MS}
				now={now}
			/>
			<ResetSpan
				resetsAt={account.fiveResetsAt}
				windowMs={FIVE_HOUR_WINDOW_MS}
				now={now}
			/>
			| all:
			<PctSpan
				percent={account.sevenPct}
				resetsAt={account.sevenResetsAt}
				windowMs={WEEKLY_WINDOW_MS}
				now={now}
			/>
			• fable:
			{/* Fable shares the weekly boundary: the Pi emits matching stamps and
			    fableResetsAt is not shipped to the app. */}
			<PctSpan
				percent={account.fablePct}
				resetsAt={account.sevenResetsAt}
				windowMs={WEEKLY_WINDOW_MS}
				now={now}
			/>
			<ResetSpan
				resetsAt={account.sevenResetsAt}
				windowMs={WEEKLY_WINDOW_MS}
				now={now}
			/>
		</div>
	);
}

function AccountRow({
	account,
	trayDefaultSlug,
	selectedSlug,
	isPending,
	now,
	onSelect,
}: {
	account: ClaudeAccount;
	trayDefaultSlug: string | null;
	selectedSlug: string | null;
	isPending: boolean;
	now: number;
	onSelect: (slug: string) => void;
}) {
	return (
		<ContextMenuItem
			// A pinned-but-tray-hidden account stays listed but is not a valid
			// switch target — the host rejects disabled accounts.
			disabled={account.dead || !account.enabled || isPending}
			onSelect={() => onSelect(account.slug)}
			className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2"
		>
			<span className="flex w-4 shrink-0 items-center">
				{selectedSlug === account.slug && <LuCheck className="size-3.5" />}
			</span>
			<span className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 truncate font-medium">{account.slug}</span>
				{trayDefaultSlug === account.slug && (
					<Badge
						variant="outline"
						className="rounded px-1 py-0 text-[9px] font-normal text-muted-foreground"
					>
						tray default
					</Badge>
				)}
			</span>
			<AccountMetrics account={account} now={now} />
		</ContextMenuItem>
	);
}

function DisabledAccountItem({ children }: { children: ReactNode }) {
	return (
		<ContextMenuItem disabled>
			<LuUserRound className="size-4 mr-2" />
			{children}
		</ContextMenuItem>
	);
}

export function ClaudeAccountPicker({ workspaceId }: { workspaceId: string }) {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const capability = useClaudeAccountCapability(hostUrl);
	const isManaged = capability.data?.managed === true;
	const state = useClaudeWorkspaceAccountState(hostUrl, workspaceId, isManaged);
	const roster = useClaudeAccountRoster(hostUrl, isManaged);
	const setAccount = useSetClaudeWorkspaceAccount(hostUrl, workspaceId);
	// Ticking clock so an open submenu's countdowns and pace colours stay live.
	const now = useNow(60_000).getTime();

	if (hostUrl === null) {
		return <DisabledAccountItem>Account unavailable</DisabledAccountItem>;
	}
	if (capability.isPending) {
		return <DisabledAccountItem>Loading accounts…</DisabledAccountItem>;
	}
	if (capability.isError && capability.data === undefined) {
		return <DisabledAccountItem>Account unavailable</DisabledAccountItem>;
	}
	if (!capability.data?.managed) {
		return <DisabledAccountItem>Account not configured</DisabledAccountItem>;
	}
	if (!capability.data.configured && roster.data === undefined) {
		return (
			<DisabledAccountItem>Account credentials unavailable</DisabledAccountItem>
		);
	}
	if (state.data === undefined || roster.data === undefined) {
		return <DisabledAccountItem>Accounts unavailable</DisabledAccountItem>;
	}

	const chooseAccount = (slug: string | null) => {
		if (setAccount.isPending) return;
		setAccount.mutate(slug, {
			onError: (error) =>
				toast.error("Couldn't change workspace account", {
					description: error.message,
				}),
		});
	};

	const selectedSlug = state.data.state === "pinned" ? state.data.slug : null;
	// Tray-hidden accounts stay out of the list unless this workspace is pinned
	// to one, which has to remain visible to be switched away from.
	const visibleAccounts = roster.data.accounts.filter(
		(account) => account.enabled || account.slug === selectedSlug,
	);

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<LuUserRound className="size-4 mr-2" />
				Account
			</ContextMenuSubTrigger>
			<ContextMenuSubContent className="w-[30rem] max-h-[min(32rem,calc(100vh-2rem))] overflow-y-auto">
				<ContextMenuItem
					disabled={setAccount.isPending}
					onSelect={() => chooseAccount(null)}
					className="flex items-center gap-2"
				>
					<span className="flex w-4 shrink-0 items-center">
						{state.data.state === "following" && (
							<LuCheck className="size-3.5" />
						)}
					</span>
					<span className="flex-1">Default (tray)</span>
					<span className="text-xs text-muted-foreground">
						{roster.data.trayDefaultSlug ?? "Unavailable"}
					</span>
				</ContextMenuItem>
				<ContextMenuSeparator />
				{visibleAccounts.length === 0 ? (
					<DisabledAccountItem>No accounts available</DisabledAccountItem>
				) : (
					visibleAccounts.map((account) => (
						<AccountRow
							key={account.slug}
							account={account}
							trayDefaultSlug={roster.data.trayDefaultSlug}
							selectedSlug={selectedSlug}
							isPending={setAccount.isPending}
							now={now}
							onSelect={chooseAccount}
						/>
					))
				)}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}
