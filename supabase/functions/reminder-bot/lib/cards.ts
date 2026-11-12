// Picture cards: /stats and the weekly summary as designed images. This module only builds SVG
// (pure, no I/O); lib/raster.ts turns it into a PNG.
import { addDays, weekday, type Ymd } from './dates.ts';
import type { Stats, WeekSummary } from './db.ts';
import { days as dayWord, fmtDate, type Lang } from './i18n.ts';

export const CARD_SIZE = 1080;

/** What happened on one local day: topics studied (n) and reviews marked done (r). */
export type DayActivity = { d: Ymd; n: number; r: number };

export type StatsCardData = {
  lang: Lang;
  name?: string | null;
  today: Ymd;
  streak: number;
  best: number;
  entries: number;
  reviewsDone: number;
  mastered: number;
  days: DayActivity[];
};

export type WeekCardData = {
  lang: Lang;
  name?: string | null;
  from: Ymd;
  to: Ymd;
  streak: number;
  newTopics: number;
  activeDays: number;
  reviewsDone: number;
  reviewsDue: number;
  days: DayActivity[];
};

const L = {
  ru: {
    record: 'рекорд',
    activity: 'Активность · 5 недель',
    weekdays: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    topics: 'Темы',
    reviews: 'Повторения',
    mastered: 'Закреплено',
    legendNew: 'новая тема',
    legendReview: 'повторение',
    streakOf: (n: number) => `${dayWord('ru', n)} подряд`,
    weekTitle: 'Итоги недели',
    weekTopics: 'Новые темы',
    weekDays: 'Дни с занятиями',
    weekReviews: 'Повторено',
    streak: (n: number) => `Серия: ${n} ${dayWord('ru', n)}`,
    great: 'Так держать!',
    good: 'Хороший темп!',
    low: 'Понемногу каждый день',
  },
  de: {
    record: 'Rekord',
    activity: 'Aktivität · 5 Wochen',
    weekdays: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
    topics: 'Themen',
    reviews: 'Wiederholungen',
    mastered: 'Gefestigt',
    legendNew: 'neues Thema',
    legendReview: 'Wiederholung',
    streakOf: (n: number) => `${n === 1 ? 'Tag' : 'Tage'} in Folge`,
    weekTitle: 'Wochenrückblick',
    weekTopics: 'Neue Themen',
    weekDays: 'Lerntage',
    weekReviews: 'Wiederholt',
    streak: (n: number) => `Serie: ${n} ${dayWord('de', n)}`,
    great: 'Weiter so!',
    good: 'Gutes Tempo!',
    low: 'Jeden Tag ein bisschen',
  },
};

const C = {
  text: '#FFFFFF',
  dim: 'rgba(255,255,255,0.58)',
  faint: 'rgba(255,255,255,0.36)',
  tile: 'rgba(255,255,255,0.065)',
  cell: 'rgba(255,255,255,0.08)',
  cellFuture: 'rgba(255,255,255,0.03)',
  gold: '#FFC53D',
  green: '#34D399',
  violet: '#A78BFA',
  flameOff: 'rgba(255,255,255,0.16)',
};

