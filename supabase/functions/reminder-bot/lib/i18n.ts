// Interface texts: Russian and German. Texts use Telegram HTML; user text is escaped by callers.
import { diffDays, weekday, type Ymd } from './dates.ts';

export type Lang = 'ru' | 'de';
export const LANGS: Lang[] = ['ru', 'de'];
export const isLang = (v: unknown): v is Lang => v === 'ru' || v === 'de';

const MONTHS: Record<Lang, string[]> = {
  ru: ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'],
  de: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'],
};
const WEEKDAYS: Record<Lang, string[]> = {
  ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  de: ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'],
};
const RELATIVE_DAYS: Record<Lang, Record<string, string>> = {
  ru: { '-1': 'вчера', '0': 'сегодня', '1': 'завтра' },
  de: { '-1': 'gestern', '0': 'heute', '1': 'morgen' },
};

export type DateFormat = { today?: Ymd; relative?: boolean; weekday?: boolean };

/** "4 нояб." / "4. Nov."; year only when it is not the current one; optional "завтра"/"morgen". */
export function fmtDate(lang: Lang, date: Ymd, opts: DateFormat = {}): string {
  if (opts.relative && opts.today) {
    const word = RELATIVE_DAYS[lang][String(diffDays(date, opts.today))];
    if (word) return word;
  }
  const [y, m, d] = date.split('-').map(Number);
  let s = lang === 'de' ? `${d}. ${MONTHS.de[m - 1]}` : `${d} ${MONTHS.ru[m - 1]}`;
  if (opts.today && y !== Number(opts.today.slice(0, 4))) s += ` ${y}`;
  if (opts.weekday) s = `${WEEKDAYS[lang][weekday(date)]}, ${s}`;
  return s;
}

