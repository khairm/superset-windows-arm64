export interface ClockTime {
	hours: number;
	minutes: number;
}

export interface Occurrence {
	day: "today" | "tomorrow";
	at: Date;
}

export function nextOccurrence(time: ClockTime, now: Date): Occurrence {
	const today = new Date(now);
	today.setHours(time.hours, time.minutes, 0, 0);
	if (today.getTime() > now.getTime()) return { day: "today", at: today };
	const tomorrow = new Date(now);
	tomorrow.setDate(now.getDate() + 1);
	tomorrow.setHours(time.hours, time.minutes, 0, 0);
	return { day: "tomorrow", at: tomorrow };
}
