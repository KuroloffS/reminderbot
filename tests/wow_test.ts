// The "wow pack": picture cards, reactions, full-screen effects, badges, colored buttons –
// and above all that none of them can make a message go missing.
// Tashkent is UTC+5: 2026-11-05T04:00:00Z is 09:00 there. 2026-11-08 is a Sunday.
import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { BADGES, badgeTitle, bar, earnedBadges, metricsOf } from '../supabase/functions/reminder-bot/lib/badges.ts';
import { cardText, statsCard, weekCard } from '../supabase/functions/reminder-bot/lib/cards.ts';
import { weekly } from '../supabase/functions/reminder-bot/lib/render.ts';
import { renderPng } from '../supabase/functions/reminder-bot/lib/raster.ts';
import { EFFECT, TgError, tgSafe, withoutExtras } from '../supabase/functions/reminder-bot/lib/telegram.ts';
import { buttons, Chat, createTestDb } from './helpers.ts';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
const ROWS = (t: TestDb, sql: string, args: unknown[] = []) => t.pool.query(sql, args).then((r: { rows: any[] }) => r.rows);

async function onboard(chat: Chat, lang: 'ru' | 'de' = 'ru', time = '0900') {
  await chat.say('/start');
  const welcome = chat.one('sendMessage');
  await chat.press(`L:${lang}:o`, chat.idOf(welcome));
  await chat.press(`T:${time}:o`, chat.idOf(welcome));
  chat.calls();
}

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

Deno.test('badges: thresholds, titles, progress bar', () => {
  assertEquals(new Set(BADGES.map((b) => b.code)).size, BADGES.length, 'codes are unique');
  assertEquals(new Set(BADGES.map((b) => b.emoji)).size, BADGES.length, 'emoji are unique');
  const m = metricsOf({ best: 7, entries_total: 12, reviews_done: 1, mastered: 0 });
  assertEquals(earnedBadges(m).map((b) => b.code), ['streak_3', 'streak_7', 'note_1', 'note_10', 'review_1']);
  assertEquals(earnedBadges(metricsOf({ best: 0, entries_total: 0, reviews_done: 0 })), []);
  const title = (code: string, lang: 'ru' | 'de') => badgeTitle(lang, BADGES.find((b) => b.code === code)!);
  assertEquals(title('streak_3', 'ru'), '3 дня подряд');
  assertEquals(title('streak_30', 'ru'), '30 дней подряд');
  assertEquals(title('streak_7', 'de'), '7 Tage in Folge');
  assertEquals(title('note_1', 'ru'), 'Первая запись');
  assertEquals(title('note_25', 'ru'), '25 тем');
  assertEquals(title('review_250', 'de'), '250 Wiederholungen');
  assertEquals(title('master_1', 'de'), 'Erstes gefestigtes Thema');
  assertEquals(title('master_5', 'ru'), '5 закреплённых тем');
  assertEquals(bar(0, 14), '▱▱▱▱▱▱▱▱▱▱');
  assertEquals(bar(9, 14), '▰▰▰▰▰▰▱▱▱▱');
  assertEquals(bar(13, 14), '▰▰▰▰▰▰▰▰▰▱', 'full only when reached');
  assertEquals(bar(14, 14), '▰▰▰▰▰▰▰▰▰▰');
  assertEquals(bar(2, 5, 5), '▰▰▱▱▱');
  assertEquals(bar(9, 5, 5), '▰▰▰▰▰');
});

