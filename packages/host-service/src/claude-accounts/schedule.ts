import type {
	ClaudeAccountsLogger,
	ClaudeScheduleRetryableFailure,
} from "./types";

// (CLAUDE-ACCOUNT-SCHEDULE)
export const SCHEDULE_WINDOW_MS = 30 * 60 * 1000;
export const SCHEDULE_MAX_LEAD_MS = 25 * 60 * 60 * 1000;
export const SCHEDULE_FALLBACK_COOLDOWN_MS = 10 * 60 * 1000;
const MIN_WAKE_DELAY_MS = 250;
const MAX_WAKE_DELAY_MS = 15_000;
const BUSY_RETRY_MS = 5_000;
const FAILED_ATTEMPT_RETRY_MS = 30_000;

export interface DueSchedule {
	workspaceId: string;
	scheduleId: string;
	targetSlug: string | null;
	fireAt: number;
	archived: boolean;
}

export interface ScheduleAttemptFailure {
	failure: ClaudeScheduleRetryableFailure;
	message: string;
}

export interface ScheduleAttemptState {
	nextAttemptAt: number;
	lastFailure: ScheduleAttemptFailure | null;
}

export type ScheduleDecision =
	| { kind: "wait"; wakeAt: number }
	| { kind: "attempt" }
	| { kind: "expire" };

export type ScheduleFireOutcome =
	| { kind: "settled" }
	| { kind: "busy" }
	| { kind: "replan" }
	| { kind: "retry"; failure: ScheduleAttemptFailure }
	| { kind: "expired" }
	| { kind: "abandoned" };

/** Arms `run` after `delayMs` and returns the disarm function. */
export type ScheduleTimer = (
	run: () => Promise<void>,
	delayMs: number,
) => () => void;

export const realScheduleTimer: ScheduleTimer = (run, delayMs) => {
	const handle = setTimeout(() => {
		void run();
	}, delayMs);
	handle.unref();
	return () => clearTimeout(handle);
};

export function scheduleExpired(fireAt: number, now: number): boolean {
	return now >= fireAt + SCHEDULE_WINDOW_MS;
}

export function decideSchedule(
	schedule: Pick<DueSchedule, "fireAt" | "archived">,
	attempt: ScheduleAttemptState | undefined,
	now: number,
): ScheduleDecision {
	const deadline = schedule.fireAt + SCHEDULE_WINDOW_MS;
	if (attempt !== undefined && now < attempt.nextAttemptAt) {
		return { kind: "wait", wakeAt: attempt.nextAttemptAt };
	}
	if (now >= deadline) return { kind: "expire" };
	if (schedule.archived) {
		return {
			kind: "wait",
			wakeAt: Math.min(now + MAX_WAKE_DELAY_MS, deadline),
		};
	}
	if (now < schedule.fireAt) return { kind: "wait", wakeAt: schedule.fireAt };
	return { kind: "attempt" };
}

export interface ScheduleRunnerDeps {
	now: () => number;
	timer: ScheduleTimer;
	log: ClaudeAccountsLogger;
	isActive: () => boolean;
	listPending: () => DueSchedule[];
	fire: (schedule: DueSchedule) => Promise<ScheduleFireOutcome>;
	expire: (
		schedule: DueSchedule,
		lastFailure: ScheduleAttemptFailure | null,
	) => Promise<"settled" | "busy">;
}

export class ScheduleRunner {
	private disarmTimer: (() => void) | null = null;
	private passInFlight = false;
	private stopped = false;
	private readonly attempts = new Map<string, ScheduleAttemptState>();

	constructor(private readonly deps: ScheduleRunnerDeps) {}

	poke(): void {
		// A pass in flight re-reads the table and re-arms when it ends.
		if (this.passInFlight) return;
		this.arm();
	}

	stop(): void {
		this.stopped = true;
		this.disarm();
	}

