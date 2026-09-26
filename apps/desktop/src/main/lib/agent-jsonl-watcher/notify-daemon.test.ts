import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
	adoptRunningNotifyDaemon,
	awaitAdoptedNotifyDaemonExit,
	carriedOrMintedSecret,
	claudeProfileDirs,
	claudeProfileDirsAsync,
	claudeTranscriptRoots,
	ensureNotifyDaemon,
	NOTIFY_DAEMON_PORT,
	NOTIFY_SECRET_HEADER,
	NotifyDaemon,
	notifyHandBackToken,
	notifyTrafficVerdict,
	resolvePythonPath,
	SETTINGS_RELOAD_MS,
	stopNotifyDaemon,
	TRAFFIC_GRACE_MS,
	watchClaudeActivity,
	watchNotifyDaemonTraffic,
} from "./notify-daemon";
import { NOTIFY_SCRIPT } from "./pane-map-hook";

// (HOOK-HTTP-DAEMON) The supervisor is exercised against a REAL daemon: a real
// python, a real loopback socket and a real child process, because every
// behaviour here (the health handshake, a refused port, a crash, the rotating
// log) only exists at that boundary.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "notify-daemon-"));
const scriptPath = path.join(root, "superset-notify.py");
fs.writeFileSync(scriptPath, NOTIFY_SCRIPT);

const HEALTH_STUB = `import http.server
import json
import os
import sys
import threading

PORT = int(sys.argv[sys.argv.index("--serve") + 1])


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        body = json.dumps({"ok": True, "pid": os.getpid(), "served": 0})
        raw = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def serve():
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;

/** Answers the handshake, then dies, over and over. */
const DYING_STUB = `${HEALTH_STUB}

threading.Timer(2.0, lambda: os._exit(1)).start()
serve()
`;

/** Answers the handshake, then floods its stderr past the log cap. */
const NOISY_STUB = `${HEALTH_STUB}


def spew():
    for _ in range(40):
        sys.stderr.write("x" * 65536)
        sys.stderr.flush()


threading.Thread(target=spew, daemon=True).start()
serve()
`;

let python = "";
let stubCount = 0;
const running: NotifyDaemon[] = [];

beforeAll(async () => {
	const resolved = await resolvePythonPath();
	if (!resolved) throw new Error("no working python on PATH");
	python = resolved;
});

afterEach(async () => {
	while (running.length > 0) await running.pop()?.stop();
});

afterAll(() => {
	fs.rmSync(root, { force: true, recursive: true });
});

function stub(source: string): string {
	stubCount += 1;
	const file = path.join(root, `stub-${stubCount}.py`);
	fs.writeFileSync(file, source);
	return file;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (typeof address === "string" || address === null) {
				probe.close();
				reject(new Error("probe socket has no port"));
				return;
			}
			probe.close(() => resolve(address.port));
		});
	});
}

/** Takes the port the moment it frees up, the way any other process would. */
function occupySoon(port: number, timeoutMs: number): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const attempt = (): void => {
			const server = net.createServer();
			server.on("error", () => {
				if (Date.now() > deadline) {
					reject(new Error(`could not take 127.0.0.1:${port}`));
					return;
				}
				setTimeout(attempt, 5);
			});
			server.listen(port, "127.0.0.1", () => resolve(server));
		};
		attempt();
	});
}

/**
 * (HOOK-HTTP-DAEMON) Answers the health GET the way the daemon does, and can
 * drop exactly one answer on the floor: what a loopback GET that times out
 * while four workers are mid-delivery-sweep looks like to the traffic watch.
 */
async function healthStubServer(port: number): Promise<{
	server: http.Server;
	dropOneAnswerAfter(atMs: number, thenServed: number): void;
	dropped(): number;
}> {
	let served = 0;
	let dropAtMs: number | null = null;
	let servedAfterDrop = 0;
	let dropped = 0;
	const server = http.createServer((request, response) => {
		if (dropped === 0 && dropAtMs !== null && Date.now() >= dropAtMs) {
			dropped = 1;
			served = servedAfterDrop;
			request.socket.destroy();
			return;
		}
		const body = JSON.stringify({ ok: true, pid: process.pid, served });
		response.writeHead(200, { "Content-Length": Buffer.byteLength(body) });
		response.end(body);
	});
	await new Promise<void>((resolve) => {
		server.listen(port, "127.0.0.1", () => resolve());
	});
	return {
		server,
		dropOneAnswerAfter: (atMs, thenServed) => {
			dropAtMs = atMs;
			servedAfterDrop = thenServed;
		},
		dropped: () => dropped,
	};
}

function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

function start(config: {
	port: number;
	hooksDir: string;
	secret: string;
	scriptPath?: string;
	onPermanentFailure?: () => void;
}): NotifyDaemon {
	const daemon = new NotifyDaemon({
		pythonPath: python,
		scriptPath: config.scriptPath ?? scriptPath,
		hooksDir: config.hooksDir,
		port: config.port,
		secret: config.secret,
		onPermanentFailure: config.onPermanentFailure,
	});
	running.push(daemon);
	return daemon;
}

function hooksDir(): string {
	return fs.mkdtempSync(path.join(root, "hooks-"));
}

async function health(
	port: number,
	secret: string,
): Promise<{ status: number; body: string }> {
	const response = await fetch(
		`http://127.0.0.1:${port}/superset-notify/health`,
		{ headers: { [NOTIFY_SECRET_HEADER]: secret } },
	);
	return { status: response.status, body: await response.text() };
}