Deno.test('cards: SVG content and text the font can draw', () => {
  assertEquals(cardText('Sohib 🚀🔥'), 'Sohib');
  assertEquals(cardText('Oʻzbek <tili> & Größe'), "O'zbek <tili> & Größe");
  assertEquals(cardText('Александра Сергеевна Иванова', 12), 'Александра…');
  assertEquals(cardText('Александра'.repeat(5), 12), 'АлександраА…');
  assertEquals(cardText('😀😀'), '');
  // The allowed ranges are written with literal characters; one of them starts at a no-break space
  // (U+00A0..U+017F). Should an editor ever turn it into a normal space, control characters would pass.
  assertEquals(cardText('a\u0090b'), 'ab');
  assertEquals(cardText('a\u00a0b ß ſ Ѐ ӿ'), 'a b ß ſ Ѐ ӿ');
  assertEquals(cardText('ʻ ʼ ‘ ’ ` – — … « » „ “ ”'), "' ' ' ' ' – — … « » „ “ ”");

  const svg = statsCard({
    lang: 'ru',
    name: 'A<b>&"x"',
    today: '2026-11-12',
    streak: 16,
    best: 21,
    entries: 24,
    reviewsDone: 61,
    mastered: 3,
    days: [{ d: '2026-11-12', n: 1, r: 2 }, { d: '2026-11-11', n: 1, r: 0 }, { d: '2026-10-12', n: 0, r: 1 }],
  });
  assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"'));
  assertStringIncludes(svg, 'Deutsch · A&lt;b&gt;&amp;&quot;x&quot;');
  assertStringIncludes(svg, '>16</text>');
  assertStringIncludes(svg, '>дней подряд</text>');
  assertStringIncludes(svg, '>12 нояб. 2026</text>');
  assertEquals(svg.split('fill="url(#both)"').length - 1, 1, 'one day with a new topic and a review');
  assertEquals(svg.split('fill="#FFC53D"').length - 1, 4, 'gold: one day + streak label + legend + tile accent');
  // 5 weeks, Monday first: starts 28 days before the Monday of this week (9 Nov) = 12 Oct.
  assertEquals(svg.match(/>(\d+)<\/text>/g)!.filter((x) => x === '>12</text>').length >= 2, true);

  const empty = statsCard({
    lang: 'de',
    today: '2026-11-12',
    streak: 0,
    best: 0,
    entries: 0,
    reviewsDone: 0,
    mastered: 0,
    days: [],
  });
  assertStringIncludes(empty, '>Tage in Folge</text>');
  assertStringIncludes(empty, '>Deutsch</text>');
  assert(!empty.includes('url(#flame)'), 'the flame is unlit without a streak');

  const week = weekCard({
    lang: 'de',
    name: 'Sohib',
    from: '2026-11-02',
    to: '2026-11-08',
    streak: 5,
    newTopics: 4,
    activeDays: 5,
    reviewsDone: 6,
    reviewsDue: 8,
    days: [{ d: '2026-11-02', n: 1, r: 0 }, { d: '2026-11-08', n: 1, r: 3 }],
  });
  assertStringIncludes(week, '>Wochenrückblick</text>');
  assertStringIncludes(week, '>2. Nov. – 8. Nov.</text>');
  assertStringIncludes(week, '>6/8</text>');
  assertStringIncludes(week, '>5/7</text>');
  assertStringIncludes(week, '>Serie: 5 Tage</text>');
  assertEquals(week.split('<clipPath id="wk').length - 1, 2, 'two days have a bar');
  for (const day of ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']) assertStringIncludes(week, `>${day}</text>`);
});

Deno.test('weekly text is shortened to fit a photo caption', () => {
  const entries = Array.from(
    { length: 14 },
    (_, i) => ({ studied_on: '2026-11-08', content: `Lektion ${i + 1}: ${'ä'.repeat(120)}` }),
  );
  const w = {
    from: '2026-11-02',
    to: '2026-11-08',
    entries,
    week_days: 6,
    reviews_due: 9,
    reviews_done: 7,
    current: 6,
    best: 6,
    active_days: 6,
    active_today: true,
  };
  const full = weekly('ru', w, '2026-11-08').text;
  assertStringIncludes(full, 'Lektion 10:');
  assertStringIncludes(full, '… и ещё 4');
  const caption = weekly('ru', w, '2026-11-08', 1000).text;
  assert(caption.length <= 1000, `caption has ${caption.length} characters`);
  assertStringIncludes(caption, '📚 Новых тем: 14');
  assertStringIncludes(caption, 'Lektion 1:');
  assertStringIncludes(caption, 'Так держать!');
  assert(/… и ещё \d+/.test(caption));
});

Deno.test('decorations are dropped, not the message, when Telegram rejects them', async () => {
  const styled = {
    chat_id: 1,
    text: 'x',
    message_effect_id: EFFECT.party,
    reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'a', style: 'success' }, { text: 'b', callback_data: 'b' }]] },
  };
  assertEquals(withoutExtras(styled), {
    chat_id: 1,
    text: 'x',
    reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'a' }, { text: 'b', callback_data: 'b' }]] },
  });
  assertEquals(withoutExtras({ chat_id: 1, text: 'x' }), null);

  const seen: Record<string, unknown>[] = [];
  const picky = (p: Record<string, unknown>) => {
    seen.push(p);
    if (p.message_effect_id) throw new TgError('sendMessage', 400, 'Bad Request: EFFECT_ID_INVALID');
    return Promise.resolve({ message_id: 1 });
  };
  assertEquals(await tgSafe((_m, p) => picky(p!), 'sendMessage', styled), { message_id: 1 });
  assertEquals(seen.length, 2);

  // Nothing to strip, "not modified", blocked, rate limits: the error is the caller's business.
  for (
    const [params, error] of [
      [{ chat_id: 1, text: 'x' }, new TgError('sendMessage', 400, "Bad Request: can't parse entities")],
      [styled, new TgError('editMessageText', 400, 'Bad Request: message is not modified')],
      [styled, new TgError('sendMessage', 403, 'Forbidden: bot was blocked by the user')],
      [styled, new TgError('sendMessage', 429, 'Too Many Requests')],
    ] as [Record<string, unknown>, TgError][]
  ) {
    let calls = 0;
    let thrown: unknown;
    try {
      await tgSafe(
        () => {
          calls++;
          return Promise.reject(error);
        },
        'sendMessage',
        params,
      );
    } catch (e) {
      thrown = e;
    }
    assertEquals([calls, thrown], [1, error]);
  }
});

