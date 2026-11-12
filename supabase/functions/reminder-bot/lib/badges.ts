// Badges: small rewards for streaks, topics, reviews and mastered topics.
// Which badges a user was already congratulated on is stored in users.achievements (their codes).
import { days, type Lang, pluralRu } from './i18n.ts';

export type Metric = 'streak' | 'entries' | 'reviews' | 'mastered';
export type Metrics = Record<Metric, number>;
export type Badge = { code: string; emoji: string; metric: Metric; need: number };

const make = (metric: Metric, prefix: string) => (need: number, emoji: string): Badge => ({
  code: `${prefix}_${need}`,
  emoji,
  metric,
  need,
});
const streak = make('streak', 'streak');
const note = make('entries', 'note');
const review = make('reviews', 'review');
const master = make('mastered', 'master');

/** Ordered by group, then by difficulty. Codes are stored in the database: never rename them. */
export const BADGES: Badge[] = [
  streak(3, '🔥'),
  streak(7, '⚡'),
  streak(14, '💪'),
  streak(30, '🏆'),
  streak(60, '💎'),
  streak(100, '👑'),
  note(1, '🌱'),
  note(10, '📚'),
  note(25, '🎒'),
  note(50, '🧠'),
  note(100, '🦉'),
  review(1, '✅'),
  review(10, '🔁'),
  review(50, '💫'),
  review(100, '💯'),
  review(250, '🚀'),
  master(1, '🌟'),
  master(5, '✨'),
  master(20, '🎓'),
];

export const METRICS: Metric[] = ['streak', 'entries', 'reviews', 'mastered'];

/** The numbers badges are measured against; the streak badge counts the best streak ever. */
export function metricsOf(s: { best: number; entries_total: number; reviews_done: number; mastered?: number }): Metrics {
  return { streak: s.best, entries: s.entries_total, reviews: s.reviews_done, mastered: s.mastered ?? 0 };
}

export const earnedBadges = (m: Metrics): Badge[] => BADGES.filter((b) => m[b.metric] >= b.need);

export const badgeByCode = (code: string): Badge | undefined => BADGES.find((b) => b.code === code);

export function badgeTitle(lang: Lang, b: Badge): string {
  const n = b.need;
  if (lang === 'de') {
    switch (b.metric) {
      case 'streak':
        return `${n} Tage in Folge`;
      case 'entries':
        return n === 1 ? 'Erster Eintrag' : `${n} Themen`;
      case 'reviews':
        return n === 1 ? 'Erste Wiederholung' : `${n} Wiederholungen`;
      case 'mastered':
        return n === 1 ? 'Erstes gefestigtes Thema' : `${n} gefestigte Themen`;
    }
  }
  switch (b.metric) {
    case 'streak':
      return `${n} ${days('ru', n)} подряд`;
    case 'entries':
      return n === 1 ? 'Первая запись' : `${n} ${pluralRu(n, 'тема', 'темы', 'тем')}`;
    case 'reviews':
      return n === 1 ? 'Первое повторение' : `${n} ${pluralRu(n, 'повторение', 'повторения', 'повторений')}`;
    case 'mastered':
      return n === 1 ? 'Первая закреплённая тема' : `${n} закреплённых тем`;
  }
}

/** ▰▰▰▱▱ – `width` segments, filled in proportion to value/total (full only when reached). */
export function bar(value: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.max(0, Math.min(width, Math.floor((value / total) * width))) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