/** null when nothing answered at all, which is how a stopped daemon looks. */
async function healthStatus(
	port: number,
	secret: string,
): Promise<number | null> {
	return await health(port, secret)
		.then((answer) => answer.status)
		.catch(() => null);
}

async function until(
	predicate: () => Promise<boolean> | boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

function readState(dir: string): { port: number; pid: number; secret: string } {
	return JSON.parse(
		fs.readFileSync(path.join(dir, "notify-daemon.json"), "utf8"),
	) as { port: number; pid: number; secret: string };
}

describe("notify daemon supervisor", () => {
	it("resolves an absolute python that actually runs", () => {
		expect(path.isAbsolute(python)).toBe(true);
		const probe = childProcess.spawnSync(
			python,
			["-I", "-S", "-c", "print(1)"],
			{ encoding: "utf8" },
		);
		expect(probe.status).toBe(0);
		expect(probe.stdout.trim()).toBe("1");
	});

	it("answers health only after start resolves, and only with the secret", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const daemon = start({ port, hooksDir: dir, secret: "secret-one" });
		const info = await daemon.start();

		expect(info.port).toBe(port);
		expect(info.pid).toBeGreaterThan(0);
		const answer = await health(port, "secret-one");
		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.body)).toEqual({
			ok: true,
			pid: info.pid,
			served: 0,
		});
		expect((await health(port, "wrong")).status).toBe(401);

		expect(readState(dir)).toEqual({
			port,
			pid: info.pid,
			secret: "secret-one",
		});
		// The secret reaches the daemon through a file, never through argv,
		// where every process on the machine could read it.
		expect(
			fs.readFileSync(path.join(dir, "notify-daemon.secret"), "utf8"),
		).toBe("secret-one");
	}, 30_000);

	it("stops the child and leaves no state or secret on disk", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const daemon = start({ port, hooksDir: dir, secret: "secret-stop" });
		await daemon.start();

		await daemon.stop();

		expect(fs.existsSync(path.join(dir, "notify-daemon.json"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "notify-daemon.secret"))).toBe(false);
		expect(
			await until(
				async () => (await healthStatus(port, "secret-stop")) === null,
				5_000,
			),
		).toBe(true);
	});

	it("refuses a port another daemon already owns instead of taking it", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const first = start({ port, hooksDir: dir, secret: "secret-first" });
		await first.start();

		let handedBack = 0;
		const secondDir = hooksDir();
		const second = start({
			port,
			hooksDir: secondDir,
			onPermanentFailure: () => {
				handedBack += 1;
			},
			secret: "secret-second",
		});
		await expect(second.start()).rejects.toThrow(/exited during startup/);

		// The occupant is never killed and never re-keyed.
		expect((await health(port, "secret-first")).status).toBe(200);
		expect((await health(port, "secret-second")).status).toBe(401);
		expect(second.restartCount).toBe(0);
		// ...and the hook entries are handed back to the command path.
		expect(await until(() => handedBack > 0, 10_000)).toBe(true);
		// Nothing on disk may go on advertising the daemon that never ran.
		expect(
			await until(
				() => !fs.existsSync(path.join(secondDir, "notify-daemon.secret")),
				10_000,
			),
		).toBe(true);
		expect(fs.existsSync(path.join(secondDir, "notify-daemon.json"))).toBe(
			false,
		);
	}, 30_000);

	// A dev profile started beside the installed app shares one home, so its
	// daemon loses the port race. What it must not do is delete the running
	// daemon's credential or stop advertising it.
	it("leaves the state and secret of the daemon it did not start alone", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const first = start({ port, hooksDir: dir, secret: "secret-shared-home" });
		const owner = await first.start();

		let handedBack = 0;
		const second = start({
			port,
			hooksDir: dir,
			onPermanentFailure: () => {
				handedBack += 1;
			},
			secret: "secret-shared-home",
		});
		await expect(second.start()).rejects.toThrow(/exited during startup/);
		expect(await until(() => handedBack > 0, 10_000)).toBe(true);
		await second.stop();

		expect(readState(dir)).toEqual({
			port,
			pid: owner.pid,
			secret: "secret-shared-home",
		});
		expect(
			fs.readFileSync(path.join(dir, "notify-daemon.secret"), "utf8"),
		).toBe("secret-shared-home");
		expect((await health(port, "secret-shared-home")).status).toBe(200);
	}, 30_000);

	it("adopts a daemon another instance is already serving, and nothing else", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const secret = "secret-adopt-0123456789abcdefghijklmnop";

		expect(await adoptRunningNotifyDaemon(dir, port)).toBe(null);

		fs.writeFileSync(path.join(dir, "notify-daemon.secret"), secret);
		expect(await adoptRunningNotifyDaemon(dir, port)).toBe(null);

		const daemon = start({ port, hooksDir: dir, secret });
		const info = await daemon.start();
		expect(await adoptRunningNotifyDaemon(dir, port)).toEqual({
			pid: info.pid,
			port,
			secret,
		});

		fs.writeFileSync(
			path.join(dir, "notify-daemon.secret"),
			"secret-adopt-wrong-9876543210zyxwvutsrqpo",
		);
		expect(await adoptRunningNotifyDaemon(dir, port)).toBe(null);
	}, 30_000);

	it("restarts a crashed daemon, re-keying the secret file it reads", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const daemon = start({ port, hooksDir: dir, secret: "secret-crash" });
		const first = await daemon.start();
		const secretFile = path.join(dir, "notify-daemon.secret");
		// A second build (or anything else) writing this file must not decide
		// what the restarted child trusts.
		fs.writeFileSync(secretFile, "someone-elses-secret");

		process.kill(first.pid);

		expect(
			await until(async () => {
				if ((await healthStatus(port, "secret-crash")) !== 200) return false;
				return readState(dir).pid !== first.pid;
			}, 30_000),
		).toBe(true);
		expect(daemon.restartCount).toBe(1);
		expect(readState(dir).secret).toBe("secret-crash");
		expect(fs.readFileSync(secretFile, "utf8")).toBe("secret-crash");
	}, 45_000);

	it("hands the hooks back to the command path once it is out of restarts", async () => {
		const dir = hooksDir();
		const port = await freePort();
		let handedBack = 0;
		const daemon = start({
			port,
			hooksDir: dir,
			onPermanentFailure: () => {
				handedBack += 1;
			},
			scriptPath: stub(DYING_STUB),
			secret: "secret-giveup",
		});
		await daemon.start();

		expect(await until(() => handedBack > 0, 90_000)).toBe(true);
		expect(daemon.restartCount).toBe(5);
		expect(await healthStatus(port, "secret-giveup")).toBe(null);
		// A dead daemon's port, pid and secret stop being advertised.
		expect(
			await until(
				() =>
					!fs.existsSync(path.join(dir, "notify-daemon.json")) &&
					!fs.existsSync(path.join(dir, "notify-daemon.secret")),
				10_000,
			),
		).toBe(true);
	}, 120_000);

	// Anything else can take the port in the gap between a crash and the
	// restart. Handing the hooks back is irreversible, so it has to end the
	// ladder too: a later attempt that got the port would serve a daemon no hook
	// entry on the machine points at, for the rest of the run.
	it("stops restarting once a taken port has handed the hooks back", async () => {
		const dir = hooksDir();
		const port = await freePort();
		let handedBack = 0;
		const daemon = start({
			port,
			hooksDir: dir,
			onPermanentFailure: () => {
				handedBack += 1;
			},
			secret: "secret-bind-race",
		});
		const live = await daemon.start();

		const taken = occupySoon(port, 20_000);
		process.kill(live.pid);
		const occupant = await taken;

		expect(await until(() => handedBack > 0, 30_000)).toBe(true);
		expect(daemon.restartCount).toBe(1);
		// The rest of the ladder would have run by now.
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		expect(daemon.restartCount).toBe(1);
		expect(handedBack).toBe(1);

		// ...and nothing comes back once the port is free again.
		await closeServer(occupant);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		expect(await healthStatus(port, "secret-bind-race")).toBe(null);
		expect(fs.existsSync(path.join(dir, "notify-daemon.json"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "notify-daemon.secret"))).toBe(false);
	}, 90_000);

	// Those two drive the supervisor directly, where the daemon wrote the secret
	// file itself and so owns it. Through ensureNotifyDaemon the secret is minted
	// BEFORE any daemon exists, for every instance sharing the home to answer to,
	// so a hand-back must leave it where a Claude session already read it.
	it("keeps a secret it was handed when it hands the hooks back", async () => {
		await stopNotifyDaemon();
		const dir = hooksDir();
		const port = await freePort();
		const secretFile = path.join(dir, "notify-daemon.secret");
		let handedBack = 0;
		try {
			const info = await ensureNotifyDaemon(
				scriptPath,
				() => {
					handedBack += 1;
				},
				port,
				dir,
			);
			if (!info) throw new Error("the daemon never started");
			expect(fs.readFileSync(secretFile, "utf8")).toBe(info.secret);

			const taken = occupySoon(port, 20_000);
			process.kill(info.pid);
			const occupant = await taken;

			expect(await until(() => handedBack > 0, 30_000)).toBe(true);
			expect(
				await until(
					() => !fs.existsSync(path.join(dir, "notify-daemon.json")),
					10_000,
				),
			).toBe(true);
			expect(fs.readFileSync(secretFile, "utf8")).toBe(info.secret);
			await closeServer(occupant);
		} finally {
			await stopNotifyDaemon();
		}
	}, 90_000);

	// The realistic collision is not a second daemon but any process holding the
	// port. One that accepts the connection and then says nothing must not park
	// the probe: the supervisor asks this question on every traffic poll.
	it("reads a port a foreign process accepts but never answers as unowned", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const secret = "secret-foreign-occupant-4a7c2e19b0";
		fs.writeFileSync(path.join(dir, "notify-daemon.secret"), secret);
		const accepted: net.Socket[] = [];
		const silent = net.createServer((socket) => accepted.push(socket));
		await new Promise<void>((resolve) => {
			silent.listen(port, "127.0.0.1", () => resolve());
		});
		const started = Date.now();

		const adopted = await adoptRunningNotifyDaemon(dir, port);

		expect(adopted).toBe(null);
		expect(Date.now() - started).toBeLessThan(5_000);
		for (const socket of accepted) socket.destroy();
		await closeServer(silent);
	}, 30_000);

	it("rotates the daemon log while the child is still writing to it", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const daemon = start({
			port,
			hooksDir: dir,
			scriptPath: stub(NOISY_STUB),
			secret: "secret-noisy",
		});
		await daemon.start();

		const rotated = path.join(dir, "notify-daemon.log.1");
		expect(await until(() => fs.existsSync(rotated), 30_000)).toBe(true);
		expect(fs.statSync(rotated).size).toBeGreaterThan(1_000_000);
		expect(await healthStatus(port, "secret-noisy")).toBe(200);
	}, 60_000);

	it("carries a secret across launches and mints one only when it must", async () => {
		const file = path.join(hooksDir(), "notify-daemon.secret");

		const minted = await carriedOrMintedSecret(file);
		expect(minted).toMatch(/^[A-Za-z0-9_-]{32,512}$/);

		// A Claude session that outlived the last launch is still holding this
		// one in its hook entries, so the next launch must answer to it.
		fs.writeFileSync(file, `${minted}\n`);
		expect(await carriedOrMintedSecret(file)).toBe(minted);

		fs.writeFileSync(file, "too-short");
		const replaced = await carriedOrMintedSecret(file);
		expect(replaced).not.toBe("too-short");
		expect(replaced).toMatch(/^[A-Za-z0-9_-]{32,512}$/);
	});

	// Two instances starting in the same millisecond both find the file missing.
	// One secret has to win, or the one that binds the port is serving a secret
	// nothing on disk advertises.
	it("hands both instances of a mint race the same secret", async () => {
		const file = path.join(hooksDir(), "notify-daemon.secret");

		const [first, second] = await Promise.all([
			carriedOrMintedSecret(file),
			carriedOrMintedSecret(file),
		]);

		expect(second).toBe(first);
		expect(fs.readFileSync(file, "utf8").trim()).toBe(first);
	});

	it("never deletes a secret the daemon that won the port is serving", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const secretFile = path.join(dir, "notify-daemon.secret");
		const secret = await carriedOrMintedSecret(secretFile);
		const winner = start({ port, hooksDir: dir, secret });
		await winner.start();

		// Anything rewriting the file makes the loser write it back, and a file
		// it wrote is a file it would otherwise delete on its way out.
		fs.writeFileSync(secretFile, "tampered");
		let handedBack = 0;
		const loser = start({
			port,
			hooksDir: dir,
			onPermanentFailure: () => {
				handedBack += 1;
			},
			secret,
		});
		await expect(loser.start()).rejects.toThrow(/exited during startup/);
		expect(await until(() => handedBack > 0, 10_000)).toBe(true);
		await loser.stop();

		expect(fs.readFileSync(secretFile, "utf8")).toBe(secret);
		expect((await health(port, secret)).status).toBe(200);
	}, 30_000);

	// A restart that cannot even reach spawn (a quarantined interpreter, an
	// unwritable hooks dir) has to end like a crash does, or the hook entries
	// keep pointing at a port nothing is listening on for the rest of the run.
	it("hands the hooks back when restart attempts fail before a child exists", async () => {
		const dir = hooksDir();
		const port = await freePort();
		let handedBack = 0;
		const daemon = start({
			port,
			hooksDir: dir,
			onPermanentFailure: () => {
				handedBack += 1;
			},
			scriptPath: stub(DYING_STUB),
			secret: "secret-unspawnable",
		});
		await daemon.start();

		const secretFile = path.join(dir, "notify-daemon.secret");
		fs.rmSync(secretFile);
		fs.mkdirSync(secretFile);

		expect(await until(() => handedBack > 0, 90_000)).toBe(true);
		expect(daemon.restartCount).toBe(5);
		expect(await healthStatus(port, "secret-unspawnable")).toBe(null);
	}, 120_000);

	// ...and a restart whose spawn itself comes back with no process, which is
	// what an interpreter replaced or quarantined mid-run looks like. That child
	// emits `error` and `close` but never `exit`, so nothing else in the class
	// can notice the daemon is gone.
	it("hands the hooks back when a restart produces no process at all", async () => {
		const dir = hooksDir();
		const port = await freePort();
		let handedBack = 0;
		let interpreter = python;
		const daemon = new NotifyDaemon({
			get pythonPath(): string {
				return interpreter;
			},
			scriptPath,
			hooksDir: dir,
			port,
			secret: "secret-vanished-python",
			onPermanentFailure: () => {
				handedBack += 1;
			},
		});
		running.push(daemon);
		const live = await daemon.start();

		interpreter = path.join(root, "python-that-was-quarantined.exe");
		process.kill(live.pid);

		expect(await until(() => handedBack > 0, 90_000)).toBe(true);
		expect(daemon.restartCount).toBe(5);
		expect(await healthStatus(port, "secret-vanished-python")).toBe(null);
	}, 120_000);

	// The interpreter is upgraded or quarantined hours into a run, under a daemon
	// that has been healthy the whole time. The budget reset used to key on that
	// old healthy stamp alone, so every failing attempt handed itself a fresh
	// budget and the supervisor respawned a doomed child every 500ms forever.
	it("hands the hooks back when the interpreter goes after a long-healthy daemon", async () => {
		const dir = hooksDir();
		const port = await freePort();
		let handedBack = 0;
		let interpreter = python;
		const daemon = new NotifyDaemon({
			get pythonPath(): string {
				return interpreter;
			},
			scriptPath,
			hooksDir: dir,
			port,
			secret: "secret-long-healthy",
			onPermanentFailure: () => {
				handedBack += 1;
			},
		});
		running.push(daemon);
		const live = await daemon.start();

		const realNow = Date.now;
		Date.now = () => realNow() + 6 * 60_000;
		try {
			interpreter = path.join(root, "python-that-was-upgraded.exe");
			process.kill(live.pid);

			expect(await until(() => handedBack > 0, 90_000)).toBe(true);
			expect(daemon.restartCount).toBe(5);
		} finally {
			Date.now = realNow;
		}
	}, 120_000);

	// A quit landing inside the handshake: the hook registration this start was
	// going to write must never appear, because the cleanup that put the hooks
	// back on the command path has already finished.
	it("drops a daemon whose run was cancelled while it was still handshaking", async () => {
		const dir = hooksDir();
		const port = await freePort();
		fs.writeFileSync(
			path.join(dir, "notify-daemon.secret"),
			"secret-cancelled-start-b7f1a0c93d2e64581a",
		);

		const starting = ensureNotifyDaemon(scriptPath, () => {}, port, dir);
		await stopNotifyDaemon();

		expect(await starting).toBe(null);
		expect(
			await until(
				async () =>
					(await healthStatus(
						port,
						"secret-cancelled-start-b7f1a0c93d2e64581a",
					)) === null,
				20_000,
			),
		).toBe(true);
		expect(fs.existsSync(path.join(dir, "notify-daemon.json"))).toBe(false);
	}, 60_000);

	// A dev instance parks in the adoption wait while the installed app serves
	// the daemon. If it is THIS instance that quits, the owner is still serving
	// and its hook registration must be left exactly where it is.
	it("tells its own shutdown apart from the adopted owner going away", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const owner = start({ port, hooksDir: dir, secret: "secret-adopt-wait" });
		const info = await owner.start();

		const cancelled = awaitAdoptedNotifyDaemonExit(info);
		await stopNotifyDaemon();
		expect(await cancelled).toBe(false);

		// The owner stays up; the second wait is pointed at a port nothing serves,
		// which is what its exit looks like from here.
		expect(
			await awaitAdoptedNotifyDaemonExit({ ...info, port: await freePort() }),
		).toBe(true);
	}, 90_000);

	// The cancel can land inside the LAST health request of the wait, after that
	// poll's own check has already passed. Everything downstream then samples a
	// token that says the run was never cancelled, and rewrites the hook entries
	// quit cleanup has already put back.
	it("treats a cancel inside its last health request as a cancel", async () => {
		const port = await freePort();
		const accepted: net.Socket[] = [];
		let connections = 0;
		const silent = net.createServer((socket) => {
			accepted.push(socket);
			connections += 1;
			if (connections === 3) void stopNotifyDaemon();
		});
		await new Promise<void>((resolve) => {
			silent.listen(port, "127.0.0.1", () => resolve());
		});

		const ownerIsGone = await awaitAdoptedNotifyDaemonExit({
			pid: process.pid,
			port,
			secret: "secret-cancel-in-flight-8c41",
		});

		expect(connections).toBe(3);
		expect(ownerIsGone).toBe(false);
		for (const socket of accepted) socket.destroy();
		await closeServer(silent);
	}, 60_000);

	it("keeps the production port clear of the app's other fixed listeners", () => {
		expect([51741, 47610, 47611]).not.toContain(NOTIFY_DAEMON_PORT);
		// Below the Windows ephemeral range, so the OS cannot hand it out first.
		expect(NOTIFY_DAEMON_PORT).toBeLessThan(49152);
	});

	it("exits by itself when the parent closes its stdin", async () => {
		const dir = hooksDir();
		const port = await freePort();
		const secretFile = path.join(dir, "orphan.secret");
		fs.writeFileSync(secretFile, "secret-orphan");
		const child = childProcess.spawn(
			python,
			[
				"-I",
				"-S",
				scriptPath,
				"--serve",
				String(port),
				"--secret-file",
				secretFile,
			],
			{ stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
		);
		expect(
			await until(
				async () => (await healthStatus(port, "secret-orphan")) === 200,
				20_000,
			),
		).toBe(true);

		child.stdin?.end();

		expect(await until(() => child.exitCode !== null, 15_000)).toBe(true);
		expect(child.exitCode).toBe(0);
	}, 45_000);

	it("refuses to serve without a usable secret file", async () => {
		const port = await freePort();
		const empty = path.join(root, "empty.secret");
		fs.writeFileSync(empty, "   \n");
		const child = childProcess.spawnSync(
			python,
			["-I", "-S", scriptPath, "--serve", String(port), "--secret-file", empty],
			{ encoding: "utf8" },
		);
		expect(child.status).toBe(2);
		expect(child.stderr).toContain("secret file is empty");
	});

	it("refuses to serve with a relative SUPERSET_HOME_DIR in its own env", async () => {
		const port = await freePort();
		const secretFile = path.join(root, "relative-home.secret");
		fs.writeFileSync(secretFile, "secret-relative");
		const child = childProcess.spawnSync(
			python,
			[
				"-I",
				"-S",
				scriptPath,
				"--serve",
				String(port),
				"--secret-file",
				secretFile,
			],
			{
				encoding: "utf8",
				env: { ...process.env, SUPERSET_HOME_DIR: "relative/superset" },
			},
		);
		expect(child.status).toBe(2);
		expect(child.stderr).toContain("SUPERSET_HOME_DIR is not absolute");
	});
});