// ---------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------

Deno.test('notes get a reaction; badges arrive with an effect, once', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -201, { now: '2026-11-04T05:00:00Z' });
    await onboard(chat);

    const noteId = await chat.say('Lektion 1: Begrüßung');
    let calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['setMessageReaction', 'sendMessage', 'sendMessage']);
    assertEquals(calls[0].params, {
      chat_id: -201,
      message_id: noteId,
      reaction: [{ type: 'emoji', emoji: '🔥' }],
      is_big: true,
    });
    assertStringIncludes(calls[1].params.text, '<blockquote>Lektion 1: Begrüßung</blockquote>\n🔁 Напомню повторить: завтра');
    assertEquals(calls[1].params.message_effect_id, undefined);
    assertEquals(calls[2].params.message_effect_id, EFFECT.party);
    assertEquals(calls[2].params.text, '🏅 <b>Новая награда!</b>\n\n🌱 <b>Первая запись</b>\n\nВсе награды: /awards');

    // An older day gets the pen, and no badge twice.
    await chat.say('вчера: Lektion 0');
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['setMessageReaction', 'sendMessage']);
    assertEquals(calls[0].params.reaction, [{ type: 'emoji', emoji: '✍' }]);

    // Third day in a row: the streak badge comes with fire.
    chat.at('2026-11-05T05:00:00Z');
    await chat.say('Lektion 2');
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['setMessageReaction', 'sendMessage', 'sendMessage']);
    assertEquals(calls[2].params.message_effect_id, EFFECT.fire);
    assertStringIncludes(calls[2].params.text, '🔥 <b>3 дня подряд</b>');
    assertEquals((await ROWS(t, 'select achievements from users where chat_id = -201'))[0].achievements, ['note_1', 'streak_3']);

    // Several at once are one message.
    await t.pool.query("update users set achievements = '{}' where chat_id = -201");
    await chat.say('/awards');
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['sendMessage', 'sendMessage']);
    assertStringIncludes(calls[0].params.text, '🏅 <b>Награды</b> · 2 из 19');
    assertStringIncludes(
      calls[0].params.text,
      '<b>Серия дней</b> · 3\n🔥 3 · 🔒 7 · 🔒 14 · 🔒 30 · 🔒 60 · 🔒 100\n▰▰▰▰▱▱▱▱▱▱ 3/7 → ⚡ 7 дней подряд',
    );
    assertStringIncludes(
      calls[0].params.text,
      '<b>Темы</b> · 3\n🌱 1 · 🔒 10 · 🔒 25 · 🔒 50 · 🔒 100\n▰▰▰▱▱▱▱▱▱▱ 3/10 → 📚 10 тем',
    );
    assertStringIncludes(
      calls[0].params.text,
      '<b>Закреплённые темы</b> · 0\n🔒 1 · 🔒 5 · 🔒 20\n▱▱▱▱▱▱▱▱▱▱ 0/1 → 🌟 Первая закреплённая тема',
    );
    assertEquals(
      calls[1].params.text,
      '🏅 <b>Новые награды: 2</b>\n\n🔥 <b>3 дня подряд</b>\n🌱 <b>Первая запись</b>\n\nВсе награды: /awards',
    );
    assertEquals(calls[1].params.message_effect_id, EFFECT.fire);
    await chat.say('/awards');
    assertEquals(chat.calls().map((c) => c.method), ['sendMessage'], 'nothing new the second time');
  } finally {
    await t.close();
  }
});

