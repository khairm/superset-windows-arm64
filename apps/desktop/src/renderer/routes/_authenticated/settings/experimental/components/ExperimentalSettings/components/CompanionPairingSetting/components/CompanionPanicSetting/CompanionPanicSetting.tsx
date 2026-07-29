import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useState } from "react";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import {
	describeCompanionStatus,
	useCompanionStatus,
} from "../../hooks/useCompanionStatus";

/**
 * (COMPANION-PANIC-UI) The desktop panic switch, as an actual switch.
 *
 * WHY IT HAS TO BE HERE. `companion.disableWrites` and
 * `companion.revokeAllDevices` are `protectedProcedure`s on the host-service's
 * own tRPC surface and are deliberately unreachable from the phone (§7.8:
 * a stolen device must not be able to restore the privilege the panic switch
 * just took away). That makes the DESKTOP the only possible caller — and until
 * this component existed there was no caller at all, so the emergency control
 * the design promises could only be exercised by hand-crafting a request with
 * the host-service PSK. A guard on a feature that types into live terminals is
 * worth nothing if the person who needs it cannot reach it.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. `CompanionBridge` exposes no read of the
 * device store, so nothing here knows how many devices are paired or whether
 * their writes are currently on. It therefore states neither. The only counts it
 * shows are the ones the mutations themselves return — a fact the server just
 * asserted, not an inference — and the copy is written so a user who has never
 * paired anything still reads something true.
 */
export function CompanionPanicSetting() {
	const status = useCompanionStatus();
	const { activeHostUrl } = status;
	// `action` is deliberately NOT cleared when the dialog closes: it would
	// otherwise flip back to the default mid-exit-animation and the user would
	// watch a "Revoke all" confirmation turn into a "Disable writes" one as it
	// faded out. `dialogOpen` is the open/closed truth on its own.
	const [dialogOpen, setDialogOpen] = useState(false);
	const [action, setAction] = useState<PanicAction>("disable-writes");
	const [reason, setReason] = useState("");
	const [working, setWorking] = useState(false);

	const explanation = describeCompanionStatus(
		status,
		"Emergency controls for devices that are already paired. Both act on every paired device at once and are written to the companion audit log.",
	);
	const canPanic = activeHostUrl !== null && status.data?.running === true;
	// The one cap, as stated by the boundary that enforces it. Until the status
	// query answers there is no number to trust, so the field stays disabled
	// rather than accepting text a submit would reject.
	const reasonMaxChars = status.data?.panicReasonMaxChars ?? null;

	const trimmedReason = reason.trim();
	const reasonValid =
		reasonMaxChars !== null &&
		trimmedReason.length > 0 &&
		trimmedReason.length <= reasonMaxChars;

	const openDialog = (next: PanicAction) => {
		setAction(next);
		setReason("");
		setDialogOpen(true);
	};

	const run = async () => {
		if (!dialogOpen || activeHostUrl === null || !reasonValid) return;
		setWorking(true);
		try {
			const client = getHostServiceClientByUrl(activeHostUrl);
			const { devicesAffected } =
				action === "disable-writes"
					? await client.companion.disableWrites.mutate({
							reason: trimmedReason,
						})
					: await client.companion.revokeAllDevices.mutate({
							reason: trimmedReason,
						});
			// `devicesAffected` is the server's own count, so zero is reported as
			// zero: "nothing was paired" and "three devices were cut off" are
			// different outcomes and a single cheerful success toast for both would
			// hide the case where the user panicked against an empty store.
			if (devicesAffected === 0) {
				toast.warning(
					action === "disable-writes"
						? "No paired devices to disable"
						: "No paired devices to revoke",
					{
						description:
							"The companion bridge reported no live pairings, so nothing changed.",
					},
				);
			} else {
				toast.success(
					action === "disable-writes"
						? `Writes disabled on ${describeDevices(devicesAffected)}`
						: `Revoked ${describeDevices(devicesAffected)}`,
					{
						description:
							action === "disable-writes"
								? "They can still read. Answering and typing are off until write access is restored."
								: "Every device must pair again from scratch.",
					},
				);
			}
			setDialogOpen(false);
		} catch (err) {
			// The bridge lives inside the host-service this call just failed to
			// reach. Never a silent no-op: a panic switch the user believes fired
			// and did not is the worst outcome available here.
			toast.error(
				action === "disable-writes"
					? "Could not disable writes"
					: "Could not revoke devices",
				{ description: err instanceof Error ? err.message : String(err) },
			);
		} finally {
			setWorking(false);
		}
	};

	return (
		<div className="flex items-center justify-between gap-6">
			<div className="min-w-0 flex-1 space-y-0.5">
				<Label className="text-sm font-medium">Companion device access</Label>
				<p className="text-xs text-muted-foreground select-text cursor-text">
					{explanation}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => openDialog("disable-writes")}
					disabled={!canPanic}
				>
					Disable writes…
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => openDialog("revoke-all")}
					disabled={!canPanic}
					className="text-destructive hover:text-destructive"
				>
					Revoke all devices…
				</Button>
			</div>

			<AlertDialog
				open={dialogOpen}
				onOpenChange={(open) => {
					if (!open && !working) setDialogOpen(false);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{action === "revoke-all"
								? "Revoke every paired device?"
								: "Disable writes on every paired device?"}
						</AlertDialogTitle>
						<AlertDialogDescription asChild>
							{action === "revoke-all" ? (
								<div className="space-y-2">
									<p>
										Every paired phone and watch is unpaired. Each one must{" "}
										<span className="font-medium text-foreground">
											pair again from scratch
										</span>{" "}
										with a new QR code before it can read anything.
									</p>
									<p>
										Records are kept for 30 days so the audit log stays
										readable, but no revoked device can act.
									</p>
								</div>
							) : (
								<div className="space-y-2">
									<p>
										Every paired device stops being able to answer questions or
										type into a terminal.{" "}
										<span className="font-medium text-foreground">
											Pairings and keys are kept
										</span>{" "}
										— your phone stays paired, keeps reading agent status, and
										tells you why it stopped writing.
									</p>
									<p>
										Restoring write access is deliberately desktop-only, and the
										control for it is not built yet: until it is, the way back
										is to revoke and pair again.
									</p>
								</div>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>

					<div className="space-y-1.5">
						<Label htmlFor="companion-panic-reason" className="text-sm">
							Reason (recorded in the audit log)
						</Label>
						<Textarea
							id="companion-panic-reason"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							disabled={working || reasonMaxChars === null}
							maxLength={reasonMaxChars ?? undefined}
							rows={2}
							placeholder="Lost my phone"
						/>
						<p className="text-xs text-muted-foreground">
							{reasonMaxChars === null
								? "Waiting for the host service to state the length limit."
								: `Required. ${trimmedReason.length}/${reasonMaxChars} characters.`}
						</p>
					</div>

					<AlertDialogFooter>
						<AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								e.preventDefault();
								void run();
							}}
							disabled={working || !reasonValid}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{working
								? "Applying…"
								: action === "revoke-all"
									? "Revoke all"
									: "Disable writes"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

type PanicAction = "disable-writes" | "revoke-all";

function describeDevices(count: number): string {
	return count === 1 ? "1 device" : `${count} devices`;
}
