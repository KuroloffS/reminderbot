// Turning what the user types into data: study notes (with an optional date at the start of a
// line, like the notes "4 noyabr. 1-leksion lugati…"), times, intervals and time zones.
import { addDays, isValidDate, pad2, type Ymd, ymd } from './dates.ts';

// Month names: Uzbek (Latin), Russian / Uzbek Cyrillic, German, English. A word is a month when it
// is one of the abbreviations or starts with a full stem followed by a short ending
// (ноября, noyabrda, Novembers …).
const STEMS: string[][] = [
  ['yanvar', 'январ', 'januar', 'january'],
  ['fevral', 'феврал', 'februar', 'february'],
  ['mart', 'март', 'märz', 'maerz', 'marz', 'march'],
  ['aprel', 'апрел', 'april'],
  ['may', 'май', 'мая', 'mai'],
  ['iyun', 'июн', 'juni', 'june'],
  ['iyul', 'июл', 'juli', 'july'],
  ['avgust', 'август', 'august'],
  ['sentyabr', 'sentabr', 'сентябр', 'september'],
  ['oktyabr', 'oktabr', 'октябр', 'oktober', 'october'],
  ['noyabr', 'ноябр', 'november'],
  ['dekabr', 'декабр', 'dezember', 'december'],
];
const ABBREVIATIONS: string[][] = [
  ['yan', 'jan', 'янв'],
  ['fev', 'feb', 'фев', 'февр'],
  ['mar', 'mär', 'mrz', 'мар'],
  ['apr', 'апр'],
  [],
  ['jun', 'июн'],
  ['jul', 'июл'],
  ['avg', 'aug', 'авг'],
  ['sen', 'sep', 'sept', 'сен', 'сент'],
  ['okt', 'oct', 'окт'],
  ['noy', 'nov', 'ноя', 'нояб'],
  ['dek', 'dec', 'dez', 'дек'],
];
// Look like months but are not: Uzbek "marta" = "times" ("3 marta takrorladim").
const NOT_MONTHS = new Set(['marta']);

const APOSTROPHES = /[ʻʼ'`’‘]/g;

/** 1..12 for a month name in any of the supported languages, otherwise null. */
export function monthFromWord(word: string): number | null {
  const w = word.toLowerCase().replace(APOSTROPHES, '').replace(/\.+$/, '').replace(/ё/g, 'е');
  if (!w || NOT_MONTHS.has(w)) return null;
  for (let i = 0; i < 12; i++) if (ABBREVIATIONS[i].includes(w)) return i + 1;
  for (let i = 0; i < 12; i++) {
    for (const stem of STEMS[i]) if (w.startsWith(stem) && w.length - stem.length <= 4) return i + 1;
  }
  return null;
}

const RELATIVE: Record<string, number> = {
  'сегодня': 0,
  'вчера': -1,
  'позавчера': -2,
  'heute': 0,
  'gestern': -1,
  'vorgestern': -2,
  'bugun': 0,
  'kecha': -1,
  'бугун': 0,
  'кеча': -1,
  'today': 0,
  'yesterday': -1,
};

const LETTERS = "[\\p{L}ʻʼ'`’‘]+";
const YEAR_TAIL = '(?:\\s*-?\\s*(?:yil|йил|года|г\\.?|y\\.)(?![\\p{L}]))?';
const RE_RELATIVE = /^(\p{L}+)(?=$|[\s.,:;!)\-–—])/u;
const RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;
const RE_NUMERIC = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?![\d])/;
const RE_DAY_MONTH = new RegExp(`^(\\d{1,2})\\s*[-–.]?\\s*(${LETTERS})\\.?(?:\\s*,?\\s*(\\d{4})(?!\\d)${YEAR_TAIL})?`, 'u');
const RE_MONTH_DAY = new RegExp(`^(${LETTERS})\\.?\\s+(\\d{1,2})(?!\\d)(?:,?\\s+(\\d{4})(?!\\d)${YEAR_TAIL})?`, 'u');
const SEPARATORS = /^[\s.,:;!)\]\-–—]+/;

/**
 * A date without a year means the most recent such day (never in the future): on 4 Nov 2026
 * "6 noyabr" is 6 Nov 2025. A date with an explicit year in the future is not treated as a date.
 */
function resolveDate(year: number | null, month: number, day: number, ref: Ymd): Ymd | null {
  if (year !== null) {
    const y = year < 100 ? 2000 + year : year;
    if (!isValidDate(y, month, day)) return null;
    const date = ymd(y, month, day);
    return date <= ref ? date : null;
  }
  const refYear = Number(ref.slice(0, 4));
  for (const y of [refYear, refYear - 1]) {
    if (!isValidDate(y, month, day)) continue;
    const date = ymd(y, month, day);
    if (date <= ref) return date;
  }
  return null;
}

