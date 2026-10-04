import { formatDateTime } from "@superset/i18n/format";
import { Badge } from "@superset/ui/badge";
import {
	ContextMenuCheckboxItem,
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
	type ClaudeAccountRoster,
	type ClaudeScheduleFailure,
	type ClaudeScheduleTarget,
	type ClaudeScheduleView,
	type ClaudeWorkspaceAccountState,
	useClaudeAccountCapability,
	useClaudeAccountRoster,
	useClaudeWorkspaceAccountState,
	useClearClaudeScheduledSwitch,
	useScheduleClaudeSwitch,
	useSetClaudeAutoSwitch,
	useSetClaudeWorkspaceAccount,
} from "renderer/hooks/host-service/useClaudeAccounts";
import { useWorkspaceHostUrl } from "renderer/hooks/host-service/useWorkspaceHostUrl";
import { useNow } from "renderer/hooks/useNow";
import { formatResetCompact } from "renderer/lib/formatResetTime";
import {
	displayFablePct,
	FIVE_HOUR_WINDOW_MS,
	formatUsagePct,
	isWeeklyExhausted,
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
const DIMMED_CLASS = "opacity-50";
const METRIC_GROUP_CLASS = "inline-flex items-center gap-1";

function AccountMetrics({
	account,
	fablePct,
	dimmed,
	now,
}: {
	account: ClaudeAccount;
	fablePct: number | null;
	dimmed: boolean;
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
			<span className={cn(METRIC_GROUP_CLASS, dimmed && DIMMED_CLASS)}>
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
			</span>
			<span className={cn(METRIC_GROUP_CLASS, dimmed && DIMMED_CLASS)}>
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
					percent={fablePct}
					resetsAt={account.sevenResetsAt}
					windowMs={WEEKLY_WINDOW_MS}
					now={now}
				/>
			</span>
			<ResetSpan
				resetsAt={account.sevenResetsAt}
				windowMs={WEEKLY_WINDOW_MS}
				now={now}
			/>
		</div>
	);
}

export function AccountRow({
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
	const exhausted = isWeeklyExhausted(
		account.sevenPct,
		account.sevenResetsAt,
		now,
	);
	const disabled = account.dead || !account.enabled || isPending;
	const dimmed = exhausted && !disabled;
	const fablePct = displayFablePct(exhausted, account.fablePct);
	return (
		<ContextMenuItem
			// A pinned-but-tray-hidden account stays listed but is not a valid
			// switch target — the host rejects disabled accounts.
			disabled={disabled}
			onSelect={() => onSelect(account.slug)}
			className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2"
		>
			<span
				className={cn("flex w-4 shrink-0 items-center", dimmed && DIMMED_CLASS)}
			>
				{selectedSlug === account.slug && <LuCheck className="size-3.5" />}
			</span>
			<span
				className={cn(
					"flex min-w-0 items-center gap-2",
					dimmed && DIMMED_CLASS,
				)}
			>
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
			<AccountMetrics
				account={account}
				fablePct={fablePct}
				dimmed={dimmed}
				now={now}
			/>
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

// (CLAUDE-ACCOUNT-SCHEDULE)
const SCHEDULE_FAILURE_REASONS: Record<ClaudeScheduleFailure, string> = {
	"target-unavailable": "the account was hidden, missing or needed re-login",
	"pi-unavailable": "the Pi could not be reached",
	"default-unavailable": "the tray default was signed out",
	"profile-unavailable": "this worktree's credentials file could not be read",
	"not-run": "it could not run within 30 minutes of the set time",
	error: "unexpected error",
};

const DISABLED_SUB_TRIGGER_CLASS = "data-[disabled]:opacity-50";

function scheduleTargetLabel(target: ClaudeScheduleTarget): string {
	return target.kind === "default" ? "Default (tray)" : target.slug;
}

function formatClock(ms: number): string {
	return formatDateTime(ms, {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
}

function formatDayClock(ms: number): string {
	return formatDateTime(ms, {
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
}

function upcomingFiveHourReset(
	account: ClaudeAccount,
	now: number,
): number | null {
	if (account.fiveResetsAt === null) return null;
	const resetAt = Date.parse(account.fiveResetsAt);
	return Number.isFinite(resetAt) && resetAt > now ? resetAt : null;
}

function ScheduleTargetSubmenu({
	target,
	resetAt,
	disabled,
	isScheduling,
	onScheduleAt,
	onRequestCustomTime,
}: {
	target: ClaudeScheduleTarget;
	resetAt: number | null;
	disabled: boolean;
	isScheduling: boolean;
	onScheduleAt: (target: ClaudeScheduleTarget, fireAt: number) => void;
	onRequestCustomTime: (target: ClaudeScheduleTarget) => void;
}) {
	const resetLabel =
		target.kind === "default"
			? "At its 5h reset"
			: `At its 5h reset (${resetAt === null ? "unknown" : formatClock(resetAt)})`;
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger
				disabled={disabled}
				className={DISABLED_SUB_TRIGGER_CLASS}
			>
				{scheduleTargetLabel(target)}
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				<ContextMenuItem
					disabled={resetAt === null || isScheduling}
					onSelect={() => {
						if (resetAt !== null) onScheduleAt(target, resetAt);
					}}
				>
					{resetLabel}
				</ContextMenuItem>
				<ContextMenuItem onSelect={() => onRequestCustomTime(target)}>
					Custom time…
				</ContextMenuItem>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

function ScheduleStatusRows({
	schedule,
	isClearing,
	onClear,
}: {
	schedule: ClaudeScheduleView;
	isClearing: boolean;
	onClear: (scheduleId: string) => void;
}) {
	const summary = `${scheduleTargetLabel(schedule.target)} at ${formatDayClock(schedule.fireAt)}`;
	if (schedule.status === "pending") {
		return (
			<>
				<ContextMenuItem inset disabled>
					{`Scheduled: ${summary}`}
				</ContextMenuItem>
				<ContextMenuItem
					inset
					disabled={isClearing}
					onSelect={() => onClear(schedule.scheduleId)}
				>
					Cancel scheduled switch
				</ContextMenuItem>
			</>
		);
	}
	return (
		<>
			<ContextMenuItem
				inset
				disabled
				title={schedule.lastError ?? undefined}
				className="text-destructive data-[disabled]:pointer-events-auto"
			>
				{`Scheduled switch to ${summary} failed: ${SCHEDULE_FAILURE_REASONS[schedule.failure]}`}
			</ContextMenuItem>
			<ContextMenuItem
				inset
				disabled={isClearing}
				onSelect={() => onClear(schedule.scheduleId)}
			>
				Dismiss
			</ContextMenuItem>
		</>
	);
}

function accountsUnavailableLabel(
	configured: boolean,
	roster: ClaudeAccountRoster | undefined,
): string {
	return !configured && roster === undefined
		? "Account credentials unavailable"
		: "Accounts unavailable";
}

export function ClaudeAccountMenu({
	hostUrl,
	workspaceId,
	state,
	roster,
	configured,
	exited,
	onRequestCustomTime,
}: {
	hostUrl: string;
	workspaceId: string;
	state: ClaudeWorkspaceAccountState;
	roster: ClaudeAccountRoster | undefined;
	configured: boolean;
	exited: boolean;
	onRequestCustomTime: (target: ClaudeScheduleTarget) => void;
}) {
	const setAccount = useSetClaudeWorkspaceAccount(hostUrl, workspaceId);
	const setAutoSwitch = useSetClaudeAutoSwitch(hostUrl, workspaceId);
	const scheduleSwitch = useScheduleClaudeSwitch(hostUrl, workspaceId);
	const clearSchedule = useClearClaudeScheduledSwitch(hostUrl, workspaceId);
	// Ticking clock so an open submenu's countdowns and pace colours stay live.
	const now = useNow(60_000).getTime();

	const following = state.state === "following";
	const selectedSlug = following ? null : state.slug;

	const chooseAccount = (slug: string | null) => {
		if (setAccount.isPending || slug === selectedSlug) return;
		setAccount.mutate(slug, {
			onError: (error) =>
				toast.error("Couldn't change workspace account", {
					description: error.message,
				}),
		});
	};
	const scheduleAt = (target: ClaudeScheduleTarget, fireAt: number) => {
		if (scheduleSwitch.isPending) return;
		scheduleSwitch.mutate({ target, fireAt });
	};
	const clear = (scheduleId: string) => {
		if (clearSchedule.isPending) return;
		clearSchedule.mutate(scheduleId);
	};

	// Tray-hidden accounts stay out of the list unless this workspace is pinned
	// to one, which has to remain visible to be switched away from.
	const visibleAccounts =
		roster?.accounts.filter(
			(account) => account.enabled || account.slug === selectedSlug,
		) ?? [];

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<LuUserRound className="size-4 mr-2" />
				Account
			</ContextMenuSubTrigger>
			<ContextMenuSubContent className="w-[30rem] max-h-[min(32rem,calc(100vh-2rem))] overflow-y-auto">
				{roster === undefined ? (
					<DisabledAccountItem>
						{accountsUnavailableLabel(configured, roster)}
					</DisabledAccountItem>
				) : (
					<>
						<ContextMenuItem
							disabled={setAccount.isPending}
							onSelect={() => chooseAccount(null)}
							className="flex items-center gap-2"
						>
							<span className="flex w-4 shrink-0 items-center">
								{following && <LuCheck className="size-3.5" />}
							</span>
							<span className="flex-1">Default (tray)</span>
							<span className="text-xs text-muted-foreground">
								{roster.trayDefaultSlug ?? "Unavailable"}
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
									trayDefaultSlug={roster.trayDefaultSlug}
									selectedSlug={selectedSlug}
									isPending={setAccount.isPending}
									now={now}
									onSelect={chooseAccount}
								/>
							))
						)}
					</>
				)}
				<ContextMenuSeparator />
				{/* (CLAUDE-ACCOUNT-AUTO-SWITCH) */}
				<ContextMenuCheckboxItem
					checked={state.autoSwitch}
					disabled={following || exited || setAutoSwitch.isPending}
					onCheckedChange={(enabled) => setAutoSwitch.mutate(enabled)}
				>
					Auto-switch
				</ContextMenuCheckboxItem>
				<ContextMenuSub>
					<ContextMenuSubTrigger
						inset
						disabled={exited || roster === undefined}
						className={DISABLED_SUB_TRIGGER_CLASS}
					>
						Schedule switch
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						<ScheduleTargetSubmenu
							target={{ kind: "default" }}
							resetAt={null}
							disabled={following}
							isScheduling={scheduleSwitch.isPending}
							onScheduleAt={scheduleAt}
							onRequestCustomTime={onRequestCustomTime}
						/>
						{roster?.accounts
							.filter((account) => account.enabled)
							.map((account) => (
								<ScheduleTargetSubmenu
									key={account.slug}
									target={{ kind: "account", slug: account.slug }}
									resetAt={upcomingFiveHourReset(account, now)}
									disabled={false}
									isScheduling={scheduleSwitch.isPending}
									onScheduleAt={scheduleAt}
									onRequestCustomTime={onRequestCustomTime}
								/>
							))}
					</ContextMenuSubContent>
				</ContextMenuSub>
				{state.schedule !== null && (
					<ScheduleStatusRows
						schedule={state.schedule}
						isClearing={clearSchedule.isPending}
						onClear={clear}
					/>
				)}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

export function ClaudeAccountPicker({
	workspaceId,
	exited,
	onRequestCustomTime,
}: {
	workspaceId: string;
	exited: boolean;
	onRequestCustomTime: (target: ClaudeScheduleTarget) => void;
}) {
	const hostUrl = useWorkspaceHostUrl(workspaceId);
	const capability = useClaudeAccountCapability(hostUrl);
	const isManaged = capability.data?.managed === true;
	const state = useClaudeWorkspaceAccountState(hostUrl, workspaceId, isManaged);
	const roster = useClaudeAccountRoster(hostUrl, isManaged);

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
	if (state.data === undefined) {
		return (
			<DisabledAccountItem>
				{accountsUnavailableLabel(capability.data.configured, roster.data)}
			</DisabledAccountItem>
		);
	}

	return (
		<ClaudeAccountMenu
			hostUrl={hostUrl}
			workspaceId={workspaceId}
			state={state.data}
			roster={roster.data}
			configured={capability.data.configured}
			exited={exited}
			onRequestCustomTime={onRequestCustomTime}
		/>
	);
}
