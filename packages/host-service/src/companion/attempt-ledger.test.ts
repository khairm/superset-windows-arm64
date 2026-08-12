import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../db";
import { createAttemptLedger, toLedgerFailureCode } from "./attempt-ledger";

const roots: string[] = [];
const openDbs = new Set<ReturnType<typeof createDb>>();
const migrations = join(import.meta.dirname, "..", "..", "drizzle");

function openLedger() {
	const root = mkdtempSync(join(tmpdir(), "attempt-ledger-"));
	roots.push(root);
	const dbPath = join(root, "host.db");
	const db = createDb(dbPath, migrations);
	db.$client.pragma("synchronous = FULL");
	openDbs.add(db);
	const ledger = createAttemptLedger({ db, log: () => {} });
	return { db, dbPath, ledger };
}

function claim(
	ledger: ReturnType<typeof createAttemptLedger>,
	requestId: string,
) {
	return ledger.claimForAnswer({
		requestId,
		questionId: "question-1",
		deviceId: "device-1",
		surface: "phone",
		startedAtMs: 1,
	});
}

afterEach(() => {
	for (const db of openDbs) db.$client.close();
	openDbs.clear();
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "EBUSY"
			) {
				throw error;
			}
		}
	}
});

describe("AttemptLedger failure-code boundary", () => {
	it("maps transport-only sealed codes to a valid durable internal failure", () => {
		expect(toLedgerFailureCode("access_denied")).toBe("internal");
		expect(toLedgerFailureCode("session_expired")).toBe("internal");
		expect(toLedgerFailureCode("write_disabled")).toBe("write_disabled");
	});
});

describe("AttemptLedger question fence", () => {
	it("does not let a concurrent pre-write claim fence the winner", () => {
		const { ledger } = openLedger();
		expect(claim(ledger, "request-a").kind).toBe("claimed");
		expect(claim(ledger, "request-b").kind).toBe("claimed");
		expect(ledger.beginWrite("request-a", "lease-a")).toBeNull();
		expect(ledger.beginWrite("request-b", "lease-b")).toMatchObject({
			requestId: "request-a",
			status: "in_flight",
		});
	});

	it("finds a durable confirmed fence after reopening and excludes the same request", () => {
		const opened = openLedger();
		expect(claim(opened.ledger, "request-1").kind).toBe("claimed");
		expect(opened.ledger.beginWrite("request-1", "lease-1")).toBeNull();
		opened.ledger.recordOutcome({
			requestId: "request-1",
			status: "confirmed",
			resolvedAtMs: 2,
			failureCode: null,
			guardsPassed: [],
			leaseId: "lease-1",
		});
		opened.db.$client.close();
		openDbs.delete(opened.db);

		const reopenedDb = createDb(opened.dbPath, migrations);
		reopenedDb.$client.pragma("synchronous = FULL");
		openDbs.add(reopenedDb);
		const reopened = createAttemptLedger({ db: reopenedDb, log: () => {} });
		expect(() => reopened.beginWrite("request-1", "lease-ignored")).toThrow(
			"not a pre-write claim",
		);
		expect(claim(reopened, "request-2").kind).toBe("claimed");
		const fenced = reopened.beginWrite("request-2", "lease-2");
		expect(fenced?.requestId).toBe("request-1");
	});

	it("failed rows do not fence a fresh request", () => {
		const { ledger } = openLedger();
		claim(ledger, "request-failed");
		ledger.recordOutcome({
			requestId: "request-failed",
			status: "failed",
			resolvedAtMs: null,
			failureCode: "internal",
			guardsPassed: [],
			leaseId: null,
		});
		claim(ledger, "request-next");
		expect(ledger.beginWrite("request-next", "lease-next")).toBeNull();
	});

	it("in-flight and unconfirmed rows fence fresh requests", () => {
		for (const status of ["in_flight", "unconfirmed"] as const) {
			const { ledger } = openLedger();
			claim(ledger, `request-${status}`);
			ledger.beginWrite(`request-${status}`, `lease-${status}`);
			if (status === "unconfirmed") {
				ledger.recordOutcome({
					requestId: `request-${status}`,
					status,
					resolvedAtMs: null,
					failureCode: null,
					guardsPassed: [],
					leaseId: `lease-${status}`,
				});
			}
			claim(ledger, `request-next-${status}`);
			expect(
				ledger.beginWrite(`request-next-${status}`, `lease-next-${status}`)
					?.requestId,
			).toBe(`request-${status}`);
		}
	});
});
