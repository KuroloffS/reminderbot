// Minimal Telegram Bot API client (plain fetch) and a recording fake for tests / ?action=simulate.

export type Tg = (method: string, params?: Record<string, unknown>) => Promise<any>;

export class TgError extends Error {
  readonly method: string;
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;

  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`Telegram ${method}: ${code} ${description}`);
    this.name = 'TgError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

/** Full-screen animations Telegram plays when a message arrives in a private chat (message_effect_id). */
export const EFFECT = { fire: '5104841245755180586', party: '5046509860389126442' } as const;

/** JSON normally; multipart/form-data when a file (Blob) is among the parameters. */
function encode(params: Record<string, unknown>): { body: BodyInit; headers?: Record<string, string> } {
  if (!Object.values(params).some((v) => v instanceof Blob)) {
    return { body: JSON.stringify(params), headers: { 'content-type': 'application/json' } };
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) form.append(key, value, value instanceof File ? value.name : key);
    else if (typeof value === 'string') form.append(key, value);
    else form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return { body: form };
}

export function createTg(token: string, base = 'https://api.telegram.org'): Tg {
  return async (method, params = {}) => {
    const res = await fetch(`${base}/bot${token}/${method}`, { method: 'POST', ...encode(params) });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      throw new TgError(method, res.status, `HTTP ${res.status}`);
    }
    if (!data?.ok) {
      throw new TgError(
        method,
        data?.error_code ?? res.status,
        data?.description ?? 'request failed',
        data?.parameters?.retry_after,
      );
    }
    return data.result;
  };
}

/** The user blocked the bot or deleted the account: stop writing to that chat. */
export function isBlocked(e: unknown): boolean {
  if (!(e instanceof TgError)) return false;
  return e.code === 403 || (e.code === 400 && /chat not found|user is deactivated/i.test(e.description));
}

/** Worth trying again a bit later (rate limit, Telegram hiccup, network). */
export function isTemporary(e: unknown): boolean {
  if (e instanceof TgError) return e.code === 429 || e.code >= 500;
  return true;
}

export function isNotModified(e: unknown): boolean {
  return e instanceof TgError && e.code === 400 && /message is not modified/i.test(e.description);
}

/** The same request without the decorations (message effect, button colors), or null when it has none. */
export function withoutExtras(params: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, any> = { ...params };
  let changed = false;
  if ('message_effect_id' in out) {
    delete out.message_effect_id;
    changed = true;
  }
  const rows = out.reply_markup?.inline_keyboard;
  if (Array.isArray(rows) && rows.some((row: any[]) => row.some((b) => b?.style))) {
    out.reply_markup = {
      ...out.reply_markup,
      inline_keyboard: rows.map((row: any[]) => row.map(({ style: _style, ...b }) => b)),
    };
    changed = true;
  }
  return changed ? out : null;
}

/**
 * Calls Telegram; if the request is rejected (400) and carried decorations, sends it once more
 * without them. A message must never get lost because of a confetti effect or a button color.
 */
export async function tgSafe(tg: Tg, method: string, params: Record<string, unknown>): Promise<any> {
  try {
    return await tg(method, params);
  } catch (e) {
    const plain = e instanceof TgError && e.code === 400 && !isNotModified(e) && !isBlocked(e) ? withoutExtras(params) : null;
    if (!plain) throw e;
    console.warn(`${method}: sent without effect/button colors after "${(e as TgError).description}"`);
    return await tg(method, plain);
  }
}

export type FakeCall = { method: string; params: Record<string, any>; result?: any };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Records every call and answers like Telegram would (sent messages get increasing ids).
 * Uploaded files are recorded as {file, type, bytes, png} (+ base64 with keepFiles).
 */
export function createFakeTg(
  opts: { startId?: number; fail?: (call: FakeCall) => TgError | null; keepFiles?: boolean } = {},
) {
  const calls: FakeCall[] = [];
  let nextId = opts.startId ?? 1000;
  const tg: Tg = async (method, params = {}) => {
    const recorded: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value instanceof Blob) {
        const bytes = new Uint8Array(await value.arrayBuffer());
        recorded[key] = {
          file: value instanceof File ? value.name : null,
          type: value.type,
          bytes: bytes.length,
          png: PNG_SIGNATURE.every((b, i) => bytes[i] === b),
          ...(opts.keepFiles ? { base64: toBase64(bytes) } : {}),
        };
      } else {
        recorded[key] = value;
      }
    }
    const call: FakeCall = { method, params: recorded };
    calls.push(call);
    const failure = opts.fail?.(call);
    if (failure) throw failure;
    if (method.startsWith('send') && method !== 'sendChatAction') {
      call.result = {
        message_id: ++nextId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: params.chat_id, type: 'private' },
        ...(method === 'sendPhoto' ? { caption: params.caption } : { text: params.text }),
      };
    } else if (method === 'getWebhookInfo') {
      call.result = { url: '', pending_update_count: 0 };
    } else if (method === 'getMe') {
      call.result = { id: 1, is_bot: true, first_name: 'Simulation', username: 'simulation_bot' };
    } else {
      call.result = true;
    }
    return call.result;
  };
  return { tg, calls };
}
