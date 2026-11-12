// End-to-end conversations: real SQL (local Postgres), real bot code, fake Telegram, fake clock.
// Tashkent is UTC+5: 2026-11-05T04:00:00Z is 09:00 there. 2026-11-04 is a Wednesday.
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { TgError } from '../supabase/functions/reminder-bot/lib/telegram.ts';
import { buttons, Chat, createTestDb } from './helpers.ts';

async function onboard(chat: Chat, lang: 'ru' | 'de' = 'ru', time = '0900') {
  await chat.say('/start');
  const welcome = chat.one('sendMessage');
  await chat.press(`L:${lang}:o`, chat.idOf(welcome));
  await chat.press(`T:${time}:o`, chat.idOf(welcome));
  chat.calls();
}

const ROWS = (t: Awaited<ReturnType<typeof createTestDb>>, sql: string, args: unknown[] = []) =>
  t.pool.query(sql, args).then((r: { rows: any[] }) => r.rows);

Deno.test('onboarding, first note, next-day reminder, done', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -101, { now: '2026-11-04T05:00:00Z' }); // 10:00 in Tashkent
    await chat.say('/start');
    let c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, 'Выберите язык');
    assertEquals(buttons(c), ['L:ru:o', 'L:de:o']);
    const welcomeId = chat.idOf(c);

    await chat.press('L:ru:o', welcomeId);
    const calls = chat.calls();
    assert(calls.some((x) => x.method === 'setMyCommands' && x.params.scope?.chat_id === -101));
    assert(calls.some((x) => x.method === 'answerCallbackQuery'));
    const picker = calls.find((x) => x.method === 'editMessageText')!;
    assertStringIncludes(picker.params.text, 'Во сколько присылать');
    assertStringIncludes(picker.params.text, 'Ташкент (UTC+5)');
    assert(buttons(picker).includes('T:0900:o'));

    await chat.press('T:0800:o', welcomeId);
    c = chat.one('editMessageText');
    assertStringIncludes(c.params.text, 'каждый день в 08:00');
    assertStringIncludes(c.params.text, 'через 1, 3, 7, 14 и 30 дней');

    // Logged at 10:00, after today's 08:00 reminder time.
    const noteId = await chat.say('4 noyabr. 1- leksion lugati. Sifatlarni skloneniyasi ni organdim.');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '✅ Записано · 📅 сегодня, 4 нояб.');
    assertStringIncludes(c.params.text, '<blockquote>1- leksion lugati. Sifatlarni skloneniyasi ni organdim.</blockquote>');
    assertStringIncludes(c.params.text, 'Напомню повторить: завтра, 7 нояб., 11 нояб., 18 нояб., 4 дек.');
    assertEquals(buttons(c), [`X:${noteId}:1`]);
    assertEquals(c.params.reply_parameters.message_id, noteId);
    const [entry] = await ROWS(t, 'select studied_on::text, reply_message_id from entries where chat_id = -101');
    assertEquals(entry, { studied_on: '2026-11-04', reply_message_id: String(chat.idOf(c)) });

    assertEquals((await chat.tick()).digests, 0);
    chat.at('2026-11-05T02:59:00Z'); // 07:59
    assertEquals((await chat.tick()).digests, 0);
    chat.at('2026-11-05T03:00:00Z'); // 08:00
    assertEquals((await chat.tick()).digests, 1);
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '🔁 <b>Пора повторить!</b>');
    assertStringIncludes(c.params.text, '📅 4 нояб. · <i>повторение 1/5</i>');
    assertStringIncludes(c.params.text, '1- leksion lugati');
    const [doneAll, snooze] = buttons(c);
    assert(doneAll.startsWith('DA:') && snooze.startsWith('DS:'));
    assertEquals((await chat.tick()).digests, 0, 'only once a day');

    await chat.press(doneAll, chat.idOf(c));
    const after = chat.calls();
    const edited = after.find((x) => x.method === 'editMessageText')!;
    assertStringIncludes(edited.params.text, '🎉 <b>Отлично, всё повторено!</b>');
    assertStringIncludes(edited.params.text, '🔥 Серия: 2 дня подряд');
    assertEquals(edited.params.reply_markup, undefined);
    assertEquals(after.find((x) => x.method === 'answerCallbackQuery')!.params.text, '✅ Отмечено');

    await chat.say('/stats');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '🔥 Серия: 2 дня · рекорд: 2');
    assertStringIncludes(c.params.text, '✅ Повторений сделано: 1');
    assertStringIncludes(c.params.text, '🗓 Следующее повторение: 7 нояб.');

    await chat.say('/today');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, 'Сегодня повторять нечего');
    assertStringIncludes(c.params.text, 'Следующее повторение: 7 нояб.');
  } finally {
    await t.close();
  }
});