/** "сегодня, 4 нояб." */
export function fmtDateLong(lang: Lang, date: Ymd, today: Ymd): string {
  const plain = fmtDate(lang, date, { today });
  const word = fmtDate(lang, date, { today, relative: true });
  return word === plain ? plain : `${word}, ${plain}`;
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

export function days(lang: Lang, n: number): string {
  return lang === 'de' ? (n === 1 ? 'Tag' : 'Tage') : pluralRu(n, 'день', 'дня', 'дней');
}

/** "1, 3, 7 и 30" / "1, 3, 7 und 30". */
export function joinList(lang: Lang, items: (string | number)[]): string {
  const parts = items.map(String);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} ${lang === 'de' ? 'und' : 'и'} ${parts[parts.length - 1]}`;
}

export function fmtOffset(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Bump when COMMANDS change: chats that chose a language get their menu again (see refreshMenu in bot.ts). */
export const MENU_VERSION = 2;

export const COMMANDS: Record<Lang, [string, string][]> = {
  ru: [
    ['today', 'Что повторить сегодня'],
    ['list', 'Мои записи'],
    ['stats', 'Статистика и серия'],
    ['awards', 'Награды'],
    ['week', 'Итоги недели'],
    ['settings', 'Настройки'],
    ['help', 'Как пользоваться'],
  ],
  de: [
    ['today', 'Heute wiederholen'],
    ['list', 'Meine Einträge'],
    ['stats', 'Statistik & Serie'],
    ['awards', 'Abzeichen'],
    ['week', 'Wochenrückblick'],
    ['settings', 'Einstellungen'],
    ['help', "So funktioniert's"],
  ],
};

const ru = {
  langName: 'Русский',
  botDescription: 'Помогаю не забывать пройденное на курсе немецкого. После урока напишите, что изучили, — я напомню повторить ' +
    'через 1, 3, 7, 14 и 30 дней (интервальное повторение). Вечером спрошу, если вы ничего не записали, ' +
    'а в воскресенье пришлю итоги недели.',
  botShortDescription: 'Напоминаю повторять уроки немецкого 🇩🇪',

  askTime: (tz: string) => `⏰ Во сколько присылать напоминание о повторении?\n🌍 Часовой пояс: ${tz}`,
  changeTz: '🌍 Сменить часовой пояс',
  onboardDone: (time: string) => `✅ Готово! Напоминания — каждый день в ${time}.`,
  help: (time: string, intervals: number[]) =>
    '📘 <b>Как пользоваться</b>\n\n' +
    '1️⃣ После урока напишите мне, что вы изучили. Например:\n' +
    '<i>«2-я лекция: лексика, склонение прилагательных»</i>\n\n' +
    `2️⃣ Я напомню повторить через ${joinList('ru', intervals)} ${days('ru', intervals[intervals.length - 1])} — в ${time}.\n\n` +
    '3️⃣ В напоминании отмечайте ✅ то, что повторили.\n\n' +
    '📅 Дата по умолчанию — сегодня. Её можно указать в начале: <i>«3 ноября. …»</i>, <i>«03.11 …»</i> или <i>«вчера: …»</i>.\n' +
    '📥 Можно вставить сразу весь старый журнал: каждая строка, которая начинается с даты, станет отдельной записью.\n\n' +
    '/today — что повторить сегодня\n' +
    '/list — мои записи\n' +
    '/stats — статистика и серия 🔥\n' +
    '/awards — награды 🏅\n' +
    '/week — итоги недели\n' +
    '/settings — язык, время, интервалы',
  defaultsHint: (time: string) => `⏰ Напоминания приходят в ${time}. Изменить: /settings`,

  saved: (date: string) => `✅ Записано · 📅 ${date}`,
  savedMany: (n: number) => `✅ Записано: ${n}`,
  edited: '✏️ Изменено',
  textUpdated: '✏️ Текст записи обновлён.',
  willRemind: (dates: string) => `🔁 Напомню повторить: ${dates}`,
  historyOnly: '📦 Сохранено в истории — все повторения уже в прошлом.',
  historyShort: '📦 в истории',
  btnDelete: '🗑 Удалить',
  btnDeleteAll: '🗑 Удалить все',
  btnYesDelete: '🗑 Да, удалить',
  btnCancel: '« Отмена',
  confirmDeleteEntry: (date: string, content: string) => `Удалить эту запись вместе с напоминаниями?\n\n📅 ${date} — ${content}`,
  deleted: '🗑 Удалено.',
  notFound: 'Запись не найдена — возможно, она уже удалена.',
  needContent: '✍️ Напишите, что именно вы изучили. Например: <i>«2-я лекция: лексика»</i>',
  onlyText: 'Я понимаю только текст ✍️ Напишите, что вы изучили.',
  unknownCommand: '🤷 Не знаю такой команды. /help — список команд.',

  digestTitle: (n: number) => (n > 1 ? `🔁 <b>Пора повторить!</b> Тем на сегодня: ${n}` : '🔁 <b>Пора повторить!</b>'),
  digestHint: 'Повторите и отметьте ✅',
  step: (i: number, n: number) => `повторение ${i}/${n}`,
  movedTomorrow: 'перенесено на завтра',
  allDone: '🎉 <b>Отлично, всё повторено!</b>',
  partDone: '👍 <b>Готово!</b> Остальное напомню завтра.',
  streakLine: (n: number) => `🔥 Серия: ${n} ${days('ru', n)} подряд`,
  btnDoneAll: '✅ Всё повторено',
  btnDoneOne: '✅ Повторено',
  btnSnooze: '⏰ На завтра',
  toastDone: '✅ Отмечено',
  toastSnoozed: '⏰ Напомню завтра',
  toastGone: 'Это напоминание устарело.',
  nothingToday: '🎉 Сегодня повторять нечего.',
  nextReview: (date: string) => `Следующее повторение: ${date}.`,
  nothingPlanned: 'Напишите, что вы изучили, — и я составлю план повторений ✍️',

  listTitle: '📚 <b>Ваши записи</b>',
  listTitlePart: (shown: number, total: number) => `📚 <b>Последние записи</b> (${shown} из ${total})`,
  listEmpty: 'Пока нет записей. Напишите, что вы изучили ✍️',
  listNext: (date: string) => `след. ${date}`,
  listFinished: '🏁 план завершён',
  listNoReviews: '📦 без повторений',
  listFooter: 'Удалить запись — нажмите /del_… под ней.',

  statsTitle: '📊 <b>Статистика</b>',
  statsStreak: (cur: number, best: number) => `🔥 Серия: ${cur} ${days('ru', cur)} · рекорд: ${best}`,
  statsEntries: (total: number, week: number) => `📚 Записей: ${total} · за 7 дней: ${week}`,
  statsActive: (n: number) => `📆 Дней с занятиями: ${n}`,
  statsDone: (n: number) => `✅ Повторений сделано: ${n}`,
  statsQueue: (today: number, upcoming: number) => `⏳ На сегодня: ${today} · запланировано: ${upcoming}`,
  statsNext: (date: string) => `🗓 Следующее повторение: ${date}`,
  statsFirst: (date: string) => `📅 Первая запись: ${date}`,
  statsMastered: (n: number) => `🎓 Закреплено тем: ${n}`,

  awardsTitle: (have: number, total: number) => `🏅 <b>Награды</b> · ${have} из ${total}`,
  awardGroups: { streak: 'Серия дней', entries: 'Темы', reviews: 'Повторения', mastered: 'Закреплённые темы' },
  awardsGroupDone: '✨ все получены',
  awardsNote: '🎓 Тема закреплена, когда пройдено её последнее повторение.',
  newAward: '🏅 <b>Новая награда!</b>',
  newAwards: (n: number) => `🏅 <b>Новые награды: ${n}</b>`,
  awardsHint: 'Все награды: /awards',
  btnAwards: (have: number, total: number) => `🏅 Награды ${have}/${total}`,
  masteredMark: 'тема закреплена',

  weekTitle: (from: string, to: string) => `📊 <b>Итоги недели</b> · ${from} – ${to}`,
  weekEntries: (n: number) => `📚 Новых тем: ${n}`,
  weekDays: (n: number) => `📆 Дней с занятиями: ${n} из 7`,
  weekReviews: (done: number, due: number) => `✅ Повторено: ${done} из ${due}`,
  weekStreak: (n: number) => `🔥 Серия: ${n} ${days('ru', n)}`,
  weekTopics: 'Темы недели:',
  weekMore: (n: number) => `… и ещё ${n}`,
  weekGreat: 'Так держать! 💪',
  weekGood: 'Хороший темп! Ещё немного — и это станет привычкой 👍',
  weekLow: 'Понемногу каждый день — лучший способ выучить язык 🌱',
  weekEmpty: '📊 За последние 7 дней записей нет. Начните сегодня — даже 15 минут помогают! 💪',

  nudge: '🌙 Добрый вечер! Что сегодня изучили по немецкому?\nНапишите пару слов — я напомню повторить.',
  btnNudgeOff: '🔕 Не спрашивать вечером',
  nudgeOff: '🔕 Хорошо, вечером больше не спрашиваю. Включить снова: /settings',

  settingsTitle: '⚙️ <b>Настройки</b>',
  setLang: (v: string) => `🌐 Язык: ${v}`,
  setTime: (v: string) => `⏰ Напоминание: ${v}`,
  setTz: (v: string) => `🌍 Часовой пояс: ${v}`,
  setIntervals: (v: string) => `🔁 Интервалы: ${v} дн.`,
  setNudge: (v: string) => `🌙 Вечерний вопрос: ${v}`,
  setWeekly: (v: string) => `📊 Итоги недели: ${v}`,
  off: 'выкл',
  weeklyOn: 'вс, 20:00',
  btnLang: '🌐 Язык',
  btnTime: '⏰ Время',
  btnTz: '🌍 Часовой пояс',
  btnIntervals: '🔁 Интервалы',
  btnEvening: '🌙 Вечер',
  btnWeekly: (on: boolean) => `📊 Итоги: ${on ? 'вкл' : 'выкл'}`,
  btnSettings: '⚙️ Настройки',
  btnBack: '« Назад',
  btnOther: '✏️ Другое',
  btnOwn: '✏️ Свои',
  btnOff: '🔕 Выключить',
  pickLang: '🌐 Выберите язык:',
  pickTime: (cur: string) => `⏰ Когда присылать напоминание? Сейчас: ${cur}`,
  pickTz: (cur: string) => `🌍 Часовой пояс. Сейчас: ${cur}`,
  pickIntervals: (cur: string) => `🔁 Через сколько дней повторять? Сейчас: ${cur}\nНовые интервалы действуют для новых записей.`,
  pickEvening: (cur: string) =>
    `🌙 Вечерний вопрос «Что сегодня изучили?» приходит, только если за день ничего не записано. Сейчас: ${cur}`,
  promptTime: '✏️ Отправьте время, например <b>08:30</b>',
  promptTz: '✏️ Отправьте город (<b>Tashkent</b>, <b>Berlin</b>) или смещение от UTC (<b>+5</b>, <b>-3</b>)',
  promptIntervals: '✏️ Отправьте интервалы в днях через пробел, например: <b>1 3 7 14 30</b>',
  promptEvening: '✏️ Отправьте время, например <b>21:30</b>, или «выкл»',
  invalid: (prompt: string) => `❌ Не получилось разобрать.\n${prompt}`,
  savedSettings: '✅ Сохранено.',
  cancelled: 'Отменено.',
};

type Texts = typeof ru;

const de: Texts = {
  langName: 'Deutsch',
  botDescription:
    'Ich helfe dir, das im Deutschkurs Gelernte nicht zu vergessen. Schreib mir nach dem Unterricht, was du gelernt hast – ' +
    'ich erinnere dich nach 1, 3, 7, 14 und 30 Tagen ans Wiederholen (Spaced Repetition). Abends frage ich nach, wenn du ' +
    'nichts eingetragen hast, und sonntags gibt es einen Wochenrückblick.',
  botShortDescription: 'Ich erinnere dich ans Wiederholen deiner Deutschlektionen 🇩🇪',

  askTime: (tz: string) => `⏰ Um wie viel Uhr soll ich dich ans Wiederholen erinnern?\n🌍 Zeitzone: ${tz}`,
  changeTz: '🌍 Zeitzone ändern',
  onboardDone: (time: string) => `✅ Fertig! Die Erinnerung kommt jeden Tag um ${time} Uhr.`,
  help: (time: string, intervals: number[]) =>
    "📘 <b>So funktioniert's</b>\n\n" +
    '1️⃣ Schreib mir nach dem Unterricht, was du gelernt hast. Zum Beispiel:\n' +
    '<i>„Lektion 2: Wortschatz, Adjektivdeklination“</i>\n\n' +
    `2️⃣ Ich erinnere dich nach ${joinList('de', intervals)} ${
      intervals[intervals.length - 1] === 1 ? 'Tag' : 'Tagen'
    } ans Wiederholen – um ${time} Uhr.\n\n` +
    '3️⃣ Markiere in der Erinnerung mit ✅, was du wiederholt hast.\n\n' +
    '📅 Standardmäßig gilt das heutige Datum. Du kannst es auch an den Anfang schreiben: <i>„3. November: …“</i>, <i>„03.11 …“</i> oder <i>„gestern: …“</i>.\n' +
    '📥 Du kannst auch dein ganzes altes Lerntagebuch einfügen: Jede Zeile, die mit einem Datum beginnt, wird ein eigener Eintrag.\n\n' +
    '/today – heute wiederholen\n' +
    '/list – meine Einträge\n' +
    '/stats – Statistik & Serie 🔥\n' +
    '/awards – Abzeichen 🏅\n' +
    '/week – Wochenrückblick\n' +
    '/settings – Sprache, Uhrzeit, Intervalle',
  defaultsHint: (time: string) => `⏰ Die Erinnerung kommt um ${time} Uhr. Ändern: /settings`,

  saved: (date: string) => `✅ Gespeichert · 📅 ${date}`,
  savedMany: (n: number) => `✅ Gespeichert: ${n}`,
  edited: '✏️ Geändert',
  textUpdated: '✏️ Der Text des Eintrags wurde aktualisiert.',
  willRemind: (dates: string) => `🔁 Ich erinnere dich: ${dates}`,
  historyOnly: '📦 Im Verlauf gespeichert – alle Wiederholungen liegen schon in der Vergangenheit.',
  historyShort: '📦 im Verlauf',
  btnDelete: '🗑 Löschen',
  btnDeleteAll: '🗑 Alle löschen',
  btnYesDelete: '🗑 Ja, löschen',
  btnCancel: '« Abbrechen',
  confirmDeleteEntry: (date: string, content: string) => `Diesen Eintrag samt Erinnerungen löschen?\n\n📅 ${date} – ${content}`,
  deleted: '🗑 Gelöscht.',
  notFound: 'Eintrag nicht gefunden – vielleicht wurde er schon gelöscht.',
  needContent: '✍️ Schreib, was genau du gelernt hast. Zum Beispiel: <i>„Lektion 2: Wortschatz“</i>',
  onlyText: 'Ich verstehe nur Text ✍️ Schreib, was du gelernt hast.',
  unknownCommand: '🤷 Diesen Befehl kenne ich nicht. /help – alle Befehle.',

  digestTitle: (
    n: number,
  ) => (n > 1 ? `🔁 <b>Zeit zum Wiederholen!</b> Themen für heute: ${n}` : '🔁 <b>Zeit zum Wiederholen!</b>'),
  digestHint: 'Wiederhole und markiere mit ✅',
  step: (i: number, n: number) => `Wiederholung ${i}/${n}`,
  movedTomorrow: 'auf morgen verschoben',
  allDone: '🎉 <b>Super, alles wiederholt!</b>',
  partDone: '👍 <b>Erledigt!</b> Den Rest gibt es morgen.',
  streakLine: (n: number) => `🔥 Serie: ${n} ${days('de', n)} am Stück`,
  btnDoneAll: '✅ Alles wiederholt',
  btnDoneOne: '✅ Wiederholt',
  btnSnooze: '⏰ Auf morgen',
  toastDone: '✅ Erledigt',
  toastSnoozed: '⏰ Morgen wieder',
  toastGone: 'Diese Erinnerung ist veraltet.',
  nothingToday: '🎉 Heute gibt es nichts zu wiederholen.',
  nextReview: (date: string) => `Nächste Wiederholung: ${date}.`,
  nothingPlanned: 'Schreib, was du gelernt hast – ich plane die Wiederholungen ✍️',

  listTitle: '📚 <b>Deine Einträge</b>',
  listTitlePart: (shown: number, total: number) => `📚 <b>Letzte Einträge</b> (${shown} von ${total})`,
  listEmpty: 'Noch keine Einträge. Schreib, was du gelernt hast ✍️',
  listNext: (date: string) => `nächste ${date}`,
  listFinished: '🏁 Plan abgeschlossen',
  listNoReviews: '📦 ohne Wiederholungen',
  listFooter: 'Eintrag löschen – tippe auf /del_… darunter.',

  statsTitle: '📊 <b>Statistik</b>',
  statsStreak: (cur: number, best: number) => `🔥 Serie: ${cur} ${days('de', cur)} · Rekord: ${best}`,
  statsEntries: (total: number, week: number) => `📚 Einträge: ${total} · letzte 7 Tage: ${week}`,
  statsActive: (n: number) => `📆 Lerntage: ${n}`,
  statsDone: (n: number) => `✅ Wiederholungen erledigt: ${n}`,
  statsQueue: (today: number, upcoming: number) => `⏳ Heute: ${today} · geplant: ${upcoming}`,
  statsNext: (date: string) => `🗓 Nächste Wiederholung: ${date}`,
  statsFirst: (date: string) => `📅 Erster Eintrag: ${date}`,
  statsMastered: (n: number) => `🎓 Gefestigte Themen: ${n}`,

  awardsTitle: (have: number, total: number) => `🏅 <b>Abzeichen</b> · ${have} von ${total}`,
  awardGroups: { streak: 'Serie', entries: 'Themen', reviews: 'Wiederholungen', mastered: 'Gefestigte Themen' },
  awardsGroupDone: '✨ alle erreicht',
  awardsNote: '🎓 Ein Thema ist gefestigt, wenn seine letzte Wiederholung erledigt ist.',
  newAward: '🏅 <b>Neues Abzeichen!</b>',
  newAwards: (n: number) => `🏅 <b>Neue Abzeichen: ${n}</b>`,
  awardsHint: 'Alle Abzeichen: /awards',
  btnAwards: (have: number, total: number) => `🏅 Abzeichen ${have}/${total}`,
  masteredMark: 'Thema gefestigt',

  weekTitle: (from: string, to: string) => `📊 <b>Wochenrückblick</b> · ${from} – ${to}`,
  weekEntries: (n: number) => `📚 Neue Themen: ${n}`,
  weekDays: (n: number) => `📆 Lerntage: ${n} von 7`,
  weekReviews: (done: number, due: number) => `✅ Wiederholt: ${done} von ${due}`,
  weekStreak: (n: number) => `🔥 Serie: ${n} ${days('de', n)}`,
  weekTopics: 'Themen der Woche:',
  weekMore: (n: number) => `… und ${n} weitere`,
  weekGreat: 'Weiter so! 💪',
  weekGood: 'Gutes Tempo! Noch ein bisschen, dann wird es zur Gewohnheit 👍',
  weekLow: 'Jeden Tag ein bisschen – so lernt man eine Sprache am besten 🌱',
  weekEmpty: '📊 In den letzten 7 Tagen gab es keine Einträge. Fang heute an – schon 15 Minuten helfen! 💪',

  nudge: '🌙 Guten Abend! Was hast du heute auf Deutsch gelernt?\nSchreib es kurz auf – ich erinnere dich ans Wiederholen.',
  btnNudgeOff: '🔕 Abends nicht mehr fragen',
  nudgeOff: '🔕 Okay, abends frage ich nicht mehr. Wieder einschalten: /settings',

  settingsTitle: '⚙️ <b>Einstellungen</b>',
  setLang: (v: string) => `🌐 Sprache: ${v}`,
  setTime: (v: string) => `⏰ Erinnerung: ${v} Uhr`,
  setTz: (v: string) => `🌍 Zeitzone: ${v}`,
  setIntervals: (v: string) => `🔁 Intervalle: ${v} Tage`,
  setNudge: (v: string) => `🌙 Abendfrage: ${v}`,
  setWeekly: (v: string) => `📊 Wochenrückblick: ${v}`,
  off: 'aus',
  weeklyOn: 'So., 20:00',
  btnLang: '🌐 Sprache',
  btnTime: '⏰ Uhrzeit',
  btnTz: '🌍 Zeitzone',
  btnIntervals: '🔁 Intervalle',
  btnEvening: '🌙 Abend',
  btnWeekly: (on: boolean) => `📊 Rückblick: ${on ? 'an' : 'aus'}`,
  btnSettings: '⚙️ Einstellungen',
  btnBack: '« Zurück',
  btnOther: '✏️ Andere',
  btnOwn: '✏️ Eigene',
  btnOff: '🔕 Ausschalten',
  pickLang: '🌐 Wähle die Sprache:',
  pickTime: (cur: string) => `⏰ Wann soll die Erinnerung kommen? Aktuell: ${cur} Uhr`,
  pickTz: (cur: string) => `🌍 Zeitzone. Aktuell: ${cur}`,
  pickIntervals: (cur: string) =>
    `🔁 Nach wie vielen Tagen wiederholen? Aktuell: ${cur}\nNeue Intervalle gelten für neue Einträge.`,
  pickEvening: (cur: string) =>
    `🌙 Die Abendfrage „Was hast du heute gelernt?“ kommt nur, wenn an dem Tag nichts eingetragen wurde. Aktuell: ${cur}`,
  promptTime: '✏️ Schick mir die Uhrzeit, z. B. <b>08:30</b>',
  promptTz: '✏️ Schick mir eine Stadt (<b>Tashkent</b>, <b>Berlin</b>) oder die Abweichung von UTC (<b>+5</b>, <b>-3</b>)',
  promptIntervals: '✏️ Schick mir die Intervalle in Tagen, z. B.: <b>1 3 7 14 30</b>',
  promptEvening: '✏️ Schick mir die Uhrzeit, z. B. <b>21:30</b>, oder „aus“',
  invalid: (prompt: string) => `❌ Das habe ich nicht verstanden.\n${prompt}`,
  savedSettings: '✅ Gespeichert.',
  cancelled: 'Abgebrochen.',
};

export const T: Record<Lang, Texts> = { ru, de };

/** Shown before a language is chosen. */
export const WELCOME = '👋 Привет! Я помогу вам не забывать повторять уроки немецкого.\n' +
  '👋 Hallo! Ich helfe dir, deine Deutschlektionen regelmäßig zu wiederholen.\n\n' +
  'Выберите язык · Wähle die Sprache:';

export const TZ_PRESETS: { tz: string; ru: string; de: string }[] = [
  { tz: 'Asia/Tashkent', ru: 'Ташкент', de: 'Taschkent' },
  { tz: 'Europe/Moscow', ru: 'Москва', de: 'Moskau' },
  { tz: 'Europe/Berlin', ru: 'Берлин', de: 'Berlin' },
  { tz: 'Asia/Almaty', ru: 'Алматы', de: 'Almaty' },
  { tz: 'Europe/Istanbul', ru: 'Стамбул', de: 'Istanbul' },
  { tz: 'Asia/Dubai', ru: 'Дубай', de: 'Dubai' },
];

export const TIME_PRESETS = ['07:00', '08:00', '09:00', '10:00', '12:00', '15:00', '18:00', '20:00'];
export const EVENING_PRESETS = ['19:00', '20:00', '21:00', '22:00', '23:00'];
export const INTERVAL_PRESETS: number[][] = [
  [1, 3, 7, 14, 30],
  [1, 2, 4, 7, 15, 30],
  [1, 7, 30],
  [1],
];
