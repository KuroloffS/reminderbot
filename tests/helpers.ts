// Test helpers: a fresh Postgres database with the real migrations, a node-postgres transport for
// the bot_* functions, a fake Telegram and builders for Telegram updates.
//
// Needs a local Postgres (scripts/local-db.sh start). Override with TEST_DATABASE_URL.
import pg from 'pg';
import { type Call, createDb, type Db, DbError } from '../supabase/functions/reminder-bot/lib/db.ts';
import { handleUpdate } from '../supabase/functions/reminder-bot/lib/bot.ts';
import { runTick } from '../supabase/functions/reminder-bot/lib/tick.ts';
import { createFakeTg, type FakeCall, type TgError } from '../supabase/functions/reminder-bot/lib/telegram.ts';

const ADMIN_URL = Deno.env.get('TEST_DATABASE_URL') ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url);

/** Every migration in order, except the pg_cron ones (they need extensions a plain Postgres lacks). */
async function migrations(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith('.sql') && !entry.name.includes('_cron')) names.push(entry.name);
  }
  return Promise.all(names.sort().map((name) => Deno.readTextFile(new URL(name, MIGRATIONS_DIR))));
}

/** Calls public.<fn>(name => $1::type, …) with each argument cast to the declared parameter type. */
export function pgCall(pool: pg.Pool): Call {
  const signatures = new Map<string, Map<string, string>>();
  return async (fn, args) => {
    let sig = signatures.get(fn);
    if (!sig) {
      const { rows } = await pool.query(
        `select unnest(proargnames) as name, unnest(proargtypes::regtype[]::text[]) as type
         from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`,
        [fn],
      );
      if (!rows.length && fn !== 'bot_test_cleanup') throw new Error(`unknown function ${fn}`);
      sig = new Map(rows.map((r: any) => [r.name, r.type]));
      signatures.set(fn, sig);
    }
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    const params = keys.map((k) => {
      const v = args[k];
      if (v === null) return null;
      return sig!.get(k) === 'jsonb' ? JSON.stringify(v) : v;
    });
    const list = keys.map((k, i) => {
      if (!sig!.has(k)) throw new Error(`${fn} has no parameter ${k}`);
      return `${k} => $${i + 1}::${sig!.get(k)}`;
    });
    try {
      const { rows } = await pool.query(`select public.${fn}(${list.join(', ')}) as r`, params);
      return rows[0].r;
    } catch (e: any) {
      throw new DbError(`${fn}: ${e.message}`, e.code);
    }
  };
}

export type TestDb = { db: Db; call: Call; pool: pg.Pool; close: () => Promise<void> };

export async function createTestDb(): Promise<TestDb> {
  const name = `rb_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  for (const sql of await migrations()) await pool.query(sql);
  const call = pgCall(pool);
  return {
    db: createDb(call),
    call,
    pool,
    close: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`drop database if exists ${name}`);
      await c.end();
    },
  };
}

let nextUpdateId = 1;
let nextMessageId = 100;

const AMBIENT = new Set(['answerCallbackQuery', 'setMyCommands', 'setMessageReaction', 'sendChatAction']);

/** Starts like a PNG file; enough for the fake Telegram to recognise a picture. */
export const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

export type From = { id: number; first_name?: string; language_code?: string };

/** One simulated user talking to the bot, with a controllable clock. */
export class Chat {
  readonly fake: ReturnType<typeof createFakeTg>;
  readonly db: Db;
  readonly chatId: number;
  readonly lang: string;
  now: Date;
  private seen = 0;
  failWith: ((call: FakeCall) => TgError | null) | null = null;
  /** Picture cards: undefined = no renderer (text only), otherwise a stand-in for lib/raster.ts. */
  render: ((svg: string) => Promise<Uint8Array>) | undefined;
  /** The SVGs handed to the renderer. */
  readonly drawn: string[] = [];

  constructor(db: Db, chatId: number, opts: { lang?: string; now?: string; cards?: boolean } = {}) {
    this.db = db;
    this.chatId = chatId;
    this.lang = opts.lang ?? 'ru';
    this.now = new Date(opts.now ?? '2026-11-04T05:00:00Z');
    this.fake = createFakeTg({ startId: 10_000, fail: (c) => this.failWith?.(c) ?? null });
    if (opts.cards) {
      this.render = (svg) => {
        this.drawn.push(svg);
        return Promise.resolve(FAKE_PNG);
      };
    }
  }

  get deps() {
    return { db: this.db, tg: this.fake.tg, now: () => this.now, render: this.render };
  }

  at(iso: string) {
    this.now = new Date(iso);
    return this;
  }

  private from() {
    return { id: this.chatId, is_bot: false, first_name: 'Sohib', language_code: this.lang };
  }

  /** Sends a text message; returns its message id. */
  async say(text: string, opts: { messageId?: number; forwardDate?: number } = {}): Promise<number> {
    const messageId = opts.messageId ?? nextMessageId++;
    const message: Record<string, unknown> = {
      message_id: messageId,
      date: Math.floor(this.now.getTime() / 1000),
      chat: { id: this.chatId, type: 'private' },
      from: this.from(),
      text,
    };
    if (opts.forwardDate) message.forward_origin = { type: 'hidden_user', sender_user_name: 'Me', date: opts.forwardDate };
    await handleUpdate({ update_id: nextUpdateId++, message }, this.deps);
    return messageId;
  }

  async edit(messageId: number, text: string, sentAt: Date) {
    await handleUpdate({
      update_id: nextUpdateId++,
      edited_message: {
        message_id: messageId,
        date: Math.floor(sentAt.getTime() / 1000),
        edit_date: Math.floor(this.now.getTime() / 1000),
        chat: { id: this.chatId, type: 'private' },
        from: this.from(),
        text,
      },
    }, this.deps);
  }

  async raw(update: Record<string, unknown>) {
    await handleUpdate({ update_id: nextUpdateId++, ...update }, this.deps);
  }

  async press(data: string, messageId: number) {
    await handleUpdate({
      update_id: nextUpdateId++,
      callback_query: {
        id: `cq${nextUpdateId}`,
        from: this.from(),
        message: { message_id: messageId, date: 0, chat: { id: this.chatId, type: 'private' } },
        data,
      },
    }, this.deps);
  }

  tick() {
    return runTick(this.deps, { test: true });
  }

  /** Telegram calls made since the last time this was called. */
  calls(): FakeCall[] {
    const out = this.fake.calls.slice(this.seen);
    this.seen = this.fake.calls.length;
    return out;
  }

  /**
   * The only message-producing call since last time (sendMessage / editMessageText / sendPhoto).
   * Decorations are left out: reactions, "sending photo…", menu updates, and badge congratulations
   * (the messages with a full-screen effect) – tests about those read calls() themselves.
   */
  one(method?: string): FakeCall {
    const calls = this.calls().filter((c) => !AMBIENT.has(c.method) && !c.params.message_effect_id);
    const picked = method ? calls.filter((c) => c.method === method) : calls;
    if (picked.length !== 1) {
      throw new Error(`expected one ${method ?? 'call'}, got ${calls.map((c) => c.method).join(', ') || 'none'}`);
    }
    return picked[0];
  }

  /** Message id the fake Telegram gave to a sendMessage call. */
  idOf(call: FakeCall): number {
    if (typeof call.result?.message_id !== 'number') throw new Error(`${call.method} produced no message`);
    return call.result.message_id;
  }
}

/** All callback_data values of an inline keyboard. */
export function buttons(call: FakeCall): string[] {
  return (call.params.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data);
}

export function buttonTexts(call: FakeCall): string[] {
  return (call.params.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.text);
}
