// (WIN-HIDE-FIRST-IMPORT) Side-effect module. Every process entry imports it
// FIRST, so the patch lands before any bundled module captures a
// child_process function (a top-level `promisify(execFile)` keeps whatever it
// saw). createRequire hands back the mutable CommonJS exports object.
import { createRequire } from "node:module";
import { applyWindowsChildProcessPatch } from "./windows-child-process-patch";

applyWindowsChildProcessPatch(
	createRequire(import.meta.url)("node:child_process"),
	process.platform,
);
