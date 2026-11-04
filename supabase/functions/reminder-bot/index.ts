// German Lesson Reminder – Telegram bot as a Supabase Edge Function.
//
//   POST /functions/v1/reminder-bot                  Telegram webhook (checked with a secret token)
//   POST /functions/v1/reminder-bot?action=tick      every minute from pg_cron: connects the webhook
//                                                    once BOT_TOKEN exists, sends what is due
//   POST /functions/v1/reminder-bot?action=simulate  self-test with a fake Telegram (test chats only)
//   POST /functions/v1/reminder-bot?action=cleanup   deletes the test chats
//   GET  /functions/v1/reminder-bot                  health check
//
// tick/simulate/cleanup need the x-cron-secret header (kept in public.app_state, which only the
// database and the service role can read). The only secret to add by hand is BOT_TOKEN.
import { createClient } from '@supabase/supabase-js';
import { handleUpdate } from './lib/bot.ts';
import { type Call, createDb, DbError } from './lib/db.ts';
import { ensureWebhook } from './lib/setup.ts';
import { createFakeTg, createTg, type Tg } from './lib/telegram.ts';
import { runTick } from './lib/tick.ts';

const VERSION = '2026-11-04.1';
const FUNCTION_NAME = 'reminder-bot';
const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/${FUNCTION_NAME}`;

/** New-style secret key (sb_secret_…) when the project has one, otherwise the legacy service_role key. */
function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const key = keys.default ?? Object.values(keys)[0];
    if (typeof key === 'string' && key) return key;
  } catch {
    // fall through
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

const supabase = createClient(SUPABASE_URL, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
const call: Call = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new DbError(`${fn}: ${error.message}`, error.code);
  return data;
};
const db = createDb(call);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Live = { token: string; tg: Tg; secret: string; tokenId: string };
let live: Live | null = null;

/** Telegram client for the current BOT_TOKEN (rebuilt when the token changes). */
async function getLive(): Promise<Live | null> {
  const token = (Deno.env.get('BOT_TOKEN') ?? '').trim();
  if (!token) return null;
  if (live?.token === token) return live;
  live = {
    token,
    tg: createTg(token),
    secret: await sha256Hex(`webhook:${token}`),
    tokenId: (await sha256Hex(`id:${token}`)).slice(0, 16),
  };
  return live;
}

let cronSecret: { value: string; at: number } | null = null;
async function cronAuthorized(req: Request): Promise<boolean> {
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!given) return false;
  if (!cronSecret || Date.now() - cronSecret.at > 5 * 60_000) {
    const state = await db.getState('cron');
    cronSecret = { value: typeof state?.secret === 'string' ? state.secret : '', at: Date.now() };
  }
  return cronSecret.value !== '' && safeEqual(given, cronSecret.value);
}

async function tick() {
  const out: Record<string, unknown> = { ok: true, version: VERSION, at: new Date().toISOString(), configured: false };
  const l = await getLive();
  if (l) {
    out.configured = true;
    try {
      out.webhook = await ensureWebhook(l.tg, db, { url: WEBHOOK_URL, secretToken: l.secret, tokenId: l.tokenId });
    } catch (e) {
      out.ok = false;
      out.webhook_error = errorText(e);
      console.error('Webhook setup failed:', e);
    }
    try {
      out.sent = await runTick({ db, tg: l.tg, now: () => new Date() }, { test: false });
    } catch (e) {
      out.ok = false;
      out.tick_error = errorText(e);
      console.error('Tick failed:', e);
    }
  }
  // Last result, readable with: select value from app_state where key = 'tick_status';
  try {
    await db.setState('tick_status', out);
  } catch (e) {
    console.error('Could not save tick status:', e);
  }
  return out;
}

function chatOf(update: any): number | undefined {
  return (
    update?.message?.chat?.id ?? update?.edited_message?.chat?.id ?? update?.callback_query?.message?.chat?.id ??
      update?.my_chat_member?.chat?.id
  );
}

/**
 * Runs steps through the real bot code and database with a fake Telegram:
 * {steps: [{now?: ISO, update?: TelegramUpdate, tick?: true}], cleanup?: true}. Test chats (negative ids) only.
 */
async function simulate(body: any) {
  const steps: any[] = Array.isArray(body?.steps) ? body.steps : [];
  for (const step of steps) {
    if (step?.update && !(Number(chatOf(step.update)) < 0)) throw new Error('simulate accepts only test chats (negative ids)');
  }
  const fake = createFakeTg({ startId: Number(body?.start_message_id) || 5000 });
  const results: any[] = [];
  for (const step of steps) {
    const at = step?.now ? new Date(step.now) : new Date();
    const deps = { db, tg: fake.tg, now: () => at };
    const from = fake.calls.length;
    const result: Record<string, unknown> = {};
    try {
      if (step?.update) await handleUpdate(step.update, deps);
      if (step?.tick) result.tick = await runTick(deps, { test: true });
    } catch (e) {
      result.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    }
    result.calls = fake.calls.slice(from);
    results.push(result);
  }
  const cleanup = body?.cleanup ? await db.testCleanup() : undefined;
  return { ok: results.every((r) => !r.error), version: VERSION, results, cleanup };
}

Deno.serve(async (req: Request) => {
  const action = new URL(req.url).searchParams.get('action');
  try {
    if (action) {
      if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
      if (!(await cronAuthorized(req))) return json({ ok: false, error: 'unauthorized' }, 401);
      if (action === 'tick') return json(await tick());
      if (action === 'simulate') return json(await simulate(await req.json()));
      if (action === 'cleanup') return json({ ok: true, ...(await db.testCleanup()) });
      return json({ ok: false, error: 'unknown action' }, 400);
    }

    if (req.method === 'POST') {
      const l = await getLive();
      if (!l) return json({ ok: false, error: 'BOT_TOKEN is not set' }, 503);
      const given = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
      if (!safeEqual(given, l.secret)) return json({ ok: false, error: 'unauthorized' }, 401);
      const update = await req.json();
      try {
        await handleUpdate(update, { db, tg: l.tg, now: () => new Date() });
      } catch (e) {
        // Answer 200 anyway: Telegram would otherwise resend the same update again and again.
        console.error('Update failed:', update?.update_id, e);
      }
      return json({ ok: true });
    }

    return json({
      ok: true,
      service: 'german-lesson-reminder',
      version: VERSION,
      configured: Boolean(Deno.env.get('BOT_TOKEN')),
    });
  } catch (e) {
    console.error('Request failed:', e);
    return json({ ok: false, error: errorText(e) }, 500);
  }
});