Deno.test('Telegram refusing reactions, effects or button colors never loses a message', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -202, { now: '2026-11-04T05:00:00Z' });
    await onboard(chat);
    chat.failWith = (c) => {
      if (c.method === 'setMessageReaction') return new TgError(c.method, 400, 'Bad Request: REACTION_INVALID');
      if (c.params.message_effect_id) return new TgError(c.method, 400, 'Bad Request: EFFECT_ID_INVALID');
      const styled = (c.params.reply_markup?.inline_keyboard ?? []).flat().some((b: any) => b.style);
      return styled ? new TgError(c.method, 400, 'Bad Request: BUTTON_STYLE_INVALID') : null;
    };

    await chat.say('Lektion 1');
    let calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['setMessageReaction', 'sendMessage', 'sendMessage', 'sendMessage']);
    assertStringIncludes(calls[1].params.text, '✅ Записано');
    assertEquals(calls[2].params.message_effect_id, EFFECT.party, 'first try');
    assertEquals(calls[3].params.message_effect_id, undefined, 'second try without the effect');
    assertStringIncludes(calls[3].params.text, 'Первая запись');
    assertEquals(calls[3].result.message_id > 0, true);

    // The reminder's green button is refused: it arrives with plain buttons and still works.
    chat.at('2026-11-05T04:00:00Z');
    assertEquals(await chat.tick(), { digests: 1, nudges: 0, weekly: 0, failed: 0, errors: [] });
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['sendMessage', 'sendMessage']);
    assertEquals(calls[0].params.reply_markup.inline_keyboard[0][0].style, 'success');
    assertEquals(calls[1].params.reply_markup.inline_keyboard[0].map((b: any) => b.style), [undefined, undefined]);
    assertEquals((await ROWS(t, "select status from reviews where chat_id = -202 and due_on = '2026-11-05'"))[0].status, 'sent');
    await chat.press(buttons(calls[1])[0], chat.idOf(calls[1]));
    assertEquals((await ROWS(t, "select status from reviews where chat_id = -202 and due_on = '2026-11-05'"))[0].status, 'done');
  } finally {
    await t.close();
  }
});

