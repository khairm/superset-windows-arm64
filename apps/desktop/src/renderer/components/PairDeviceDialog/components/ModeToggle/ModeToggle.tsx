import { ToggleGroup, ToggleGroupItem } from "@superset/ui/toggle-group";
import { PAIRING_MODES, type PairingMode } from "../../pairing-modes";

interface ModeToggleProps {
	mode: PairingMode;
	onModeChange: (mode: PairingMode) => void;
}

/**
 * (REMOTE-CODE-PAIRING) Which way in — QR or typed code. The shared
 * `ToggleGroup`, not two hand-rolled buttons: the pressed state, the keyboard
 * behaviour and the focus ring then come from the design system rather than from
 * conditional class names that drift from every other toggle in the app.
 */
export function ModeToggle({ mode, onModeChange }: ModeToggleProps) {
	return (
		<ToggleGroup
			type="single"
			size="sm"
			variant="outline"
			value={mode}
			// Radix reports "" when the pressed item is toggled OFF. There is no
			// third state here — one of the two ways in is always selected — so an
			// empty value is ignored rather than allowed to blank the dialog.
			onValueChange={(next: string) => {
				if (next === "qr" || next === "code") onModeChange(next);
			}}
			className="w-full"
		>
			{(Object.keys(PAIRING_MODES) as PairingMode[]).map((value) => (
				<ToggleGroupItem key={value} value={value} className="flex-1">
					{PAIRING_MODES[value].label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