Deno.test('pasted log: several notes, per-item buttons, snooze, weekly summary, evening question', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -102, { now: '2026-11-07T03:00:00Z' }); // Sat 08:00, before the 09:00 reminder
    await onboard(chat);
    const src = await chat.say(
      '4 noyabr. 1- leksion lugati. Sifatlarni skloneniyasi ni organdim.\n' +
        '5- noyabr. 2 -leksion lugati. 1-2leksion grammatikasi\n' +
        '6-noyabr. 3 leksion lugati, 1 ta email yozdim',
    );
    let c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '✅ Записано: 3');
    assertStringIncludes(c.params.text, '📅 <b>4 нояб.</b> — 1- leksion lugati.');
    assertStringIncludes(c.params.text, '🔁 сегодня, 11 нояб., 18 нояб., 4 дек.');
    assertStringIncludes(c.params.text, '🔁 сегодня, завтра, 12 нояб., 19 нояб., 5 дек.');
    assertStringIncludes(c.params.text, '🔁 сегодня, 9 нояб., 13 нояб., 20 нояб., 6 дек.');
    assertEquals(buttons(c), [`X:${src}:3`]);

    chat.at('2026-11-07T04:00:00Z'); // 09:00
    assertEquals((await chat.tick()).digests, 1);
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, 'Тем на сегодня: 3');
    assertStringIncludes(c.params.text, 'повторение 1/4');
    const keys = buttons(c);
    assertEquals(keys.length, 5);
    const digestMsg = chat.idOf(c);

    await chat.press(keys[0], digestMsg);
    c = chat.one('editMessageText');
    assertStringIncludes(c.params.text, '1. ✅ <s>1- leksion lugati.');
    assertEquals(buttons(c), [keys[1], keys[2], keys[3], keys[4]]);

    await chat.press(keys[4], digestMsg); // snooze the rest
    const snoozed = chat.calls();
    c = snoozed.find((x) => x.method === 'editMessageText')!;
    assertStringIncludes(c.params.text, '👍 <b>Готово!</b>');
    assertEquals(c.params.text.split('перенесено на завтра').length - 1, 2);
    assertEquals(c.params.reply_markup, undefined);
    assertEquals(snoozed.find((x) => x.method === 'answerCallbackQuery')!.params.text, '⏰ Напомню завтра');

    // Sunday 09:00: the two snoozed reviews + the one due today.
    chat.at('2026-11-08T04:00:00Z');
    assertEquals((await chat.tick()).digests, 1);
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, 'Тем на сегодня: 3');

    // Sunday 20:00: weekly summary. 21:00: evening question (nothing logged for Sunday).
    chat.at('2026-11-08T15:00:00Z');
    const weekly = await chat.tick();
    assertEquals([weekly.digests, weekly.weekly, weekly.nudges], [0, 1, 0]);
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '📊 <b>Итоги недели</b> · 2 нояб. – 8 нояб.');
    assertStringIncludes(c.params.text, '📚 Новых тем: 3');
    assertStringIncludes(c.params.text, '📆 Дней с занятиями: 4 из 7');
    assertStringIncludes(c.params.text, '✅ Повторено: 1 из 4');
    assertStringIncludes(c.params.text, '• 6 нояб. — 3 leksion lugati');

    chat.at('2026-11-08T16:00:00Z');
    assertEquals((await chat.tick()).nudges, 1);
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, 'Что сегодня изучили');
    assertEquals(buttons(c), ['N:off']);
    chat.at('2026-11-08T16:30:00Z');
    assertEquals((await chat.tick()).nudges, 0, 'once per evening');

    await chat.press('N:off', chat.idOf(c));
    c = chat.one('editMessageText');
    assertStringIncludes(c.params.text, 'вечером больше не спрашиваю');
    chat.at('2026-11-09T16:00:00Z');
    assertEquals((await chat.tick()).nudges, 0);
  } finally {
    await t.close();
  }
});

Deno.test('evening question is skipped when something was logged that day', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -103, { now: '2026-11-04T04:00:00Z' });
    await onboard(chat);
    chat.at('2026-11-04T15:00:00Z');
    await chat.say('Lektion 3: Perfekt mit haben');
    chat.calls();
    chat.at('2026-11-04T16:00:00Z'); // 21:00
    assertEquals((await chat.tick()).nudges, 0);
    chat.at('2026-11-05T16:00:00Z');
    assertEquals((await chat.tick()).nudges, 1);
  } finally {
    await t.close();
  }
});