Deno.test('/stats and /week are picture cards; text when the picture cannot be drawn', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -203, { now: '2026-11-04T05:00:00Z', cards: true });
    await onboard(chat);

    // Nothing to show yet: no picture.
    await chat.say('/stats');
    assertEquals(chat.calls().map((c) => c.method), ['sendMessage']);
    await chat.say('/week');
    assertEquals(chat.calls().map((c) => c.method), ['sendMessage']);

    await chat.say('Lektion 1: Begrüßung 🚀');
    await t.pool.query("update users set achievements = '{note_1}' where chat_id = -203");
    chat.calls();

    await chat.say('/stats');
    let calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['sendChatAction', 'sendPhoto']);
    assertEquals(calls[0].params, { chat_id: -203, action: 'upload_photo' });
    assertEquals(calls[1].params.photo, { file: 'card.png', type: 'image/png', bytes: 12, png: true });
    assertEquals(calls[1].params.parse_mode, 'HTML');
    assertStringIncludes(calls[1].params.caption, '📊 <b>Статистика</b>');
    assertStringIncludes(calls[1].params.caption, '🔥 Серия: 1 день · рекорд: 1');
    assertStringIncludes(calls[1].params.caption, '🎓 Закреплено тем: 0');
    assertEquals(calls[1].params.reply_markup.inline_keyboard, [[{ text: '🏅 Награды 1/19', callback_data: 'A' }]]);
    assertStringIncludes(chat.drawn[0], '>Deutsch · Sohib</text>');
    assertStringIncludes(chat.drawn[0], '>4 нояб. 2026</text>');
    assertEquals(chat.drawn[0].split('fill="#FFC53D"').length - 1, 4, 'today is on the calendar (+ label, legend, tile)');

    // The button under the card opens the badges as a message of their own.
    await chat.press('A', chat.idOf(calls[1]));
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['sendMessage', 'answerCallbackQuery']);
    assertStringIncludes(calls[0].params.text, '🏅 <b>Награды</b> · 1 из 19');

    await chat.say('/week');
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['sendChatAction', 'sendPhoto']);
    assertStringIncludes(calls[1].params.caption, '📊 <b>Итоги недели</b> · 29 окт. – 4 нояб.');
    assertStringIncludes(calls[1].params.caption, '• 4 нояб. — Lektion 1: Begrüßung 🚀');
    assertStringIncludes(chat.drawn[1], '>Итоги недели</text>');
    assertEquals(chat.drawn[1].split('<clipPath id="wk').length - 1, 1);

    // The renderer breaks (CDN down, out of memory …): the same content arrives as text.
    chat.render = () => Promise.reject(new Error('wasm exploded'));
    await chat.say('/stats');
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['sendChatAction', 'sendMessage']);
    assertStringIncludes(calls[1].params.text, '🔥 Серия: 1 день · рекорд: 1');
    assertEquals(buttons(calls[1]), ['A']);

    // Telegram does not take the photo: text as well.
    chat.render = () => Promise.resolve(new Uint8Array([1, 2, 3]));
    chat.failWith = (c) => (c.method === 'sendPhoto' ? new TgError('sendPhoto', 400, 'Bad Request: IMAGE_PROCESS_FAILED') : null);
    await chat.say('/week');
    calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['sendChatAction', 'sendPhoto', 'sendMessage']);
    assertStringIncludes(calls[2].params.text, '📊 <b>Итоги недели</b>');
    chat.failWith = null;

    // The activity query fails (database not migrated): still an answer.
    await t.pool.query('alter function public.bot_activity(bigint, int, timestamptz) rename to bot_activity_gone');
    chat.render = () => Promise.resolve(new Uint8Array([1]));
    await chat.say('/stats');
    assertEquals(chat.calls().map((c) => c.method), ['sendChatAction', 'sendMessage']);
  } finally {
    await t.close();
  }
});