	private arm(): void {
		this.disarm();
		if (this.stopped || !this.deps.isActive()) return;
		const schedules = this.deps.listPending();
		if (schedules.length === 0) return;
		const now = this.deps.now();
		let wakeAt = Number.POSITIVE_INFINITY;
		for (const schedule of schedules) {
			const decision = decideSchedule(
				schedule,
				this.attempts.get(schedule.scheduleId),
				now,
			);
			wakeAt = Math.min(
				wakeAt,
				decision.kind === "wait" ? decision.wakeAt : now,
			);
		}
		const delayMs = Math.min(
			Math.max(wakeAt - now, MIN_WAKE_DELAY_MS),
			MAX_WAKE_DELAY_MS,
		);
		this.disarmTimer = this.deps.timer(() => this.runPass(), delayMs);
	}

	private disarm(): void {
		this.disarmTimer?.();
		this.disarmTimer = null;
	}

	private async runPass(): Promise<void> {
		this.disarmTimer = null;
		if (this.stopped || this.passInFlight) return;
		this.passInFlight = true;
		try {
			const schedules = this.deps.listPending();
			const pendingIds = new Set(
				schedules.map((schedule) => schedule.scheduleId),
			);
			for (const scheduleId of this.attempts.keys()) {
				if (!pendingIds.has(scheduleId)) this.attempts.delete(scheduleId);
			}
			for (const schedule of schedules) {
				if (this.stopped || !this.deps.isActive()) return;
				await this.step(schedule);
			}
		} catch (error) {
			this.deps.log.error("Claude scheduled switch pass failed", { error });
		} finally {
			this.passInFlight = false;
			this.arm();
		}
	}

	private async step(schedule: DueSchedule): Promise<void> {
		const previous = this.attempts.get(schedule.scheduleId);
		const decision = decideSchedule(schedule, previous, this.deps.now());
		if (decision.kind === "wait") return;
		try {
			if (decision.kind === "expire") {
				await this.expire(schedule, previous);
				return;
			}
			const outcome = await this.deps.fire(schedule);
			await this.record(schedule, previous, outcome);
		} catch (error) {
			this.deps.log.error("Claude scheduled switch attempt failed", {
				workspaceId: schedule.workspaceId,
				scheduleId: schedule.scheduleId,
				error,
			});
			this.setAttempt(
				schedule,
				this.deps.now() + FAILED_ATTEMPT_RETRY_MS,
				previous?.lastFailure ?? null,
			);
		}
	}

	private async record(
		schedule: DueSchedule,
		previous: ScheduleAttemptState | undefined,
		outcome: ScheduleFireOutcome,
	): Promise<void> {
		const now = this.deps.now();
		const lastFailure = previous?.lastFailure ?? null;
		switch (outcome.kind) {
			case "settled":
				this.attempts.delete(schedule.scheduleId);
				return;
			case "abandoned":
				return;
			case "busy":
				this.setAttempt(schedule, now + BUSY_RETRY_MS, lastFailure);
				return;
			case "replan":
				this.setAttempt(schedule, now, lastFailure);
				return;
			case "retry":
				this.setAttempt(
					schedule,
					Math.min(
						now + FAILED_ATTEMPT_RETRY_MS,
						schedule.fireAt + SCHEDULE_WINDOW_MS,
					),
					outcome.failure,
				);
				return;
			case "expired":
				await this.expire(schedule, previous);
				return;
		}
	}

	private async expire(
		schedule: DueSchedule,
		previous: ScheduleAttemptState | undefined,
	): Promise<void> {
		const lastFailure = previous?.lastFailure ?? null;
		const result = await this.deps.expire(schedule, lastFailure);
		if (result === "settled") this.attempts.delete(schedule.scheduleId);
		else
			this.setAttempt(schedule, this.deps.now() + BUSY_RETRY_MS, lastFailure);
	}

	private setAttempt(
		schedule: DueSchedule,
		nextAttemptAt: number,
		lastFailure: ScheduleAttemptFailure | null,
	): void {
		this.attempts.set(schedule.scheduleId, { nextAttemptAt, lastFailure });
	}
}