Deno.test('settings: presets, typed values, language switch', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -104, { now: '2026-11-04T05:00:00Z' });
    await onboard(chat);
    await chat.say('/settings');
    let c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '⏰ Напоминание: 09:00');
    assertStringIncludes(c.params.text, '🌍 Часовой пояс: Ташкент (UTC+5)');
    assertStringIncludes(c.params.text, '🔁 Интервалы: 1, 3, 7, 14, 30 дн.');
    assertStringIncludes(c.params.text, '🌙 Вечерний вопрос: 21:00');
    const settingsMsg = chat.idOf(c);

    await chat.press('S:time', settingsMsg);
    c = chat.one('editMessageText');
    assert(buttons(c).includes('T:x:s'));
    await chat.press('T:x:s', settingsMsg);
    c = chat.one('editMessageText');
    assertStringIncludes(c.params.text, 'Отправьте время');
    await chat.say('7:30');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '✅ Сохранено.');
    assertStringIncludes(c.params.text, '⏰ Напоминание: 07:30');

    // A note is not swallowed by settings any more.
    await chat.say('Lektion 1');
    assertStringIncludes(chat.one('sendMessage').params.text, '✅ Записано');

    await chat.say('/tz Atlantis');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '❌ Не получилось разобрать.');
    await chat.say('Berlin');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '🌍 Часовой пояс: Берлин (UTC+1)');
    await chat.say('/tz +3');
    assertStringIncludes(chat.one('sendMessage').params.text, '🌍 Часовой пояс: UTC+3');
    await chat.say('/tz new york');
    assertStringIncludes(chat.one('sendMessage').params.text, 'America/New York (UTC−5)');

    await chat.say('/intervals 2 1 5');
    assertStringIncludes(chat.one('sendMessage').params.text, '🔁 Интервалы: 1, 2, 5 дн.');
    await chat.say('/evening off');
    assertStringIncludes(chat.one('sendMessage').params.text, '🌙 Вечерний вопрос: выкл');

    await chat.press('E:2200', settingsMsg);
    assertStringIncludes(chat.one('editMessageText').params.text, '🌙 Вечерний вопрос: 22:00');
    await chat.press('W:off', settingsMsg);
    assertStringIncludes(chat.one('editMessageText').params.text, '📊 Итоги недели: выкл');
    await chat.press('I:0', settingsMsg);
    assertStringIncludes(chat.one('editMessageText').params.text, '🔁 Интервалы: 1, 3, 7, 14, 30 дн.');

    await chat.press('L:de:s', settingsMsg);
    const calls = chat.calls();
    c = calls.find((x) => x.method === 'editMessageText')!;
    assertStringIncludes(c.params.text, '⚙️ <b>Einstellungen</b>');
    assertStringIncludes(c.params.text, '⏰ Erinnerung: 07:30 Uhr');
    assertStringIncludes(c.params.text, '📊 Wochenrückblick: aus');
    const commands = calls.find((x) => x.method === 'setMyCommands')!;
    assertEquals(commands.params.commands[0], { command: 'today', description: 'Heute wiederholen' });

    // Cancel typing returns to the settings.
    await chat.press('S:int', settingsMsg);
    chat.calls();
    await chat.press('I:x', settingsMsg);
    assertStringIncludes(chat.one('editMessageText').params.text, 'Schick mir die Intervalle');
    await chat.press('C:s', settingsMsg);
    assertStringIncludes(chat.one('editMessageText').params.text, 'Einstellungen');
    const [user] = await ROWS(t, 'select pending, lang, timezone, nudge_enabled from users where chat_id = -104');
    assertEquals(user, { pending: null, lang: 'de', timezone: 'America/New_York', nudge_enabled: true });
  } finally {
    await t.close();
  }
});

Deno.test('German reminders and texts', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -105, { now: '2026-11-04T05:00:00Z', lang: 'de' });
    await chat.say('/start');
    const welcome = chat.one('sendMessage');
    await chat.press('L:de:o', chat.idOf(welcome));
    assertStringIncludes(chat.calls().find((x) => x.method === 'editMessageText')!.params.text, 'Um wie viel Uhr');
    await chat.press('T:0700:o', chat.idOf(welcome));
    assertStringIncludes(chat.one('editMessageText').params.text, 'nach 1, 3, 7, 14 und 30 Tagen ans Wiederholen – um 07:00 Uhr');

    await chat.say('gestern: Lektion 2, Dativ');
    const c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '✅ Gespeichert · 📅 gestern, 3. Nov.');
    assertStringIncludes(c.params.text, '<blockquote>Lektion 2, Dativ</blockquote>');
    // Yesterday's lesson logged after today's 07:00 reminder: first review tomorrow.
    assertStringIncludes(c.params.text, 'Ich erinnere dich: morgen, 6. Nov., 10. Nov., 17. Nov., 3. Dez.');

    chat.at('2026-11-05T02:00:00Z');
    await chat.tick();
    const d = chat.one('sendMessage');
    assertStringIncludes(d.params.text, '🔁 <b>Zeit zum Wiederholen!</b>');
    assertStringIncludes(d.params.text, 'Wiederholung 1/5');
    assertEquals(d.params.reply_markup.inline_keyboard[0].map((b: any) => b.text), ['✅ Wiederholt', '⏰ Auf morgen']);
  } finally {
    await t.close();
  }
});

