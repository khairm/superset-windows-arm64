import { Badge } from "@superset/ui/badge";
import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@superset/ui/context-menu";
import { Progress } from "@superset/ui/progress";
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
import { formatResetIn } from "renderer/lib/formatResetTime";

function UsageMetric({
	label,
	percent,
}: {
	label: string;
	percent: number | null;
}) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-1.5">
			<span className="w-7 shrink-0 text-[10px] text-muted-foreground">
				{label}
			</span>
			<Progress
				value={percent === null ? 0 : Math.min(100, Math.max(0, percent))}
				className="h-1 min-w-10 flex-1"
			/>
			<span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
				{percent === null ? "—" : `${percent}%`}
			</span>
		</div>
	);
}

function accountDisabledReason(account: ClaudeAccount): string | null {
	if (account.dead) return account.deadReason ?? "Authentication unavailable";
	if (!account.enabled) return "Disabled";
	return null;
}

function resetText(resetsAt: string | null): string {
	if (resetsAt === null) return "Reset time unavailable";
	return `Resets in ${formatResetIn(new Date(resetsAt))}`;
}

function AccountRow({
	account,
	trayDefaultSlug,
	selectedSlug,
	isPending,
	onSelect,
}: {
	account: ClaudeAccount;
	trayDefaultSlug: string | null;
	selectedSlug: string | null;
	isPending: boolean;
	onSelect: (slug: string) => void;
}) {
	const disabledReason = accountDisabledReason(account);
	const disabled = disabledReason !== null || isPending;

	return (
		<ContextMenuItem
			disabled={disabled}
			onSelect={() => onSelect(account.slug)}
			className={cn(
				"flex-col items-stretch gap-1.5 py-2",
				disabledReason && "opacity-50",
			)}
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className="flex w-4 shrink-0 items-center">
					{selectedSlug === account.slug && <LuCheck className="size-3.5" />}
				</span>
				<span className="shrink-0 font-medium">{account.slug}</span>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{account.displayName}
				</span>
				{trayDefaultSlug === account.slug && (
					<Badge
						variant="outline"
						className="rounded px-1 py-0 text-[9px] font-normal text-muted-foreground"
					>
						tray default
					</Badge>
				)}
			</div>
			<div className="flex items-center gap-3 pl-6 pr-1">
				{disabledReason ? (
					<span className="truncate text-[10px] text-muted-foreground">
						{disabledReason}
					</span>
				) : (
					<>
						<UsageMetric label="5h" percent={account.fivePct} />
						<UsageMetric label="week" percent={account.sevenPct} />
						<span className="shrink-0 text-[10px] text-muted-foreground">
							{resetText(account.fiveResetsAt)}
						</span>
					</>
				)}
			</div>
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

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<LuUserRound className="size-4 mr-2" />
				Account
			</ContextMenuSubTrigger>
			<ContextMenuSubContent className="w-[26rem] max-h-[min(32rem,calc(100vh-2rem))] overflow-y-auto">
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
				{roster.data.accounts.map((account) => (
					<AccountRow
						key={account.slug}
						account={account}
						trayDefaultSlug={roster.data.trayDefaultSlug}
						selectedSlug={
							state.data.state === "pinned" ? state.data.slug : null
						}
						isPending={setAccount.isPending}
						onSelect={chooseAccount}
					/>
				))}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}
