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

export function createTg(token: string, base = 'https://api.telegram.org'): Tg {
  return async (method, params = {}) => {
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
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

export type FakeCall = { method: string; params: Record<string, any>; result?: any };

/** Records every call and answers like Telegram would (sent messages get increasing ids). */
export function createFakeTg(opts: { startId?: number; fail?: (call: FakeCall) => TgError | null } = {}) {
  const calls: FakeCall[] = [];
  let nextId = opts.startId ?? 1000;
  const tg: Tg = async (method, params = {}) => {
    const call: FakeCall = { method, params };
    calls.push(call);
    const failure = opts.fail?.(call);
    if (failure) throw failure;
    if (method.startsWith('send')) {
      call.result = {
        message_id: ++nextId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: params.chat_id, type: 'private' },
        text: params.text,
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
