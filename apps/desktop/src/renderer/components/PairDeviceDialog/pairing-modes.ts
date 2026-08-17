/**
 * (REMOTE-CODE-PAIRING) THE renderer's vocabulary for the two ways in, in one
 * table.
 *
 * The desktop calls them `qr` / `code` (what the user chooses) and the bridge
 * calls the resulting windows `lan` / `remote` (what the exchange is). That
 * translation used to be an inline ternary at the one place it mattered — the
 * poll, deciding whether a verdict was about THIS window — which is exactly the
 * kind of mapping that gets copied to a second site and then disagrees with the
 * first. There is one copy, and it is here, next to the dialog and the toggle
 * that both read it.
 */
export type PairingMode = "qr" | "code";

export const PAIRING_MODES = {
	qr: {
		label: "Scan a QR code",
		/** What `pairingState` calls a window opened this way. */
		pairingKind: "lan",
		description:
			"Open Superset Companion on your phone, choose Pair this phone, and scan this code. Both devices must be on the same Wi-Fi — the exchange never leaves your network.",
	},
	code: {
		label: "Pair with a code",
		pairingKind: "remote",
		description:
			"Open Superset Companion on your phone, choose Pair with a code, and type the digits below. This works from anywhere — the code is never sent, so only a phone that has been told it can finish pairing.",
	},
} as const satisfies Record<
	PairingMode,
	{ label: string; pairingKind: string; description: string }
>;
