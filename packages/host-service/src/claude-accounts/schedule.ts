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
	terminal: { error: unknown } | null;
}

export type ScheduleDecision =
	| { kind: "wait"; wakeAt: number }
	| { kind: "attempt" }
	| { kind: "expire" }
	| { kind: "fail"; error: unknown };

type ScheduleAction = Exclude<ScheduleDecision, { kind: "wait" }>;

export type ScheduleFireOutcome =
	| { kind: "settled" }
	| { kind: "busy" }
	| { kind: "replan" }
	| { kind: "retry"; failure: ScheduleAttemptFailure }
	| { kind: "failed"; error: unknown }
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

export function scheduleDeadline(fireAt: number): number {
	return fireAt + SCHEDULE_WINDOW_MS;
}

export function scheduleExpired(fireAt: number, now: number): boolean {
	return now >= scheduleDeadline(fireAt);
}

export function decideSchedule(
	schedule: Pick<DueSchedule, "fireAt" | "archived">,
	attempt: ScheduleAttemptState | undefined,
	now: number,
): ScheduleDecision {
	const deadline = scheduleDeadline(schedule.fireAt);
	if (attempt !== undefined && now < attempt.nextAttemptAt) {
		return { kind: "wait", wakeAt: attempt.nextAttemptAt };
	}
	if (attempt?.terminal) return { kind: "fail", error: attempt.terminal.error };
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

export interface PendingDecision {
	schedule: DueSchedule;
	decision: ScheduleDecision;
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
	fail: (schedule: DueSchedule, error: unknown) => Promise<"settled" | "busy">;
}

export class ScheduleRunner {
	private disarmTimer: (() => void) | null = null;
	private stopped = false;
	private readonly attempts = new Map<string, ScheduleAttemptState>();
	private readonly inFlight = new Set<string>();

	constructor(private readonly deps: ScheduleRunnerDeps) {}

	stop(): void {
		this.stopped = true;
		this.disarm();
	}

	/** `planned` replaces the re-read and must exclude schedules launched since it was decided. */
	poke(planned?: readonly PendingDecision[]): void {
		this.disarm();
		if (this.stopped) return;
		try {
			if (!this.deps.isActive()) return;
			const now = this.deps.now();
			let wakeAt = Number.POSITIVE_INFINITY;
			for (const { decision } of planned ?? this.pendingDecisions(now)) {
				wakeAt = Math.min(
					wakeAt,
					decision.kind === "wait" ? decision.wakeAt : now,
				);
			}
			if (wakeAt === Number.POSITIVE_INFINITY) return;
			const delayMs = Math.min(
				Math.max(wakeAt - now, MIN_WAKE_DELAY_MS),
				MAX_WAKE_DELAY_MS,
			);
			this.disarmTimer = this.deps.timer(() => this.runPass(), delayMs);
		} catch (error) {
			this.deps.log.error(
				"Claude scheduled switch timer could not be planned; retrying in 15 s",
				{ error },
			);
			this.disarmTimer = this.deps.timer(
				() => this.runPass(),
				MAX_WAKE_DELAY_MS,
			);
		}
	}

	private disarm(): void {
		this.disarmTimer?.();
		this.disarmTimer = null;
	}

	private pendingDecisions(now: number): PendingDecision[] {
		const decided: PendingDecision[] = [];
		for (const schedule of this.deps.listPending()) {
			if (this.inFlight.has(schedule.scheduleId)) continue;
			decided.push({
				schedule,
				decision: decideSchedule(
					schedule,
					this.attempts.get(schedule.scheduleId),
					now,
				),
			});
		}
		return decided;
	}

	/** Attempts run concurrently across schedules, never twice for one schedule_id. */
	private async runPass(): Promise<void> {
		this.disarmTimer = null;
		if (this.stopped) return;
		const launched: Promise<void>[] = [];
		let planned: PendingDecision[] | undefined;
		try {
			if (!this.deps.isActive()) return;
			const decided = this.pendingDecisions(this.deps.now());
			const decidedIds = new Set(
				decided.map(({ schedule }) => schedule.scheduleId),
			);
			for (const scheduleId of this.attempts.keys()) {
				if (!decidedIds.has(scheduleId) && !this.inFlight.has(scheduleId)) {
					this.attempts.delete(scheduleId);
				}
			}
			const waiting: PendingDecision[] = [];
			for (const entry of decided) {
				if (entry.decision.kind === "wait") waiting.push(entry);
				else launched.push(this.launch(entry.schedule, entry.decision));
			}
			planned = waiting;
		} catch (error) {
			this.deps.log.error("Claude scheduled switch pass failed", { error });
		} finally {
			this.poke(planned);
		}
		await Promise.all(launched);
	}

	private async launch(
		schedule: DueSchedule,
		action: ScheduleAction,
	): Promise<void> {
		this.inFlight.add(schedule.scheduleId);
		try {
			await this.step(schedule, action);
		} catch (error) {
			this.deps.log.error(
				"Claude scheduled switch failure could not be recorded",
				{
					workspaceId: schedule.workspaceId,
					scheduleId: schedule.scheduleId,
					error,
				},
			);
		} finally {
			this.inFlight.delete(schedule.scheduleId);
			this.poke();
		}
	}

	private async step(
		schedule: DueSchedule,
		action: ScheduleAction,
	): Promise<void> {
		const previous = this.attempts.get(schedule.scheduleId);
		let error: unknown;
		if (action.kind === "fail") {
			error = action.error;
		} else {
			try {
				const outcome: ScheduleFireOutcome =
					action.kind === "expire"
						? { kind: "expired" }
						: await this.deps.fire(schedule);
				if (outcome.kind !== "failed") {
					await this.record(schedule, previous, outcome);
					return;
				}
				error = outcome.error;
			} catch (unexpected) {
				this.deps.log.error("Claude scheduled switch attempt failed", {
					workspaceId: schedule.workspaceId,
					scheduleId: schedule.scheduleId,
					error: unexpected,
				});
				error = unexpected;
			}
		}
		await this.fail(schedule, previous, error);
	}

	private async record(
		schedule: DueSchedule,
		previous: ScheduleAttemptState | undefined,
		outcome: Exclude<ScheduleFireOutcome, { kind: "failed" }>,
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
						scheduleDeadline(schedule.fireAt),
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

	/** Only the guarded failure write is retried; the switch never re-fires. */
	private async fail(
		schedule: DueSchedule,
		previous: ScheduleAttemptState | undefined,
		error: unknown,
	): Promise<void> {
		this.attempts.set(schedule.scheduleId, {
			nextAttemptAt: this.deps.now() + BUSY_RETRY_MS,
			lastFailure: previous?.lastFailure ?? null,
			terminal: { error },
		});
		if ((await this.deps.fail(schedule, error)) === "settled") {
			this.attempts.delete(schedule.scheduleId);
		}
	}

	private setAttempt(
		schedule: DueSchedule,
		nextAttemptAt: number,
		lastFailure: ScheduleAttemptFailure | null,
	): void {
		this.attempts.set(schedule.scheduleId, {
			nextAttemptAt,
			lastFailure,
			terminal: null,
		});
	}
}
