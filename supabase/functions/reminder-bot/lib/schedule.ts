import { addDays, type Ymd } from './dates.ts';

/**
 * Review dates for something studied on `studiedOn`, `intervals` days later (1, 3, 7, 14, 30 …).
 *
 * Dates that are already gone are skipped: today counts only while today's reminder has not been
 * sent yet (`afterReminderTime` = false). If only the first review was missed by a day or two
 * (e.g. yesterday's lesson logged this evening), it is moved to the next possible day instead,
 * so a fresh lesson always gets its "next day" reminder. Very old entries (imported history)
 * only keep the reviews that are still ahead.
 */
export function scheduleReviews(studiedOn: Ymd, intervals: number[], today: Ymd, afterReminderTime: boolean): Ymd[] {
  const first = afterReminderTime ? addDays(today, 1) : today;
  const dates = new Set<Ymd>();
  intervals.forEach((days, i) => {
    let due = addDays(studiedOn, days);
    if (due < first) {
      if (i === 0 && due >= addDays(today, -1)) due = first;
      else return;
    }
    dates.add(due);
  });
  return [...dates].sort();
}
