# German Lesson Reminder 🇩🇪

A Telegram bot that reminds you to repeat what you learned in your German course, using spaced
repetition: **1, 3, 7, 14 and 30 days** after each lesson. It runs entirely on Supabase
(Edge Function + Postgres + pg_cron), so there is no server to keep running.

Interface languages: **Russian** and **German** (switch any time in `/settings`).

## How you use it

1. After a lesson, write to the bot what you studied, for example
   `4 noyabr. 1- leksion lugati. Sifatlarni skloneniyasini o'rgandim.`
   - The date at the start is optional (default: today). It understands Uzbek, Russian, German and
     English month names (`4 noyabr`, `3 ноября`, `3. November`), `04.11`, `4.11.2025`, `вчера:`,
     `gestern:`, `kecha:`.
   - Paste your whole old log at once: every line that starts with a date becomes its own entry.
     Forwarded old messages are dated by when they were written.
   - Edited your message? The bot updates the entry.
2. The bot answers with the plan: `завтра, 7 нояб., 11 нояб., 18 нояб., 4 дек.`
3. On each of those days, at your reminder time (default **09:00 Tashkent**), you get one message
   with everything to repeat, with buttons ✅ (done), ✅ all, ⏰ tomorrow.
4. At **21:00**, if nothing was logged that day, the bot asks what you studied (can be switched off).
5. On **Sunday at 20:00** you get a weekly summary as a picture (a chart of your week).

And a few things that make it fun:

- **Picture cards.** `/stats` answers with an image: your streak 🔥, a 5-week activity calendar and
  your totals. The Sunday summary and `/week` are images too.
- **Badges.** 19 of them, for streaks (3, 7, 14, 30, 60, 100 days), topics, reviews and mastered
  topics (a topic is mastered when its last review is done). `/awards` shows them with the progress
  to the next one. A new badge arrives with Telegram's full-screen confetti or fire animation.
- **Reactions.** The bot reacts 🔥 to a note about today (✍ for older days), and 🎉 when you finish
  all reviews of a reminder.
- **Colors.** The main buttons are green, delete is red, the current setting is blue (in Telegram
  apps from 2026 on; older apps show normal buttons).

| Command | What it does |
| --- | --- |
| `/today` | What to repeat today |
| `/list` | Your latest entries (`/del_<id>` deletes one) |
| `/stats` | Progress card: streak, activity calendar, totals |
| `/awards` | Your badges and the way to the next ones |
| `/week` | The last 7 days as a chart |
| `/settings` | Language, reminder time, time zone, intervals, evening question, weekly summary |
| `/time 8:30` · `/tz Berlin` · `/tz +5` · `/intervals 1 3 7` · `/evening off` | Shortcuts for settings |
| `/help` | How it works |

## Setup (one time)

Everything is already deployed to the Supabase project **German Lesson Reminder**
(`qfvbheevwgvaxhsshdwy`, Frankfurt). The only thing missing is the bot token:

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a
   username, and copy the token it gives you (looks like `123456789:AA…`).