Deno.test('delete, list, edit, duplicates and odd input', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -106, { now: '2026-11-04T05:00:00Z' });
    await onboard(chat);

    // Delete from the confirmation message (ask first).
    const first = await chat.say('Lektion 1: Begrüßung');
    let c = chat.one('sendMessage');
    const confirmation = chat.idOf(c);
    await chat.press(`X:${first}:1`, confirmation);
    c = chat.one('editMessageReplyMarkup');
    assertEquals(buttons(c), [`XY:${first}`, `XN:${first}:1`]);
    await chat.press(`XN:${first}:1`, confirmation);
    assertEquals(buttons(chat.one('editMessageReplyMarkup')), [`X:${first}:1`]);
    await chat.press(`XY:${first}`, confirmation);
    assertStringIncludes(chat.one('editMessageText').params.text, 'Удалено');
    assertEquals((await ROWS(t, 'select count(*)::int as n from reviews where chat_id = -106'))[0].n, 0);

    // The same Telegram update delivered twice creates one note.
    await chat.say('Lektion 2: Zahlen', { messageId: 777 });
    await chat.say('Lektion 2: Zahlen', { messageId: 777 });
    assertEquals(chat.calls().filter((x) => x.method === 'sendMessage').length, 1);

    // Editing the note before any reminder re-reads it.
    const sentAt = chat.now;
    chat.at('2026-11-04T05:10:00Z');
    await chat.edit(777, '3 noyabr: Lektion 2: Zahlen bis 100', sentAt);
    c = chat.one('editMessageText');
    assertStringIncludes(c.params.text, '✏️ Изменено');
    assertStringIncludes(c.params.text, '📅 вчера, 3 нояб.');
    assertStringIncludes(c.params.text, 'Zahlen bis 100');
    const rows = await ROWS(t, 'select studied_on::text, content from entries where chat_id = -106');
    assertEquals(rows, [{ studied_on: '2026-11-03', content: 'Lektion 2: Zahlen bis 100' }]);

    // After the reminder went out only the text changes.
    chat.at('2026-11-05T04:00:00Z');
    await chat.tick();
    chat.calls();
    await chat.edit(777, '3 noyabr: Lektion 2: Zahlen bis 1000', sentAt);
    assertStringIncludes(chat.one('sendMessage').params.text, 'Текст записи обновлён');
    assertEquals((await ROWS(t, 'select content from entries where chat_id = -106'))[0].content, 'Lektion 2: Zahlen bis 1000');

    await chat.say('/list');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '📚 <b>Ваши записи</b>');
    assertStringIncludes(c.params.text, '📅 <b>3 нояб.</b> — Lektion 2: Zahlen bis 1000');
    const id = c.params.text.match(/\/del_(\d+)/)![1];
    await chat.say(`/del_${id}`);
    c = chat.one('sendMessage');
    assertEquals(buttons(c), [`RY:${id}`, `RN:${id}`]);
    await chat.press(`RY:${id}`, chat.idOf(c));
    assertStringIncludes(chat.one('editMessageText').params.text, 'Удалено');
    await chat.say('/list');
    assertStringIncludes(chat.one('sendMessage').params.text, 'Пока нет записей');
    await chat.say('/del_99999');
    assertStringIncludes(chat.one('sendMessage').params.text, 'не найдена');

    // Pressing a button of a deleted reminder (its message is gone too).
    chat.failWith = (
      x,
    ) => (x.method.startsWith('edit') ? new TgError(x.method, 400, 'Bad Request: message to edit not found') : null);
    await chat.press('DA:424242', 5);
    const gone = chat.calls();
    assertEquals(gone.find((x) => x.method === 'answerCallbackQuery')!.params.text, 'Это напоминание устарело.');
    // A settings button on a message that can no longer be edited: the page comes as a new message.
    await chat.press('S:main', 5);
    assertStringIncludes(chat.one('sendMessage').params.text, '⚙️ <b>Настройки</b>');
    chat.failWith = null;

    await chat.say('4 noyabr');
    assertStringIncludes(chat.one('sendMessage').params.text, 'Напишите, что именно вы изучили');
    await chat.raw({
      message: {
        message_id: 900,
        date: 0,
        chat: { id: -106, type: 'private' },
        from: { id: -106, first_name: 'S' },
        sticker: {},
      },
    });
    assertStringIncludes(chat.one('sendMessage').params.text, 'только текст');
    await chat.say('/foo');
    assertStringIncludes(chat.one('sendMessage').params.text, 'Не знаю такой команды');
    await chat.raw({
      message: { message_id: 901, date: 0, chat: { id: -999, type: 'group' }, from: { id: -106, first_name: 'S' }, text: 'hi' },
    });
    assertEquals(chat.calls().length, 0, 'groups are ignored');
  } finally {
    await t.close();
  }
});