const FONT = 'Onest';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Keeps what the card font can draw (Latin, Cyrillic, digits, common punctuation); drops emoji and the rest. */
export function cardText(s: string, max = 40): string {
  const clean = s
    .replace(/[ʻʼ‘’`]/g, "'")
    .replace(/[^ -~ -ſЀ-ӿ–—…«»„“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

type TextOpts = { size: number; weight?: 500 | 800; fill?: string; anchor?: 'start' | 'middle' | 'end'; spacing?: number };

function text(x: number, y: number, content: string, o: TextOpts): string {
  const spacing = o.spacing ? ` letter-spacing="${o.spacing}"` : '';
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size}" font-weight="${o.weight ?? 500}" fill="${
    o.fill ?? C.text
  }" text-anchor="${o.anchor ?? 'start'}"${spacing}>${xml(content)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, r: number, fill: string, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${extra ? ` ${extra}` : ''}/>`;
}

/** A soft light: fades out along a curve, so the edge of the circle is invisible. */
function glowGradient(id: string, color: string, opacity: number): string {
  const stops = [[0, 1], [0.25, 0.72], [0.5, 0.36], [0.75, 0.1], [1, 0]]
    .map(([offset, k]) => `<stop offset="${offset}" stop-color="${color}" stop-opacity="${(opacity * k).toFixed(3)}"/>`)
    .join('');
  return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`;
}

function frame(body: string, glow: 'warm' | 'cool'): string {
  const S = CARD_SIZE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#161A3A"/><stop offset="0.55" stop-color="#0E1027"/><stop offset="1" stop-color="#0A0B1C"/></linearGradient>
${glowGradient('warm', '#FF7A1A', 0.42)}
${glowGradient('cool', '#4F7CFF', 0.3)}
${glowGradient('mint', '#34D399', 0.2)}
<linearGradient id="flame" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FF5B1F"/><stop offset="0.55" stop-color="#FF9A1F"/><stop offset="1" stop-color="#FFD23F"/></linearGradient>
<linearGradient id="flameIn" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FFD23F"/><stop offset="1" stop-color="#FFF3B0"/></linearGradient>
<linearGradient id="both" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.gold}"/><stop offset="0.5" stop-color="${C.gold}"/><stop offset="0.5" stop-color="${C.green}"/><stop offset="1" stop-color="${C.green}"/></linearGradient>
<linearGradient id="barNew" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#FFB020"/><stop offset="1" stop-color="#FFD76A"/></linearGradient>
<linearGradient id="barRev" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#19B37E"/><stop offset="1" stop-color="#5EEAD4"/></linearGradient>
</defs>
<rect width="${S}" height="${S}" fill="url(#bg)"/>
${
    glow === 'warm'
      ? `<circle cx="170" cy="300" r="430" fill="url(#warm)"/><circle cx="1000" cy="980" r="420" fill="url(#cool)"/>`
      : `<circle cx="960" cy="140" r="430" fill="url(#cool)"/><circle cx="120" cy="1000" r="420" fill="url(#mint)"/>`
  }
${body}
<rect x="0" y="${S - 18}" width="${S}" height="6" fill="#000000"/><rect x="0" y="${
    S - 12
  }" width="${S}" height="6" fill="#DD0000"/><rect x="0" y="${S - 6}" width="${S}" height="6" fill="#FFCE00"/>
</svg>`;
}

/** Flag pill + "Deutsch · name" on the left, a date (range) on the right. */
function header(name: string | null | undefined, right: string): string {
  const who = name ? cardText(name, 18) : '';
  return [
    `<g>`,
    `<clipPath id="flag"><rect x="64" y="66" width="60" height="40" rx="9"/></clipPath>`,
    `<g clip-path="url(#flag)"><rect x="64" y="66" width="60" height="14" fill="#000000"/><rect x="64" y="79.5" width="60" height="14" fill="#DD0000"/><rect x="64" y="93" width="60" height="13" fill="#FFCE00"/></g>`,
    `<rect x="64" y="66" width="60" height="40" rx="9" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>`,
    text(144, 100, who ? `Deutsch · ${who}` : 'Deutsch', { size: 38, weight: 800 }),
    text(1016, 99, right, { size: 32, fill: C.dim, anchor: 'end' }),
    `</g>`,
  ].join('\n');
}

/** A flame in a 100x124 box, scaled and placed with its top-left at (x, y). */
function flame(x: number, y: number, scale: number, lit: boolean): string {
  const outer =
    'M52 0 C56 22 88 42 88 80 C88 106 71 124 50 124 C29 124 12 106 12 80 C12 62 21 50 28 40 C30 52 36 58 42 58 C36 38 42 16 52 0 Z';
  const inner =
    'M51 60 C54 74 70 82 70 98 C70 111 61 118 50 118 C39 118 30 111 30 98 C30 88 36 82 40 76 C42 84 46 86 48 86 C46 76 48 68 51 60 Z';
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="${outer}" fill="${lit ? 'url(#flame)' : C.flameOff}"/>${
    lit ? `<path d="${inner}" fill="url(#flameIn)"/>` : ''
  }</g>`;
}

/** A stat box. 'row': label left, number right. 'stack': label above the number. */
function tile(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  accent: string,
  layout: 'row' | 'stack',
): string {
  const box = [
    rect(x, y, w, h, 24, C.tile, 'stroke="rgba(255,255,255,0.07)" stroke-width="2"'),
    rect(x, y + 24, 6, h - 48, 3, accent),
  ];
  if (layout === 'row') {
    const size = value.length >= 4 ? 48 : 60;
    box.push(text(x + 32, y + h / 2 + 9, label, { size: 26, fill: C.dim }));
    box.push(text(x + w - 30, y + h / 2 + size * 0.36, value, { size, weight: 800, anchor: 'end' }));
  } else {
    box.push(text(x + 32, y + 46, label, { size: 27, fill: C.dim }));
    box.push(text(x + 32, y + h - 24, value, { size: 56, weight: 800 }));
  }
  return box.join('\n');
}

const activityMap = (days: DayActivity[]) => new Map(days.map((d) => [d.d, d]));

export function statsCard(data: StatsCardData): string {
  const l = L[data.lang];
  const lit = data.streak > 0;
  const parts: string[] = [header(data.name, `${fmtDate(data.lang, data.today)} ${data.today.slice(0, 4)}`)];

  // Streak
  parts.push(flame(64, 168, 2.1, lit));
  parts.push(text(300, 388, String(data.streak), { size: 250, weight: 800, spacing: -6 }));
  parts.push(text(304, 452, l.streakOf(data.streak), { size: 44, weight: 800, fill: lit ? C.gold : C.dim }));
  parts.push(text(1016, 262, l.record, { size: 30, fill: C.dim, anchor: 'end' }));
  parts.push(text(1016, 340, String(data.best), { size: 76, weight: 800, anchor: 'end' }));

  // Calendar: 5 weeks, Monday first; the last row is the current week.
  const cell = 66;
  const gap = 10;
  const gx = 64;
  const gy = 600;
  parts.push(text(gx, 540, l.activity, { size: 30, fill: C.dim }));
  l.weekdays.forEach((w, i) =>
    parts.push(text(gx + i * (cell + gap) + cell / 2, 584, w, { size: 22, fill: C.faint, anchor: 'middle' }))
  );
  const monday = addDays(data.today, -((weekday(data.today) + 6) % 7));
  const start = addDays(monday, -28);
  const byDay = activityMap(data.days);
  for (let i = 0; i < 35; i++) {
    const date = addDays(start, i);
    const x = gx + (i % 7) * (cell + gap);
    const y = gy + Math.floor(i / 7) * (cell + gap);
    const a = byDay.get(date);
    const future = date > data.today;
    const fill = future ? C.cellFuture : a?.n && a?.r ? 'url(#both)' : a?.n ? C.gold : a?.r ? C.green : C.cell;
    const active = !future && Boolean(a?.n || a?.r);
    parts.push(rect(x, y, cell, cell, 14, fill));
    parts.push(
      text(x + cell / 2, y + cell / 2 + 8, String(Number(date.slice(8))), {
        size: 23,
        weight: active ? 800 : 500,
        fill: active ? 'rgba(10,11,28,0.82)' : future ? 'rgba(255,255,255,0.14)' : C.faint,
        anchor: 'middle',
      }),
    );
    if (date === data.today) {
      parts.push(
        `<rect x="${x - 4}" y="${y - 4}" width="${cell + 8}" height="${
          cell + 8
        }" rx="18" fill="none" stroke="#FFFFFF" stroke-width="3"/>`,
      );
    }
  }
  const ly = gy + 5 * (cell + gap) + 28;
  parts.push(rect(gx, ly - 20, 22, 22, 6, C.gold), text(gx + 34, ly, l.legendNew, { size: 24, fill: C.dim }));
  parts.push(rect(gx + 250, ly - 20, 22, 22, 6, C.green), text(gx + 284, ly, l.legendReview, { size: 24, fill: C.dim }));

  // Totals
  const tx = 622;
  const tw = 394;
  const th = 116;
  const tgap = 11;
  parts.push(tile(tx, gy, tw, th, l.topics, String(data.entries), C.gold, 'row'));
  parts.push(tile(tx, gy + th + tgap, tw, th, l.reviews, String(data.reviewsDone), C.green, 'row'));
  parts.push(tile(tx, gy + 2 * (th + tgap), tw, th, l.mastered, String(data.mastered), C.violet, 'row'));

  return frame(parts.join('\n'), 'warm');
}