2. Add it as an Edge Function secret named **`BOT_TOKEN`**:
   [Dashboard → Edge Functions → Secrets](https://supabase.com/dashboard/project/qfvbheevwgvaxhsshdwy/functions/secrets).
3. Wait up to a minute. The bot connects itself to Telegram (webhook, command menu, description).
   Open your bot and press **Start**.

To check that it is connected, run this in the
[SQL editor](https://supabase.com/dashboard/project/qfvbheevwgvaxhsshdwy/sql/new):

```sql
select key, value, updated_at from app_state where key in ('webhook', 'tick_status');
```

`tick_status.configured = true` and a `webhook` row with your bot's `@username` mean it is live.
To use another bot later, just replace the `BOT_TOKEN` secret: the next tick re-connects everything.

## How it works

```
Telegram ──webhook──▶ Edge Function reminder-bot ──RPC──▶ Postgres (bot_* SQL functions)
                            ▲
pg_cron (every minute) ─────┘  ?action=tick → morning reminders, evening question, weekly summary
```

- `supabase/migrations/…_reminder_bot.sql`: tables (`users`, `entries`, `reviews`, `digests`,
  `app_state`) and all data logic as `bot_*` SQL functions. RLS is on and nothing is granted to
  `anon`/`authenticated`; only the Edge Function (service role) can read or write.
- `supabase/migrations/…_reminder_bot_cron.sql`: the every-minute pg_cron job. It calls the function
  with a random secret stored in `app_state` (created by the migration).
- `supabase/functions/reminder-bot/`: the bot (Deno, no Telegram library, plain Bot API calls).
  Telegram requests are checked with a webhook secret derived from `BOT_TOKEN`.
  - `lib/parse.ts`: reading notes and dates, `lib/schedule.ts`: the review plan,
    `lib/bot.ts`: commands and buttons, `lib/tick.ts`: scheduled messages,
    `lib/render.ts` + `lib/i18n.ts`: all texts (Russian/German), `lib/badges.ts`: the badges.
  - `lib/cards.ts` draws the picture cards as SVG and `lib/raster.ts` turns them into PNG with
    [resvg](https://github.com/yisibl/resvg-js) (WebAssembly). The renderer and the Onest font are
    downloaded from the npm CDN the first time a worker draws a card and checked against fixed
    SHA-256 sums.
- `supabase/migrations/…_wow_pack.sql`: activity per day (for the calendar), badge storage,
  mastered topics.

Nothing decorative can lose a message: if a picture cannot be drawn, the same content is sent as
text; if Telegram rejects an effect or a button color, the message is sent again without it;
a failed reaction is ignored (`tgSafe` in `lib/telegram.ts`, `sendCard` in `lib/send.ts`).

Each reminder is sent once on its day. Reviews you do not mark ✅ are not repeated; the next
interval still comes. ⏰ moves the rest of a reminder to tomorrow. New intervals apply to new entries.

## Development

```bash
scripts/local-db.sh start   # throwaway local Postgres on port 54329
deno task test              # unit tests + full conversations with a fake Telegram
deno task check             # type-check the Edge Function
deno task cards out/        # draw sample cards (and the avatar) as PNG files to look at
```

When the command list changes, bump `MENU_VERSION` (`lib/i18n.ts`) and `SETUP_VERSION`
(`lib/setup.ts`), so Telegram gets the new menu. Badge codes are stored in the database: add new
badges freely, but never rename existing codes.

`assets/bot-avatar.svg` is a matching profile picture; `deno task cards` renders it to PNG, and
@BotFather's `/setuserpic` sets it.

Deploy changes with the Supabase CLI:

```bash
supabase functions deploy reminder-bot --project-ref qfvbheevwgvaxhsshdwy
```

Self-test on the live project without Telegram (test chats have negative ids, `cleanup` removes them):

```sql
select net.http_post(
  url := 'https://qfvbheevwgvaxhsshdwy.supabase.co/functions/v1/reminder-bot?action=simulate',
  headers := jsonb_build_object('Content-Type', 'application/json',
                                'x-cron-secret', (select value ->> 'secret' from app_state where key = 'cron')),
  body := '{"cleanup": true, "steps": [{"update": {"update_id": 1, "message": {"message_id": 1, "date": 0,
            "chat": {"id": -1, "type": "private"}, "from": {"id": -1, "first_name": "Test"},
            "text": "Lektion 1"}}}]}'::jsonb);
-- then: select content::jsonb from net._http_response order by id desc limit 1;
```

Picture cards are really drawn in a simulation; add `"files": true` to get them back as base64.

## Does it run 24/7?

Yes. It runs on Supabase's servers, not on your phone or computer, so nothing needs to stay open.

- **Free plan pausing:** Supabase pauses free projects that have little database activity for a
  week. The bot talks to its database every minute, far more than the "few requests a day" that
  keeps a project awake. If Supabase ever plans a pause anyway, it emails the owner about a week
  before; opening the project in the dashboard is enough to keep it running. A paused project can be
  restored with one click (data is kept for 90 days). Only the paid Pro plan rules out pausing.
- **Limits:** the every-minute job uses about 43,000 of the 500,000 free Edge Function calls per
  month, and the data takes a few MB of the 500 MB database. A daily job
  (`…_reminder_bot_cron_cleanup.sql`) keeps the pg_cron history at one week, so it never fills up.
- **Outages:** if Supabase or Telegram is down at reminder time, the reminder is sent as soon as
  they are back (on the next minute), not lost.
- **Token:** if you revoke or regenerate the token in @BotFather, put the new one into the
  `BOT_TOKEN` secret; the bot reconnects within a minute.