Deno.test('Sunday summary is a card with caption; five chats per minute', async () => {
  const t = await createTestDb();
  try {
    const chats: Chat[] = [];
    for (let i = 0; i < 7; i++) {
      const chat = new Chat(t.db, -300 - i, { now: '2026-11-06T05:00:00Z', cards: true });
      await onboard(chat);
      await chat.say(`Lektion ${i + 1}`);
      chats.push(chat);
    }
    await t.pool.query('update users set nudge_enabled = false, last_digest_on = $1 where chat_id <= -300', ['2026-11-08']);
    const main = chats[0];
    main.calls();

    main.at('2026-11-08T15:00:00Z'); // Sunday 20:00
    const first = await main.tick();
    assertEquals([first.weekly, first.failed], [5, 0]);
    const calls = main.calls();
    assertEquals(calls.map((c) => c.method), Array(5).fill('sendPhoto'));
    assertEquals(calls.map((c) => c.params.chat_id).sort((a, b) => a - b), [-306, -305, -304, -303, -302]);
    assertEquals(calls[0].params.photo.png, true);
    assertStringIncludes(calls[0].params.caption, '📊 <b>Итоги недели</b> · 2 нояб. – 8 нояб.');
    assertStringIncludes(calls[0].params.caption, '• 6 нояб. — Lektion ');
    assertStringIncludes(main.drawn[0], '>Deutsch · Sohib</text>');
    assertStringIncludes(main.drawn[0], '>2 нояб. – 8 нояб.</text>');

    main.at('2026-11-08T15:01:00Z');
    assertEquals((await main.tick()).weekly, 2);
    main.at('2026-11-08T15:02:00Z');
    assertEquals((await main.tick()).weekly, 0);

    // Without a renderer (or when it fails) the summary is the old text message.
    await t.pool.query('update users set last_weekly_on = null where chat_id = -300');
    main.render = undefined;
    main.calls();
    assertEquals((await main.tick()).weekly, 1);
    const text = main.one('sendMessage');
    assertStringIncludes(text.params.text, '📚 Новых тем: 1');
  } finally {
    await t.close();
  }
});

Deno.test('finishing the last review: mastered mark, party reaction, badges', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -204, { now: '2026-11-04T05:00:00Z' });
    await onboard(chat);
    await chat.say('/intervals 1 2');
    await chat.say('Lektion 1');
    chat.calls();

    chat.at('2026-11-05T04:00:00Z');
    await chat.tick();
    let digest = chat.one('sendMessage');
    assertStringIncludes(
      digest.params.text,
      '<i>повторение 1/2</i> ▰▱\n<blockquote>Lektion 1</blockquote>\nПовторите и отметьте ✅',
    );
    assertEquals(digest.params.reply_markup.inline_keyboard, [[
      { text: '✅ Повторено', callback_data: buttons(digest)[0], style: 'success' },
      { text: '⏰ На завтра', callback_data: buttons(digest)[1] },
    ]]);
    await chat.press(buttons(digest)[0], chat.idOf(digest));
    let calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['editMessageText', 'answerCallbackQuery', 'setMessageReaction', 'sendMessage']);
    assert(!calls[0].params.text.includes('🎓'), 'one review is still ahead');
    assertEquals(calls[2].params, {
      chat_id: -204,
      message_id: chat.idOf(digest),
      reaction: [{ type: 'emoji', emoji: '🎉' }],
      is_big: true,
    });
    assertStringIncludes(calls[3].params.text, '✅ <b>Первое повторение</b>');

    // Pressing the same button again changes nothing and celebrates nothing.
    await chat.press(buttons(digest)[0], chat.idOf(digest));
    assertEquals(chat.calls().map((c) => c.method), ['editMessageText', 'answerCallbackQuery']);

    chat.at('2026-11-06T04:00:00Z');
    await chat.tick();
    digest = chat.one('sendMessage');
    assertStringIncludes(digest.params.text, '<i>повторение 2/2</i> ▰▰');
    await chat.press(buttons(digest)[0], chat.idOf(digest));
    calls = chat.calls();
    assertStringIncludes(calls[0].params.text, '1. ✅ <s>Lektion 1</s> · 🎓 <i>тема закреплена</i>');
    assertStringIncludes(calls[0].params.text, '🔥 Серия: 3 дня подряд');
    const award = calls.find((c) => c.method === 'sendMessage')!;
    assertEquals(award.params.message_effect_id, EFFECT.fire);
    assertStringIncludes(award.params.text, '🔥 <b>3 дня подряд</b>\n🌟 <b>Первая закреплённая тема</b>');

    await chat.say('/stats');
    const stats = chat.one('sendMessage');
    assertStringIncludes(stats.params.text, '🎓 Закреплено тем: 1');
    assertEquals(stats.params.reply_markup.inline_keyboard[0][0].text, '🏅 Награды 4/19');
    await chat.say('/list');
    assertStringIncludes(chat.one('sendMessage').params.text, '▰▰ 2/2 · 🏁 план завершён · /del_');

    // Snoozing is not a celebration.
    await chat.say('Lektion 2');
    chat.calls();
    chat.at('2026-11-07T04:00:00Z');
    await chat.tick();
    digest = chat.one('sendMessage');
    assert(buttons(digest)[1].startsWith('DS:'));
    await chat.press(buttons(digest)[1], chat.idOf(digest));
    assertEquals(chat.calls().map((c) => c.method), ['editMessageText', 'answerCallbackQuery']);
  } finally {
    await t.close();
  }
});