// (HOOK-HTTP-DAEMON) Only Claude's own sender can prove the http entries reach
// the daemon, so the transport is kept on trial until it has.
describe("notify daemon traffic verdict", () => {
	const upgradedAtMs = 1_000_000;
	const settledAtMs = upgradedAtMs + SETTINGS_RELOAD_MS;

	it("confirms the transport as soon as anything was served", () => {
		expect(
			notifyTrafficVerdict({
				claudeActivityAtMs: null,
				servedSinceMs: upgradedAtMs,
				nowMs: upgradedAtMs + 1_000,
				served: 1,
				silentHealthPolls: 0,
				upgradedAtMs,
			}),
		).toBe("confirmed");
	});

	it("waits while Claude itself has done nothing since the upgrade", () => {
		expect(
			notifyTrafficVerdict({
				claudeActivityAtMs: null,
				servedSinceMs: upgradedAtMs,
				nowMs: upgradedAtMs + SETTINGS_RELOAD_MS * 10,
				served: 0,
				silentHealthPolls: 0,
				upgradedAtMs,
			}),
		).toBe("waiting");
		expect(
			notifyTrafficVerdict({
				claudeActivityAtMs: upgradedAtMs - 1,
				servedSinceMs: upgradedAtMs,
				nowMs: upgradedAtMs + SETTINGS_RELOAD_MS * 10,
				served: 0,
				silentHealthPolls: 0,
				upgradedAtMs,
			}),
		).toBe("waiting");
	});

	it("waits out the window in which Claude may not have re-read its settings", () => {
		expect(
			notifyTrafficVerdict({
				claudeActivityAtMs: settledAtMs - 1,
				servedSinceMs: upgradedAtMs,
				nowMs: settledAtMs + TRAFFIC_GRACE_MS * 10,
				served: 0,
				silentHealthPolls: 0,
				upgradedAtMs,
			}),
		).toBe("waiting");
	});

	it("waits inside the grace window of a turn that just happened", () => {
		expect(
			notifyTrafficVerdict({
				claudeActivityAtMs: settledAtMs + 1,
				servedSinceMs: upgradedAtMs,
				nowMs: settledAtMs + 1 + TRAFFIC_GRACE_MS,
				served: 0,
				silentHealthPolls: 0,
				upgradedAtMs,
			}),
		).toBe("waiting");
	});

	it("calls the transport unused when a whole turn went by unseen", () => {
		expect(
			notifyTrafficVerdict({
				claudeActivityAtMs: settledAtMs + 1,
				servedSinceMs: upgradedAtMs,
				nowMs: settledAtMs + 2 + TRAFFIC_GRACE_MS,
				served: 0,
				silentHealthPolls: 0,
				upgradedAtMs,
			}),
		).toBe("unused");
	});

	// A restarted daemon is a new process whose served counter starts at zero,
	// so the turn it did not see was served by a child that no longer exists.
	it("re-arms the clock on the child now serving", () => {
		const unusedInput = {
			claudeActivityAtMs: settledAtMs + 1,
			nowMs: settledAtMs + 2 + TRAFFIC_GRACE_MS,
			served: 0,
			silentHealthPolls: 0,
			upgradedAtMs,
		};
		expect(
			notifyTrafficVerdict({
				...unusedInput,
				servedSinceMs: unusedInput.claudeActivityAtMs - 1,
			}),
		).toBe("waiting");
		// ...and a daemon that never came back cannot buy the transport time.
		expect(notifyTrafficVerdict({ ...unusedInput, servedSinceMs: 0 })).toBe(
			"unused",
		);
	});

	// The deciding poll of a turn can be the one that times out: four workers
	// mid-delivery-sweep, a 750ms budget for the answer.
	it("waits out a health answer that never arrived", () => {
		const decided = {
			claudeActivityAtMs: settledAtMs + 1,
			nowMs: settledAtMs + 2 + TRAFFIC_GRACE_MS,
			servedSinceMs: upgradedAtMs,
			upgradedAtMs,
		};
		expect(
			notifyTrafficVerdict({ ...decided, served: null, silentHealthPolls: 1 }),
		).toBe("waiting");
		expect(
			notifyTrafficVerdict({ ...decided, served: null, silentHealthPolls: 2 }),
		).toBe("waiting");
		// A run of them is a daemon that has stopped answering at all.
		expect(
			notifyTrafficVerdict({ ...decided, served: null, silentHealthPolls: 3 }),
		).toBe("unused");
		// ...and the answer that does arrive speaks for the daemon that sent it.
		expect(
			notifyTrafficVerdict({ ...decided, served: 12, silentHealthPolls: 2 }),
		).toBe("confirmed");
	});
});

