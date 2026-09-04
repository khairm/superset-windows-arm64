import { Trans, useLingui } from "@lingui/react/macro";
import { FEATURE_FLAGS } from "@superset/shared/constants";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { cn } from "@superset/ui/utils";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useEffect } from "react";
import {
	HiCheck,
	HiChevronUpDown,
	HiOutlineCloud,
	HiOutlineComputerDesktop,
	HiOutlineServer,
} from "react-icons/hi2";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { FormPickerTrigger } from "../../PromptGroup/components/FormPickerTrigger";
import { CLOUD_HOST_ID } from "./constants";
import { useWorkspaceHostOptions } from "./hooks/useWorkspaceHostOptions";

function OnlineDot({ online }: { online: boolean }) {
	const { t } = useLingui();
	return (
		<span
			role="img"
			aria-label={
				online
					? t({
							message: "online",
						})
					: t({
							message: "offline",
						})
			}
			className={cn(
				"inline-block size-1.5 shrink-0 rounded-full",
				online ? "bg-emerald-500" : "bg-muted-foreground/60",
			)}
		/>
	);
}

interface DevicePickerProps {
	hostId: string | null;
	onSelectHostId: (hostId: string | null) => void;
	className?: string;
	/**
	 * Also show relay connectivity for the local device. Cloud-dispatched work
	 * (automations) goes through the relay, so "local" is not inherently online.
	 */
	showLocalOnlineState?: boolean;
	/**
	 * Disables opening via the Radix trigger itself. A button disabled only
	 * through an enclosing <fieldset> still receives pointerdown in Chrome —
	 * the event that opens a DropdownMenu.
	 */
	disabled?: boolean;
}

// `CLOUD_HOST_ID` lives in ./constants on this fork (upstream re-declares it
// here): pure decision code reads it without pulling in the picker component.

function getSelectedIcon(hostId: string | null, machineId: string | null) {
	if (hostId === CLOUD_HOST_ID) {
		return <HiOutlineCloud className="size-4 shrink-0" />;
	}
	if (hostId === null || hostId === machineId) {
		return <HiOutlineComputerDesktop className="size-4 shrink-0" />;
	}
	return <HiOutlineServer className="size-4 shrink-0" />;
}

export function DevicePicker({
	hostId,
	onSelectHostId,
	className,
	showLocalOnlineState = false,
	disabled,
}: DevicePickerProps) {
	const { t } = useLingui();
	const { machineId } = useLocalHostService();
	const { currentDeviceName, localHostIsOnline, otherHosts } =
		useWorkspaceHostOptions();
	// (CLOUD-SEVERANCE-P2) A cloud target remembered from before the severance
	// has no menu entry to point at any more, so the trigger would claim a
	// selection the list cannot show. Unconditional now: there is no flag left
	// to wait on, and no state in which Cloud becomes selectable again.
	useEffect(() => {
		if (hostId === CLOUD_HOST_ID) {
			onSelectHostId(machineId);
		}
	}, [hostId, machineId, onSelectHostId]);
	const isLocal = hostId === null || hostId === machineId;
	const selectedLabel =
		hostId === CLOUD_HOST_ID
			? t({
					message: "Cloud",
				})
			: isLocal
				? (currentDeviceName ??
					t({
						message: "Local Device",
					}))
				: (otherHosts.find((host) => host.id === hostId)?.name ??
					t({
						message: "Unknown Host",
					}));
	// For direct (local) use the app itself is the host, so it's tautologically
	// online and gets no indicator. Relay-dispatched contexts opt into showing
	// the local device's relay connectivity instead.
	const localOnline = showLocalOnlineState ? localHostIsOnline : null;
	const isCloud = hostId === CLOUD_HOST_ID;
	const selectedOnline = isLocal
		? localOnline
		: isCloud
			? null
			: (otherHosts.find((host) => host.id === hostId)?.isOnline ?? false);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={disabled}>
				<FormPickerTrigger
					className={cn("max-w-[140px]", className)}
					aria-label={t({
						message: `Device: ${selectedLabel}`,
					})}
					title={selectedLabel}
				>
					{getSelectedIcon(hostId, machineId)}
					<span className="truncate">{selectedLabel}</span>
					{selectedOnline !== null && <OnlineDot online={selectedOnline} />}
					<HiChevronUpDown className="size-3 shrink-0" />
				</FormPickerTrigger>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-72">
				<DropdownMenuItem onSelect={() => onSelectHostId(machineId)}>
					<HiOutlineComputerDesktop className="size-4" />
					<span className="flex-1">
						<Trans>Local Device</Trans>
					</span>
					{localOnline !== null && <OnlineDot online={localOnline} />}
					{isLocal && <HiCheck className="size-4" />}
				</DropdownMenuItem>
				{/* (CLOUD-SEVERANCE-P2) No Cloud entry. Creating a cloud workspace
				    calls cloudWorkspace.create, which is severed, so the item
				    could only ever produce an error — and every other severed
				    surface in this fork is DELETED rather than left behind a
				    feature flag that happens to be permanently unresolved. The
				    effect above stays: it moves a remembered cloud selection
				    back to this device. */}
				{otherHosts.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<HiOutlineServer className="size-4" />
								<Trans>Other Hosts</Trans>
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="w-72">
								{otherHosts.map((host) => {
									const isSelected = hostId === host.id;

									return (
										<DropdownMenuItem
											key={host.id}
											onSelect={() => onSelectHostId(host.id)}
										>
											<HiOutlineServer className="size-4" />
											<span className="min-w-0 truncate">{host.name}</span>
											<OnlineDot online={host.isOnline} />
											{isSelected && (
												<HiCheck className="ml-auto size-4 shrink-0" />
											)}
										</DropdownMenuItem>
									);
								})}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
