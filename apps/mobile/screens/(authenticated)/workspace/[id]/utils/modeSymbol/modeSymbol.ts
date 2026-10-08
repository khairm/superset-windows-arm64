const SYMBOL_BY_MODE: Record<string, string> = {
	default: "hand.raised",
	acceptEdits: "pencil.line",
	plan: "checklist",
	auto: "sparkles",
	bypassPermissions: "lock.open",
};

export function modeSymbol(modeId: string | undefined): string {
	return (modeId && SYMBOL_BY_MODE[modeId]) || "slider.horizontal.3";
}