describe("notify daemon traffic signal", () => {
	it("counts Claude's transcripts and nothing else a Superset terminal writes", async () => {
		const transcripts = fs.mkdtempSync(path.join(root, "projects-"));
		const paneMap = fs.mkdtempSync(path.join(root, "session-pane-map-"));
		const activity = await watchClaudeActivity([
			{ dir: transcripts, profileTree: false },
		]);
		try {
			// What a CODEX terminal does at SessionStart: the pane-map hook is
			// registered for it too, and it never POSTs the notify daemon.
			fs.writeFileSync(path.join(paneMap, "codex-session.json"), "{}");
			fs.writeFileSync(path.join(transcripts, "not-a-transcript.txt"), "x");
			await Bun.sleep(1_000);
			expect(activity.lastAtMs()).toBe(null);

			const project = path.join(transcripts, "project");
			fs.mkdirSync(project);
			fs.writeFileSync(path.join(project, "session.jsonl"), "{}\n");

			expect(await until(() => activity.lastAtMs() !== null, 10_000)).toBe(
				true,
			);
		} finally {
			activity.close();
		}
	}, 30_000);

	// A Superset terminal on a Pi-capable host launches Claude with
	// CLAUDE_CONFIG_DIR=<db-dir>/claude-profiles/<uuid>, so ~/.claude/projects
	// sees none of those sessions.
	it("sees a profile-pinned session's transcript and ignores the rest of the profile", async () => {
		const profiles = fs.mkdtempSync(path.join(root, "claude-profiles-"));
		const profile = path.join(profiles, "6f1b2c3d-0000-4000-8000-000000000001");
		const project = path.join(profile, "projects", "C--Users-someone-repo");
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(path.join(profile, "backups"), { recursive: true });
		const activity = await watchClaudeActivity([
			{
				dir: profiles,
				profileTree: true,
				profiles: new Set([path.basename(profile)]),
			},
		]);
		try {
			fs.writeFileSync(
				path.join(profile, "backups", "history-backup.jsonl"),
				"{}\n",
			);
			fs.writeFileSync(path.join(profile, "history.jsonl"), "{}\n");
			await Bun.sleep(1_000);
			expect(activity.lastAtMs()).toBe(null);

			fs.writeFileSync(path.join(project, "session.jsonl"), "{}\n");

			expect(await until(() => activity.lastAtMs() !== null, 10_000)).toBe(
				true,
			);
		} finally {
			activity.close();
		}
	}, 30_000);

	// A profile whose own settings.json was never rewritten is still running the
	// command transport, so its turns say nothing about the daemon.
	it("ignores a profile the transport change did not reach", async () => {
		const profiles = fs.mkdtempSync(path.join(root, "claude-profiles-stale-"));
		const stale = path.join(profiles, "6f1b2c3d-0000-4000-8000-00000000000a");
		const project = path.join(stale, "projects", "C--Users-someone-repo");
		fs.mkdirSync(project, { recursive: true });
		const activity = await watchClaudeActivity([
			{
				dir: profiles,
				profileTree: true,
				profiles: new Set(["6f1b2c3d-0000-4000-8000-00000000000b"]),
			},
		]);
		try {
			fs.writeFileSync(path.join(project, "session.jsonl"), "{}\n");
			await Bun.sleep(1_000);
			expect(activity.lastAtMs()).toBe(null);
		} finally {
			activity.close();
		}
	}, 30_000);

	// A profiles root can be deleted between the mirror walk and the watch being
	// armed; an unwatchable root must not take the other roots down with it.
	it("keeps watching the roots it can when a profile root has vanished", async () => {
		const transcripts = fs.mkdtempSync(path.join(root, "surviving-"));
		const vanished = path.join(root, "claude-profiles-vanished");
		const activity = await watchClaudeActivity([
			{ dir: transcripts, profileTree: false },
			{ dir: vanished, profileTree: true, profiles: new Set(["anything"]) },
		]);
		try {
			expect(activity.watchedRoots).toBe(1);

			fs.writeFileSync(path.join(transcripts, "session.jsonl"), "{}\n");

			expect(await until(() => activity.lastAtMs() !== null, 10_000)).toBe(
				true,
			);
		} finally {
			activity.close();
		}
	}, 30_000);

	it("hands the hooks back when no transcript root can be watched", async () => {
		const vanished = path.join(root, "claude-profiles-all-gone");
		const activity = await watchClaudeActivity([
			{ dir: vanished, profileTree: true, profiles: new Set(["anything"]) },
		]);
		activity.close();
		expect(activity.watchedRoots).toBe(0);

		let unused = 0;
		await watchNotifyDaemonTraffic(
			{ port: 1, secret: "secret-no-watchable-root", pid: 1 },
			[{ dir: vanished, profileTree: true, profiles: new Set(["anything"]) }],
			() => {
				unused += 1;
			},
		);

		expect(unused).toBe(1);
	}, 30_000);

	it("watches the default config dir plus the profiles that carry the http entries", () => {
		const org = path.join(root, "host", "org-1", "claude-profiles");
		const upgraded = [
			path.join(org, "6f1b2c3d-0000-4000-8000-000000000001"),
			path.join(org, "6f1b2c3d-0000-4000-8000-000000000002"),
		];

		expect(claudeTranscriptRoots(upgraded)).toEqual([
			{
				dir: path.join(os.homedir(), ".claude", "projects"),
				profileTree: false,
			},
			{
				dir: org,
				profileTree: true,
				profiles: new Set(upgraded.map((dir) => path.basename(dir))),
			},
		]);
		expect(claudeTranscriptRoots([])).toHaveLength(1);
	});

	// The host root is SUPERSET_HOME_DIR-scoped: a dev instance runs with its
	// own, and watching the installed app's profiles would prove nothing.
	it("finds every profile under every org of the host root it is given", async () => {
		const hostRoot = fs.mkdtempSync(path.join(root, "host-"));
		const first = path.join(hostRoot, "org-1", "claude-profiles", "uuid-1");
		const second = path.join(hostRoot, "org-2", "claude-profiles", "uuid-2");
		fs.mkdirSync(first, { recursive: true });
		fs.mkdirSync(second, { recursive: true });
		fs.mkdirSync(path.join(hostRoot, "org-3"), { recursive: true });
		fs.writeFileSync(path.join(hostRoot, "not-an-org"), "");

		expect(claudeProfileDirs(hostRoot).sort()).toEqual([first, second].sort());
		expect(claudeProfileDirs(path.join(hostRoot, "missing"))).toEqual([]);
		// The async walk is what every path but the process `exit` handler uses:
		// on a machine with a profile per workspace the sync one blocks the main
		// thread while the renderer is still loading off it.
		expect((await claudeProfileDirsAsync(hostRoot)).sort()).toEqual(
			[first, second].sort(),
		);
		expect(
			await claudeProfileDirsAsync(path.join(hostRoot, "missing")),
		).toEqual([]);
	});

	// A host root that is a FILE (or unreadable) reaches this from a child-process
	// `exit` listener and from quit cleanup, where a throw would take the whole
	// shutdown sequence with it.
	it("loses the profile mirror rather than the caller when the tree is unreadable", async () => {
		const notADir = path.join(root, `host-is-a-file-${Date.now()}`);
		fs.writeFileSync(notADir, "");

		expect(claudeProfileDirs(notADir)).toEqual([]);
		expect(await claudeProfileDirsAsync(notADir)).toEqual([]);
	});

	it("confirms the transport once Claude is working and the daemon is being POSTed", async () => {
		const dir = hooksDir();
		const transcripts = fs.mkdtempSync(path.join(root, "confirmed-"));
		const port = await freePort();
		const daemon = start({ port, hooksDir: dir, secret: "secret-confirmed" });
		const info = await daemon.start();

		const posted = await fetch(
			`http://127.0.0.1:${port}/superset-notify/hook`,
			{
				body: JSON.stringify({ hook_event_name: "Stop" }),
				headers: {
					"X-Superset-Agent-Watcher-Debug": "0",
					[NOTIFY_SECRET_HEADER]: "secret-confirmed",
					"X-Superset-Terminal-Id": "",
				},
				method: "POST",
			},
		);
		expect(posted.status).toBe(204);

		let handedBack = 0;
		// Written after the watch is armed: a transcript already on disk is
		// not a session doing work, and the gate only reacts to a change.
		const claudeWorks = setTimeout(() => {
			fs.writeFileSync(path.join(transcripts, "session.jsonl"), "{}\n");
		}, 1_000);
		try {
			await watchNotifyDaemonTraffic(
				info,
				[{ dir: transcripts, profileTree: false }],
				() => {
					handedBack += 1;
				},
			);
		} finally {
			clearTimeout(claudeWorks);
		}

		expect(handedBack).toBe(0);
	}, 45_000);

	// Handing the hooks back ends the watch with it. A watch still running after
	// it would poll a port this instance no longer registers and eventually
	// announce a fallback that already happened.
	it("ends the watch when supervision hands the hooks back", async () => {
		const dir = hooksDir();
		const transcripts = fs.mkdtempSync(path.join(root, "handback-"));
		const port = await freePort();
		let handedBack = 0;
		const daemon = start({
			port,
			hooksDir: dir,
			onPermanentFailure: () => {
				handedBack += 1;
			},
			secret: "secret-watch-handback",
		});
		const info = await daemon.start();
		let unused = 0;
		const watching = watchNotifyDaemonTraffic(
			info,
			[{ dir: transcripts, profileTree: false }],
			() => {
				unused += 1;
			},
		).then(() => "ended");

		const taken = occupySoon(port, 20_000);
		process.kill(info.pid);
		const occupant = await taken;
		expect(await until(() => handedBack > 0, 30_000)).toBe(true);

		expect(
			await Promise.race([
				watching,
				new Promise((resolve) =>
					setTimeout(() => resolve("still watching"), 15_000),
				),
			]),
		).toBe("ended");
		expect(unused).toBe(0);
		await closeServer(occupant);
	}, 90_000);

	// The decisive poll of a turn can be the one that times out. Counted as zero
	// served it handed the hooks back on a daemon that had just served the turn.
	it("keeps the transport when the deciding health answer is dropped", async () => {
		const transcripts = fs.mkdtempSync(path.join(root, "dropped-health-"));
		const port = await freePort();
		const stub = await healthStubServer(port);
		let unused = 0;
		const watching = watchNotifyDaemonTraffic(
			{ pid: process.pid, port, secret: "secret-dropped-health" },
			[{ dir: transcripts, profileTree: false }],
			() => {
				unused += 1;
			},
		);
		// A turn only speaks for the transport once Claude could have re-read
		// settings.json, and only counts against it after the grace window.
		const claudeWorks = setTimeout(() => {
			fs.writeFileSync(path.join(transcripts, "session.jsonl"), "{}\n");
			stub.dropOneAnswerAfter(Date.now() + TRAFFIC_GRACE_MS + 1_000, 12);
		}, SETTINGS_RELOAD_MS + 2_000);
		try {
			await watching;
		} finally {
			clearTimeout(claudeWorks);
			await closeServer(stub.server);
		}

		expect(stub.dropped()).toBe(1);
		expect(unused).toBe(0);
	}, 240_000);

	// The caller samples the hand-back token before the daemon exists, so a
	// give-up that lands while it mirrors the http entries is visible here.
	it("never starts a watch the hooks were handed back before it was armed", async () => {
		const transcripts = fs.mkdtempSync(path.join(root, "prearmed-handback-"));
		const port = await freePort();
		let unused = 0;

		await watchNotifyDaemonTraffic(
			{ pid: process.pid, port, secret: "secret-prearmed-handback" },
			[{ dir: transcripts, profileTree: false }],
			() => {
				unused += 1;
			},
			notifyHandBackToken() - 1,
		);

		expect(unused).toBe(0);
	}, 30_000);
});