Deno.test('command menu is refreshed once for chats from before the update; pickers and delete use colors', async () => {
  const t = await createTestDb();
  try {
    const chat = new Chat(t.db, -205, { now: '2026-11-04T05:00:00Z' });
    await onboard(chat);
    assertEquals((await ROWS(t, 'select menu_version from users where chat_id = -205'))[0].menu_version, 2);

    // A chat that chose its language before /awards existed.
    await t.pool.query('update users set menu_version = 0 where chat_id = -205');
    await chat.say('/help');
    const calls = chat.calls();
    assertEquals(calls.map((c) => c.method), ['setMyCommands', 'sendMessage']);
    assertEquals(calls[0].params.scope, { type: 'chat', chat_id: -205 });
    assertEquals(calls[0].params.commands.map((c: any) => c.command), [
      'today',
      'list',
      'stats',
      'awards',
      'week',
      'settings',
      'help',
    ]);
    assertStringIncludes(calls[1].params.text, '/awards — награды 🏅');
    await chat.say('/help');
    assertEquals(chat.calls().map((c) => c.method), ['sendMessage']);

    await chat.say('/time');
    const picker = chat.one('sendMessage');
    const current = picker.params.reply_markup.inline_keyboard.flat().filter((b: any) => b.style);
    assertEquals(current, [{ text: '• 09:00 •', callback_data: 'T:0900:s', style: 'primary' }]);

    const note = await chat.say('Lektion 1');
    const saved = chat.one('sendMessage');
    await chat.press(`X:${note}:1`, chat.idOf(saved));
    assertEquals(chat.one('editMessageReplyMarkup').params.reply_markup.inline_keyboard[0][0].style, 'danger');
  } finally {
    await t.close();
  }
});

Deno.test({
  name: 'the real renderer draws a PNG (needs CARD_ASSETS_BASE or network)',
  ignore: !Deno.env.get('CARD_ASSETS_BASE'),
  fn: async () => {
    const svg = statsCard({
      lang: 'ru',
      name: 'Sohib',
      today: '2026-11-12',
      streak: 9,
      best: 9,
      entries: 12,
      reviewsDone: 30,
      mastered: 1,
      days: [{ d: '2026-11-12', n: 1, r: 1 }],
    });
    const png = await renderPng(svg);
    assertEquals([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR: width and height, big-endian, right after the signature and chunk header.
    const view = new DataView(png.buffer, png.byteOffset);
    assertEquals([view.getUint32(16), view.getUint32(20)], [1080, 1080]);
    assert(png.length > 50_000, `suspiciously small: ${png.length} bytes`);
  },
});
