import { Button } from "@superset/ui/button";
import { Label } from "@superset/ui/label";
import { useState } from "react";
import { PairDeviceDialog } from "renderer/components/PairDeviceDialog";
import { CompanionPanicSetting } from "./components/CompanionPanicSetting";
import {
	describeCompanionStatus,
	useCompanionStatus,
} from "./hooks/useCompanionStatus";

/**
 * (COMPANION-PAIRING-UI) The entry point the phone's instructions name, plus the
 * emergency controls for devices that pairing produced.
 *
 * A fragment, not a wrapper: the two rows are siblings inside Experimental
 * settings' own `space-y-6` list, so they space exactly like every upstream row
 * and neither one becomes a nested card.
 *
 * The button's availability is derived from the bridge's real state rather than
 * offered unconditionally: `status` separates "you never turned it on" from "it
 * was turned on and did not come up", and those need different actions from the
 * user. Offering "Pair a device" in either case would open a dialog that can
 * only fail, so the row states the reason instead.
 *
 * Local host only. The dialog talks to the bridge on THIS machine — the QR
 * advertises its private LAN address and the typed code is minted by its
 * pairing window — so pairing against a relayed host would produce a credential
 * for the wrong computer.
 */
export function CompanionPairingSetting() {
	const status = useCompanionStatus();
	const { activeHostUrl } = status;
	const [dialogOpen, setDialogOpen] = useState(false);

	const explanation = describeCompanionStatus(
		status,
		// (REMOTE-CODE-PAIRING) Both ways in are named here, because the whole
		// point of the code mode is that the user reaches for it when the QR mode
		// cannot work on their network — and they will not reach for something the
		// row never mentioned.
		"Scan a QR code on the same Wi-Fi, or type an 8-digit code that works from anywhere. Either way the window lasts 120 seconds and works once.",
	);
	const canPair = activeHostUrl !== null && status.data?.running === true;

	return (
		<>
			<div className="flex items-center justify-between gap-6">
				<div className="min-w-0 flex-1 space-y-0.5">
					<Label className="text-sm font-medium">Pair a device</Label>
					<p className="text-xs text-muted-foreground select-text cursor-text">
						{explanation}
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setDialogOpen(true)}
					disabled={!canPair}
					className="shrink-0"
				>
					Pair a device
				</Button>
				{activeHostUrl !== null && (
					<PairDeviceDialog
						open={dialogOpen}
						onOpenChange={setDialogOpen}
						hostUrl={activeHostUrl}
					/>
				)}
			</div>
			{/* (COMPANION-PANIC-UI) */}
			<CompanionPanicSetting />
		</>
	);
}
