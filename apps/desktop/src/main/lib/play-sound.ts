import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

interface PlaySoundCallbacks {
	onComplete?: () => void;
	isCanceled?: () => boolean;
	onProcessChange?: (process: ChildProcess) => void;
}

/**
 * Plays a sound file at the given volume using platform-specific commands.
 * Returns the primary ChildProcess, or null if playback was skipped.
 *
 * On macOS, volume is controlled via afplay -v (0.0-1.0).
 * On Linux, volume is controlled via paplay --volume (0-65536), with aplay fallback.
 */
export function playSoundFile(
	soundPath: string,
	volume: number = 100,
	callbacks?: PlaySoundCallbacks,
): ChildProcess | null {
	if (!existsSync(soundPath)) {
		console.warn(`[play-sound] Sound file not found: ${soundPath}`);
		return null;
	}

	const volumeDecimal = volume / 100;

	if (process.platform === "darwin") {
		return execFile(
			"afplay",
			["-v", volumeDecimal.toString(), soundPath],
			{ windowsHide: true },
			() => callbacks?.onComplete?.(),
		);
	}

	// Windows: play via PowerShell MediaPlayer with windowsHide
	if (process.platform === "win32") {
		const soundPathNorm = path.resolve(soundPath).replace(/\\/g, "\\\\");
		const script = [
			"Add-Type -AssemblyName PresentationCore;",
			`$mp = New-Object System.Windows.Media.MediaPlayer;`,
			`$mp.Open([System.Uri]::new('${soundPathNorm}'));`,
			`$timeout = [System.DateTime]::Now.AddSeconds(2);`,
			`while(-not $mp.NaturalDuration.HasTimeSpan -and [System.DateTime]::Now -lt $timeout) { Start-Sleep -Milliseconds 50 }`,
			`if($mp.NaturalDuration.HasTimeSpan) { $mp.Volume = ${volumeDecimal}; $mp.Play(); Start-Sleep -Milliseconds ($mp.NaturalDuration.TimeSpan.TotalMilliseconds + 500) }`,
			`else { $mp.Volume = ${volumeDecimal}; $mp.Play(); Start-Sleep -Seconds 3 }`,
			`$mp.Stop(); $mp.Close()`,
		].join(" ");
		const child = execFile(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-STA",
				"-Command",
				script,
			],
			{ windowsHide: true },
			() => callbacks?.onComplete?.(),
		);
		return child;
	}

	// Linux: paplay --volume accepts 0-65536 (65536 = 100%)
	const paVolume = Math.round(volumeDecimal * 65536);
	return execFile(
		"paplay",
		["--volume", paVolume.toString(), soundPath],
		{ windowsHide: true },
		(error) => {
			if (error) {
				if (callbacks?.isCanceled?.()) {
					callbacks?.onComplete?.();
					return;
				}
				if (volume === 0) {
					callbacks?.onComplete?.();
					return;
				}
				const fallback = execFile("aplay", [soundPath], () =>
					callbacks?.onComplete?.(),
				);
				callbacks?.onProcessChange?.(fallback);
				return;
			}
			callbacks?.onComplete?.();
		},
	);
}