export type DatePrefix = { date: Ymd; rest: string };

/**
 * Date at the start of a line: "4 noyabr. …", "5- noyabr …", "4. November: …", "04.11 …",
 * "4.11.2025 …", "2026-11-04 …", "November 4 …", "вчера: …", "gestern – …".
 * `ref` is the user's local today (or the day a forwarded message was written).
 * Relative words ("вчера", "gestern") start a new entry on later lines only when punctuation
 * follows them, so "Heute habe ich …" in the middle of a note stays part of that note.
 */
export function parseDatePrefix(line: string, ref: Ymd, firstLine = true): DatePrefix | null {
  const s = line.trimStart();
  let m: RegExpMatchArray | null;

  if ((m = s.match(RE_RELATIVE))) {
    const shift = RELATIVE[m[1].toLowerCase()];
    if (shift !== undefined) {
      const after = s.slice(m[0].length);
      const punctuated = /^\s*[.,:;!)\-–—]/.test(after);
      if (punctuated) return { date: addDays(ref, shift), rest: after.replace(SEPARATORS, '') };
      if (firstLine) return { date: addDays(ref, shift), rest: s }; // a sentence: keep the word in the note
      return null;
    }
  }

  let date: Ymd | null = null;
  let length = 0;
  if ((m = s.match(RE_ISO))) {
    date = resolveDate(Number(m[1]), Number(m[2]), Number(m[3]), ref);
    length = m[0].length;
  } else if ((m = s.match(RE_NUMERIC)) && (m[3] || m[2].length === 2)) {
    // "04.11", "4.11", "4.11.2025" – but not "1.2" (could be a lesson number).
    date = resolveDate(m[3] ? Number(m[3]) : null, Number(m[2]), Number(m[1]), ref);
    length = m[0].length;
  } else if ((m = s.match(RE_DAY_MONTH))) {
    const month = monthFromWord(m[2]);
    if (month) {
      date = resolveDate(m[3] ? Number(m[3]) : null, month, Number(m[1]), ref);
      length = m[0].length;
    }
  } else if ((m = s.match(RE_MONTH_DAY))) {
    const month = monthFromWord(m[1]);
    if (month) {
      date = resolveDate(m[3] ? Number(m[3]) : null, month, Number(m[2]), ref);
      length = m[0].length;
    }
  }
  if (!date) return null;
  return { date, rest: s.slice(length).replace(SEPARATORS, '') };
}

export type ParsedItem = { date: Ymd | null; content: string };

/**
 * One message can hold several notes: every line that starts with a date begins a new one, and
 * the lines below it belong to it. A note without a date gets the default date (date: null).
 */
export function splitEntries(text: string, ref: Ymd): ParsedItem[] {
  const items: ParsedItem[] = [];
  let current: ParsedItem | null = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const prefix = parseDatePrefix(line, ref, items.length === 0);
    if (prefix) {
      current = { date: prefix.date, content: prefix.rest };
      items.push(current);
    } else if (current) {
      current.content = current.content ? `${current.content}\n${line}` : line;
    } else {
      current = { date: null, content: line };
      items.push(current);
    }
  }
  return items.map((i) => ({ date: i.date, content: i.content.trim() })).filter((i) => i.content !== '');
}

/** "8", "08:30", "8.30", "830", "20 Uhr", "21ч" -> "HH:MM". */
export function parseTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s*(uhr|ч|h)\.?$/u, '');
  let m: RegExpMatchArray | null;
  let h: number;
  let min = 0;
  if ((m = t.match(/^(\d{1,2})\s*[:.\-\s]\s*(\d{2})$/))) {
    h = Number(m[1]);
    min = Number(m[2]);
  } else if ((m = t.match(/^(\d{1,2})$/))) {
    h = Number(m[1]);
  } else if ((m = t.match(/^(\d{1,2})(\d{2})$/))) {
    h = Number(m[1]);
    min = Number(m[2]);
  } else {
    return null;
  }
  if (h > 23 || min > 59) return null;
  return `${pad2(h)}:${pad2(min)}`;
}