Deno.test('forwarded old note, note before onboarding, /today, /week', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -107, { now: '2026-11-04T03:30:00Z' }); // 08:30, before the 09:00 reminder
    // Never pressed /start: the first note still works and switches reminders on.
    await chat.say('Lektion 4: Modalverben');
    let c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '⏰ Напоминания приходят в 09:00');
    assertEquals((await ROWS(t, 'select onboarded from users where chat_id = -107'))[0].onboarded, true);

    // A note forwarded from last year (the message date decides the year).
    const lastYear = Date.UTC(2025, 10, 5, 9, 29) / 1000;
    await chat.say('5- noyabr. 2 -leksion lugati. 1-2leksion grammatikasi', { forwardDate: lastYear });
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '📅 5 нояб. 2025');
    assertStringIncludes(c.params.text, 'Сохранено в истории');

    // Yesterday's lesson before 09:00: due today; /today sends it right away and 09:00 sends nothing more.
    await chat.say('вчера: Lektion 3');
    chat.calls();
    await chat.say('/today');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, 'Lektion 3');
    chat.at('2026-11-04T04:00:00Z');
    assertEquals((await chat.tick()).digests, 0);

    await chat.say('/week');
    c = chat.one('sendMessage');
    assertStringIncludes(c.params.text, '📚 Новых тем: 2');
    assertStringIncludes(c.params.text, '• 3 нояб. — Lektion 3');
    assertStringIncludes(c.params.text, '• 4 нояб. — Lektion 4: Modalverben');
  } finally {
    await t.close();
  }
});

Deno.test('Telegram errors: blocked users are skipped, temporary errors retried', async () => {
  const t = await createTestDb();
  try {
    const blocked = new Chat(t.db, -108, { now: '2026-11-04T05:00:00Z' });
    await onboard(blocked);
    await blocked.say('Lektion 1');
    const flaky = new Chat(t.db, -109, { now: '2026-11-04T05:00:00Z' });
    await onboard(flaky);
    await flaky.say('Lektion 1');

    // One tick serves every (test) chat; here it goes through `blocked`'s fake Telegram.
    blocked.failWith = (c) =>
      c.method === 'sendMessage' && c.params.chat_id === -108
        ? new TgError('sendMessage', 403, 'Forbidden: bot was blocked by the user')
        : null;
    blocked.at('2026-11-05T04:00:00Z');
    const r1 = await blocked.tick();
    assertEquals([r1.digests, r1.failed], [1, 1]);
    assertEquals((await ROWS(t, 'select is_active from users where chat_id = -108'))[0].is_active, false);

    // A rate limit: the reminder is dropped and tried again on the next tick.
    flaky.failWith = (c) => (c.method === 'sendMessage' ? new TgError('sendMessage', 429, 'Too Many Requests', 5) : null);
    await t.pool.query("update reviews set status = 'pending', due_on = '2026-11-06' where chat_id = -109");
    flaky.at('2026-11-06T04:00:00Z');
    const r2 = await flaky.tick();
    assertEquals([r2.digests, r2.failed], [0, 1]);
    assertEquals((await ROWS(t, 'select count(*)::int as n from digests where chat_id = -109 and message_id is null'))[0].n, 0);
    flaky.failWith = null;
    flaky.at('2026-11-06T04:01:00Z');
    assertEquals((await flaky.tick()).digests, 1, 'retried a minute later');

    // Writing again re-activates a user who had blocked the bot.
    blocked.failWith = null;
    await blocked.say('/start');
    assertEquals((await ROWS(t, 'select is_active from users where chat_id = -108'))[0].is_active, true);
  } finally {
    await t.close();
  }
});