export function weekCard(data: WeekCardData): string {
  const l = L[data.lang];
  const range = `${fmtDate(data.lang, data.from, { today: data.to })} – ${fmtDate(data.lang, data.to, { today: data.to })}`;
  const parts: string[] = [header(data.name, range)];
  parts.push(text(64, 236, l.weekTitle, { size: 92, weight: 800, spacing: -2 }));

  // One column per day: new topics stacked on reviews done.
  const byDay = activityMap(data.days);
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(data.from, i);
    const a = byDay.get(date);
    return { date, n: a?.n ?? 0, r: a?.r ?? 0 };
  });
  const max = Math.max(1, ...week.map((d) => d.n + d.r));
  const chartTop = 310;
  const chartH = 330;
  const base = chartTop + chartH;
  const colW = 96;
  const colGap = (952 - 7 * colW) / 6;
  week.forEach((d, i) => {
    const x = 64 + i * (colW + colGap);
    const total = d.n + d.r;
    parts.push(rect(x, chartTop, colW, chartH, 22, 'rgba(255,255,255,0.045)'));
    if (total > 0) {
      const h = Math.max(44, Math.round((total / max) * chartH));
      const hNew = d.n ? Math.max(d.r ? 22 : h, Math.round((d.n / total) * h)) : 0;
      const hRev = h - hNew;
      const clip = `wk${i}`;
      parts.push(`<clipPath id="${clip}"><rect x="${x}" y="${base - h}" width="${colW}" height="${h}" rx="22"/></clipPath>`);
      parts.push(`<g clip-path="url(#${clip})">`);
      if (hRev > 0) parts.push(`<rect x="${x}" y="${base - hRev}" width="${colW}" height="${hRev}" fill="url(#barRev)"/>`);
      if (hNew > 0) parts.push(`<rect x="${x}" y="${base - h}" width="${colW}" height="${hNew}" fill="url(#barNew)"/>`);
      parts.push(`</g>`);
      parts.push(text(x + colW / 2, base - h - 14, String(total), { size: 30, weight: 800, anchor: 'middle' }));
    }
    const label = l.weekdays[(weekday(d.date) + 6) % 7];
    parts.push(
      text(x + colW / 2, base + 44, label, {
        size: 28,
        fill: total ? C.text : C.faint,
        weight: total ? 800 : 500,
        anchor: 'middle',
      }),
    );
  });
  const ly = base + 96;
  parts.push(rect(64, ly - 20, 22, 22, 6, C.gold), text(98, ly, l.legendNew, { size: 24, fill: C.dim }));
  parts.push(rect(314, ly - 20, 22, 22, 6, C.green), text(348, ly, l.legendReview, { size: 24, fill: C.dim }));

  const ty = 790;
  const tw = (952 - 2 * 20) / 3;
  const reviews = data.reviewsDue ? `${data.reviewsDone}/${data.reviewsDue}` : String(data.reviewsDone);
  parts.push(tile(64, ty, tw, 124, l.weekTopics, String(data.newTopics), C.gold, 'stack'));
  parts.push(tile(64 + tw + 20, ty, tw, 124, l.weekDays, `${data.activeDays}/7`, C.violet, 'stack'));
  parts.push(tile(64 + 2 * (tw + 20), ty, tw, 124, l.weekReviews, reviews, C.green, 'stack'));

  const lit = data.streak > 0;
  parts.push(flame(64, 948, 0.62, lit));
  parts.push(text(146, 1004, l.streak(data.streak), { size: 40, weight: 800, fill: lit ? C.gold : C.dim }));
  parts.push(
    text(1016, 1004, data.activeDays >= 5 ? l.great : data.activeDays >= 3 ? l.good : l.low, {
      size: 34,
      fill: C.dim,
      anchor: 'end',
    }),
  );

  return frame(parts.join('\n'), 'cool');
}

/** The /stats card for a user. */
export function statsCardFor(
  user: { lang: Lang; first_name: string | null; local_date: Ymd },
  stats: Stats,
  days: DayActivity[],
): string {
  return statsCard({
    lang: user.lang,
    name: user.first_name,
    today: user.local_date,
    streak: stats.current,
    best: stats.best,
    entries: stats.entries_total,
    reviewsDone: stats.reviews_done,
    mastered: stats.mastered ?? 0,
    days,
  });
}

/** The weekly summary card. */
export function weekCardFor(lang: Lang, name: string | null | undefined, w: WeekSummary, days: DayActivity[]): string {
  return weekCard({
    lang,
    name,
    from: w.from,
    to: w.to,
    streak: w.current,
    newTopics: w.entries.length,
    activeDays: w.week_days,
    reviewsDone: w.reviews_done,
    reviewsDue: w.reviews_due,
    days,
  });
}
