import { __setSessionShellResolverForTesting } from "../src/terminal/shell-launch.ts";

if (process.platform === "win32") {
	const comspec = process.env.ComSpec;
	if (!comspec) {
		throw new Error("ComSpec is not set; the Windows test shell needs it");
	}
	__setSessionShellResolverForTesting({
		resolve: async () => ({
			kind: "found",
			shell: comspec,
			source: "configured",
		}),
		adoptedShell: () => null,
	});
}