/** "1 3 7 14 30" / "1, 3, 7" -> sorted unique days (1..365, at most 10 values). */
export function parseIntervals(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 10) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 365)) return null;
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** "+5", "-3", "UTC+5:30", "GMT+3", "5" -> minutes east of UTC. */
export function parseUtcOffset(text: string): number | null {
  const m = text.trim().toUpperCase().replace(/^(UTC|GMT)\s*/, '').match(/^([+-]?)\s*(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const minutesPart = Number(m[3] ?? 0);
  if (minutesPart >= 60) return null;
  const total = Number(m[2]) * 60 + minutesPart;
  const value = m[1] === '-' ? -total : total;
  return value >= -720 && value <= 840 ? value : null;
}

const OFFSET_ZONES: Record<number, string> = {
  330: 'Asia/Kolkata',
  345: 'Asia/Kathmandu',
  270: 'Asia/Kabul',
  210: 'Asia/Tehran',
  390: 'Asia/Yangon',
  570: 'Australia/Darwin',
  525: 'Australia/Eucla',
  765: 'Pacific/Chatham',
  [-210]: 'America/St_Johns',
  [-570]: 'Pacific/Marquesas',
};

/** Fixed-offset zone for whole hours (note the inverted sign of Etc/GMT zones). */
export function offsetToZone(minutes: number): string | null {
  if (minutes === 0) return 'Etc/UTC';
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h >= -12 && h <= 14 ? `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}` : null;
  }
  return OFFSET_ZONES[minutes] ?? null;
}

const CITY_ZONES: Record<string, string> = {
  'ташкент': 'Asia/Tashkent',
  'тошкент': 'Asia/Tashkent',
  'toshkent': 'Asia/Tashkent',
  'taschkent': 'Asia/Tashkent',
  'узбекистан': 'Asia/Tashkent',
  'ўзбекистон': 'Asia/Tashkent',
  'ozbekiston': 'Asia/Tashkent',
  'uzbekistan': 'Asia/Tashkent',
  'usbekistan': 'Asia/Tashkent',
  'бухара': 'Asia/Tashkent',
  'buxoro': 'Asia/Tashkent',
  'андижан': 'Asia/Tashkent',
  'andijon': 'Asia/Tashkent',
  'наманган': 'Asia/Tashkent',
  'namangan': 'Asia/Tashkent',
  'фергана': 'Asia/Tashkent',
  'fargona': 'Asia/Tashkent',
  'самарканд': 'Asia/Samarkand',
  'самарқанд': 'Asia/Samarkand',
  'samarqand': 'Asia/Samarkand',
  'москва': 'Europe/Moscow',
  'moskau': 'Europe/Moscow',
  'россия': 'Europe/Moscow',
  'санкт-петербург': 'Europe/Moscow',
  'берлин': 'Europe/Berlin',
  'германия': 'Europe/Berlin',
  'deutschland': 'Europe/Berlin',
  'germany': 'Europe/Berlin',
  'мюнхен': 'Europe/Berlin',
  'münchen': 'Europe/Berlin',
  'munich': 'Europe/Berlin',
  'гамбург': 'Europe/Berlin',
  'hamburg': 'Europe/Berlin',
  'франкфурт': 'Europe/Berlin',
  'frankfurt': 'Europe/Berlin',
  'кельн': 'Europe/Berlin',
  'köln': 'Europe/Berlin',
  'cologne': 'Europe/Berlin',
  'düsseldorf': 'Europe/Berlin',
  'stuttgart': 'Europe/Berlin',
  'leipzig': 'Europe/Berlin',
  'dresden': 'Europe/Berlin',
  'hannover': 'Europe/Berlin',
  'nürnberg': 'Europe/Berlin',
  'bremen': 'Europe/Berlin',
  'bonn': 'Europe/Berlin',
  'вена': 'Europe/Vienna',
  'wien': 'Europe/Vienna',
  'австрия': 'Europe/Vienna',
  'österreich': 'Europe/Vienna',
  'цюрих': 'Europe/Zurich',
  'zürich': 'Europe/Zurich',
  'швейцария': 'Europe/Zurich',
  'schweiz': 'Europe/Zurich',
  'алматы': 'Asia/Almaty',
  'астана': 'Asia/Almaty',
  'бишкек': 'Asia/Bishkek',
  'душанбе': 'Asia/Dushanbe',
  'ашхабад': 'Asia/Ashgabat',
  'стамбул': 'Europe/Istanbul',
  'дубай': 'Asia/Dubai',
  'лондон': 'Europe/London',
  'сеул': 'Asia/Seoul',
  'нью-йорк': 'America/New_York',
};

/** What to try as the time zone: an offset zone, a known city, or the text itself (checked by the DB). */
export function timezoneCandidate(text: string): string | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t || t.length > 50) return null;
  const offset = parseUtcOffset(t);
  if (offset !== null) return offsetToZone(offset);
  const city = CITY_ZONES[t.toLowerCase().replace(/ё/g, 'е').replace(APOSTROPHES, '')];
  if (city) return city;
  return /^\p{L}[\p{L}_\-/ ]*$/u.test(t) ? t : null;
}
