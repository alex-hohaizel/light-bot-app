import { createHash, randomBytes } from 'node:crypto';
import type { DeliveryOutcome } from '../../shared/delivery-contract.ts';
import type { BotButton } from '../../shared/bot/types.ts';
import type { CampaignEnvelope, CampaignTelegramSender } from '../release/update-campaign.ts';
import { validInstant } from '../../shared/schedule-core.ts';

export const EXPECTED_TELEGRAM_USERNAME = 'PowerUkraineBot' as const;
export type TelegramReadMethod = 'getMe' | 'getWebhookInfo';
export type TelegramEffectMethod = 'sendMessage' | 'sendPhoto' | 'answerCallbackQuery';
type Method = TelegramReadMethod | TelegramEffectMethod;
type Failure = Exclude<DeliveryOutcome, { kind: 'sent' }>;
export interface TelegramReadContext { actorId: string; capabilityId: string }
export interface TelegramEffectContext extends TelegramReadContext {
  operationId: string;
  recipientRef: string;
  /** Opaque server inbox reference, never an untrusted native callback_query_id. */
  callbackRef?: string;
}
export interface TelegramAuthorizationRequest extends TelegramReadContext {
  botId: string;
  method: Method;
  operationId?: string;
  recipientRef?: string;
  callbackRef?: string;
  dispatchIndex: number;
  fallbackFrom?: 'render_failed' | 'caption_limit' | 'photo_rejected_400';
}
export interface TelegramVerifiedGrant extends TelegramAuthorizationRequest {
  expiresAt: string;
  /** Only an authenticated server-owned resolver may return these private fields. */
  chatId?: string;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  bindingRevision?: string;
  callbackQueryId?: string;
}
export type TelegramAuthorizationPort = (request: Readonly<TelegramAuthorizationRequest>, signal: AbortSignal) => Promise<TelegramVerifiedGrant | null>;
export interface TelegramFetchRequest {
  method: 'POST';
  redirect: 'error';
  credentials: 'omit';
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  signal: AbortSignal;
}
export interface TelegramFetchResponse {
  url: string;
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}
/** The token-bearing URL is confined to this injected in-memory provider boundary. */
export type TelegramFetch = (url: string, request: TelegramFetchRequest) => Promise<TelegramFetchResponse>;
export type TelegramButton = { text: string; callbackData: string } | { text: string; url: string } | { text: string; webAppUrl: string };
export type TelegramKeyboard = readonly (readonly TelegramButton[])[];
export interface TelegramMessage { text: string; keyboard?: TelegramKeyboard }
export interface TelegramPhoto { caption: string; png: Uint8Array; keyboard?: TelegramKeyboard }
export interface TelegramRenderedSchedule { text: string; renderKey: string; keyboard?: TelegramKeyboard }
export interface TelegramAttemptReceipt {
  method: Method;
  requestSha256: string;
  providerAccepted: boolean;
  messageId?: number;
  providerErrorCode?: number;
}
export interface TelegramTransportReceipt {
  botId: string;
  operationId?: string;
  recipientRef?: string;
  completedAt: string | null;
  attempts: TelegramAttemptReceipt[];
  fallback?: 'render_failed' | 'caption_limit' | 'photo_rejected_400';
}
export interface TelegramEffectResult { outcome: DeliveryOutcome; receipt: TelegramTransportReceipt }
export type TelegramReadResult<T> = { ok: true; value: T; receipt: TelegramTransportReceipt } |
  { ok: false; outcome: Failure; receipt: TelegramTransportReceipt };
export interface TelegramBotIdentity { botId: string; username: typeof EXPECTED_TELEGRAM_USERNAME; name: string }
export interface TelegramWebhookObservation {
  configured: boolean;
  /** Full webhook URL, errors and IP addresses are deliberately excluded. */
  urlSha256: string;
  pendingUpdateCount: number;
  hasCustomCertificate: boolean;
}
export interface TelegramTransport {
  readonly botId: string;
  readonly read: {
    getMe(context: TelegramReadContext, signal: AbortSignal): Promise<TelegramReadResult<TelegramBotIdentity>>;
    getWebhookInfo(context: TelegramReadContext, signal: AbortSignal): Promise<TelegramReadResult<TelegramWebhookObservation>>;
  };
  readonly effects: {
    sendMessage(context: TelegramEffectContext, message: TelegramMessage, signal: AbortSignal): Promise<TelegramEffectResult>;
    answerCallbackQuery(context: TelegramEffectContext, answer: { text?: string; showAlert?: boolean }, signal: AbortSignal): Promise<TelegramEffectResult>;
    sendPhoto(context: TelegramEffectContext, photo: TelegramPhoto, signal: AbortSignal): Promise<TelegramEffectResult>;
    sendRenderedSchedule(context: TelegramEffectContext, message: TelegramRenderedSchedule, signal: AbortSignal): Promise<TelegramEffectResult>;
  };
}
const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)));
const only = (v: Record<string, any>, keys: readonly string[]) => Object.keys(v).every(key => keys.includes(key));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const integer = (v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const numericId = (v: unknown, signed = false): v is string => typeof v === 'string' && (signed ? /^-?[1-9]\d{0,15}$/ : /^[1-9]\d{0,15}$/).test(v) && integer(Math.abs(Number(v)), 1, 2 ** 52 - 1);
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && (empty || v.trim().length > 0) &&
  v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(v);
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const notSent = (reason: string): Failure => ({ kind: 'not_sent', retryable: false, reason });
const unknown = (reason: string): Failure => ({ kind: 'unknown', reason });
class Refusal extends Error { readonly outcome: Failure; constructor(outcome: Failure) { super(outcome.kind); this.outcome = outcome; } }
const refuse = (reason: string): never => { throw new Refusal(notSent(reason)); };

/** Converts native domain callbacks without truncating IDs or fabricating callback aliases. */
export function telegramKeyboardFromBotButtons(buttons: readonly BotButton[]): TelegramKeyboard {
  if (!Array.isArray(buttons) || buttons.length > 16) return refuse('telegram_keyboard_invalid');
  const rows: TelegramButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2).map(button => ({ text: button.label, callbackData: button.callbackId })));
  keyboardPayload(rows); return rows;
}
function safeUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && Boolean(u.hostname) && !u.username && !u.password; } catch { return false; }
}
function keyboardPayload(keyboard?: TelegramKeyboard): Record<string, unknown> | undefined {
  if (keyboard === undefined) return undefined;
  if (!Array.isArray(keyboard) || keyboard.length > 8) return refuse('telegram_keyboard_invalid');
  let total = 0;
  const inline_keyboard = keyboard.map(row => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 4 || (total += row.length) > 16) return refuse('telegram_keyboard_invalid');
    return row.map(button => {
      if (!object(button) || !text(button.text, 100) || !only(button, ['text', 'callbackData', 'url', 'webAppUrl']) ||
          ['callbackData', 'url', 'webAppUrl'].filter(key => Object.hasOwn(button, key)).length !== 1) return refuse('telegram_keyboard_invalid');
      if ('callbackData' in button) {
        if (!text(button.callbackData, 64) || Buffer.byteLength(button.callbackData, 'utf8') > 64) return refuse('telegram_callback_too_large');
        return { text: button.text, callback_data: button.callbackData };
      }
      const value = 'url' in button ? button.url : button.webAppUrl;
      if (!safeUrl(value)) return refuse('telegram_button_url_invalid');
      return 'url' in button ? { text: button.text, url: value } : { text: button.text, web_app: { url: value } };
    });
  });
  return inline_keyboard.length ? { inline_keyboard } : undefined;
}
function messagePayload(message: TelegramMessage): Record<string, unknown> {
  if (!object(message) || !only(message, ['text', 'keyboard']) || !text(message.text, 4_096)) return refuse('telegram_message_invalid');
  const reply_markup = keyboardPayload(message.keyboard);
  return { text: message.text, ...(reply_markup ? { reply_markup } : {}) };
}
function pngBytes(value: unknown, maxBytes: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 33 || value.byteLength > maxBytes) return refuse('telegram_photo_invalid');
  const bytes = Buffer.from(value);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return refuse('telegram_photo_invalid');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width + height > 10_000 || Math.max(width / height, height / width) > 20) return refuse('telegram_photo_dimensions');
  return bytes;
}
interface Work {
  signal: AbortSignal;
  receipt: TelegramTransportReceipt;
  dispatched: boolean;
}
interface ApiResult { result?: unknown; outcome?: Failure; attempt: TelegramAttemptReceipt }

/** No env/token reads, default fetch, auto startup, webhook mutation, metadata writer or retry loop. */
export function createTelegramTransport(options: {
  expectedBotId: string;
  token: string;
  fetch: TelegramFetch;
  authorize?: TelegramAuthorizationPort;
  now: () => number;
  renderPhoto?: (request: Readonly<{ renderKey: string; actorId: string; recipientRef: string; operationId: string }>, signal: AbortSignal) => Promise<Uint8Array>;
  limits?: { timeoutMs?: number; maxResponseBytes?: number; maxRequestBytes?: number; maxPhotoBytes?: number; identityMaxAgeMs?: number };
}): TelegramTransport {
  const botId = options.expectedBotId, token = options.token;
  if (!numericId(botId) || typeof token !== 'string' || !/^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,100}$/.test(token) || token.split(':')[0] !== botId ||
      typeof options.fetch !== 'function' || typeof options.now !== 'function' || options.authorize !== undefined && typeof options.authorize !== 'function') throw new Error('INVALID_TELEGRAM_TRANSPORT');
  const fetchPort = options.fetch, authorizationPort = options.authorize, clockPort = options.now, renderer = options.renderPhoto;
  const timeoutMs = options.limits?.timeoutMs ?? 10_000, maxResponseBytes = options.limits?.maxResponseBytes ?? 131_072,
    maxRequestBytes = options.limits?.maxRequestBytes ?? 10_200_000, maxPhotoBytes = options.limits?.maxPhotoBytes ?? 5_000_000,
    identityMaxAgeMs = options.limits?.identityMaxAgeMs ?? 300_000;
  if (!integer(timeoutMs, 1, 30_000) || !integer(maxResponseBytes, 1, 262_144) || !integer(maxRequestBytes, 1, 10_200_000) ||
      !integer(maxPhotoBytes, 33, 10_000_000) || !integer(identityMaxAgeMs, 1, 300_000)) throw new Error('INVALID_TELEGRAM_TRANSPORT_LIMITS');
  let active = false, verifiedAt: number | null = null, lastClock = -Infinity;
  function now(): number {
    const value = clockPort();
    if (!integer(value, 0, 8_640_000_000_000_000) || value < lastClock) return refuse('telegram_clock_invalid');
    lastClock = value; return value;
  }
  function checkContext(context: TelegramReadContext, effect: boolean): asserts context is TelegramEffectContext {
    const c = context as TelegramEffectContext;
    if (!object(context) || !id(context.actorId) || !id(context.capabilityId) ||
        !only(context, effect ? ['actorId', 'capabilityId', 'operationId', 'recipientRef', 'callbackRef'] : ['actorId', 'capabilityId']) ||
        effect && (!id(c.operationId) || !id(c.recipientRef) || c.callbackRef !== undefined && !id(c.callbackRef)) ||
        [context.actorId, context.capabilityId, c.operationId, c.recipientRef, c.callbackRef].some(value => typeof value === 'string' && value.includes(token))) return refuse('telegram_context_invalid');
  }
  async function grant(work: Work, context: TelegramReadContext, method: Method, effect: boolean): Promise<TelegramVerifiedGrant> {
    if (work.signal.aborted) return refuse('telegram_cancelled_before_dispatch');
    if (!authorizationPort) return refuse('telegram_capability_unavailable');
    checkContext(context, effect);
    const c = context as TelegramEffectContext;
    const request: TelegramAuthorizationRequest = { actorId: context.actorId, capabilityId: context.capabilityId, botId, method,
      ...(effect ? { operationId: c.operationId, recipientRef: c.recipientRef, ...(c.callbackRef ? { callbackRef: c.callbackRef } : {}) } : {}),
      dispatchIndex: work.receipt.attempts.length + 1, ...(work.receipt.fallback ? { fallbackFrom: work.receipt.fallback } : {}) };
    const resolved = await authorizationPort(Object.freeze(request), work.signal);
    if (work.signal.aborted) return refuse('telegram_cancelled_before_dispatch');
    if (!object(resolved) || Object.entries(request).some(([key, value]) => resolved[key as keyof TelegramVerifiedGrant] !== value) ||
        !validInstant(resolved.expiresAt) || Date.parse(resolved.expiresAt) <= now()) return refuse('telegram_capability_invalid');
    if (effect && (!numericId(resolved.chatId, true) || typeof resolved.chatType !== 'string' || !['private', 'group', 'supergroup', 'channel'].includes(resolved.chatType) || !id(resolved.bindingRevision))) return refuse('telegram_destination_unverified');
    if (method === 'answerCallbackQuery' && (!c.callbackRef || !text(resolved.callbackQueryId, 256) || /[^\x21-\x7e]/.test(resolved.callbackQueryId))) return refuse('telegram_callback_unverified');
    if (effect && (verifiedAt === null || now() - verifiedAt > identityMaxAgeMs)) return refuse('telegram_bot_identity_unverified');
    return structuredClone(resolved) as TelegramVerifiedGrant;
  }
  async function api(work: Work, method: Method, payload: Record<string, unknown>, permission: TelegramVerifiedGrant, photo?: Buffer): Promise<ApiResult> {
    if (work.signal.aborted) return refuse('telegram_cancelled_before_dispatch');
    if (JSON.stringify(payload).includes(token)) return refuse('telegram_sensitive_payload_rejected');
    let bytes: Buffer, contentType: string;
    if (photo) {
      const boundary = `lba${randomBytes(16).toString('hex')}`, parts: Buffer[] = [];
      for (const [key, value] of Object.entries(payload)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${typeof value === 'object' ? JSON.stringify(value) : String(value)}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="schedule.png"\r\nContent-Type: image/png\r\n\r\n`), photo, Buffer.from(`\r\n--${boundary}--\r\n`));
      bytes = Buffer.concat(parts); contentType = `multipart/form-data; boundary=${boundary}`;
    } else { bytes = Buffer.from(JSON.stringify(payload)); contentType = 'application/json'; }
    if (bytes.byteLength > maxRequestBytes) return refuse('telegram_request_too_large');
    if (Date.parse(permission.expiresAt) <= now()) return refuse('telegram_capability_invalid');
    if (!['getMe', 'getWebhookInfo'].includes(method) && (verifiedAt === null || now() - verifiedAt > identityMaxAgeMs)) return refuse('telegram_bot_identity_unverified');
    const attempt: TelegramAttemptReceipt = { method, requestSha256: sha(bytes), providerAccepted: false };
    work.receipt.attempts.push(attempt);
    const url = `https://api.telegram.org/bot${token}/${method}`;
    // Mark before invoking a possibly synchronous-throwing transport: no presumed non-send.
    work.dispatched = true;
    let response: TelegramFetchResponse;
    try { response = await fetchPort(url, { method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'content-type': contentType, 'accept-encoding': 'identity' }, body: bytes, signal: work.signal }); }
    catch { return { attempt, outcome: unknown('telegram_transport_error') }; }
    if (work.signal.aborted) return { attempt, outcome: unknown('telegram_cancelled_after_dispatch') };
    if (response.url !== url) return { attempt, outcome: unknown('telegram_origin_unverified') };
    if (!integer(response.status, 100, 599) || response.status >= 500) return { attempt, outcome: unknown('telegram_server_outcome_unknown') };
    if ((response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json' ||
        ![null, 'identity'].includes(response.headers.get('content-encoding'))) return { attempt, outcome: unknown('telegram_response_unverified') };
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes) || !response.body) return { attempt, outcome: unknown('telegram_response_limit') };
    const chunks: Buffer[] = []; let total = 0, body: unknown;
    try {
      for await (const chunk of response.body) {
        if (work.signal.aborted) return { attempt, outcome: unknown('telegram_cancelled_after_dispatch') };
        if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.byteLength > maxResponseBytes - total || chunks.length >= 2_048) return { attempt, outcome: unknown('telegram_response_limit') };
        total += chunk.byteLength; chunks.push(Buffer.from(chunk));
      }
      if (!total || length !== null && Number(length) !== total) return { attempt, outcome: unknown('telegram_response_limit') };
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    } catch { return { attempt, outcome: unknown('telegram_response_unverified') }; }
    if (!object(body)) return { attempt, outcome: unknown('telegram_response_unverified') };
    if (response.status === 200 && body.ok === true && Object.hasOwn(body, 'result')) return { attempt, result: body.result };
    if (body.ok !== false || !integer(body.error_code, 400, 599) || body.error_code !== response.status) return { attempt, outcome: unknown('telegram_response_unverified') };
    attempt.providerErrorCode = body.error_code;
    if (body.error_code === 429) return { attempt, outcome: object(body.parameters) && integer(body.parameters.retry_after, 1, 86_400)
      ? { kind: 'rate_limited', retryAfterSeconds: body.parameters.retry_after } : unknown('rate_limit_unverified') };
    if (body.error_code === 403) return { attempt, outcome: notSent('telegram_forbidden') };
    if (body.error_code < 500) return { attempt, outcome: notSent(`telegram_rejected_${body.error_code}`) };
    return { attempt, outcome: unknown('telegram_server_outcome_unknown') };
  }
  function acceptedMessage(reply: ApiResult, target: TelegramVerifiedGrant): DeliveryOutcome {
    if (reply.outcome) return reply.outcome;
    const result = reply.result;
    if (!object(result) || !integer(result.message_id) || !object(result.chat) || !Number.isSafeInteger(result.chat.id) || String(result.chat.id) !== target.chatId || result.chat.type !== target.chatType ||
        result.from !== undefined && (!object(result.from) || String(result.from.id) !== botId || result.from.is_bot !== true)) return unknown('telegram_message_target_unverified');
    reply.attempt.providerAccepted = true; reply.attempt.messageId = result.message_id;
    return { kind: 'sent', receipt: `tg-msg-${result.message_id}` };
  }
  async function bounded<T>(context: TelegramReadContext, signal: AbortSignal, task: (work: Work) => Promise<T>): Promise<{ value?: T; outcome?: Failure; receipt: TelegramTransportReceipt }> {
    const c = context as TelegramEffectContext;
    const receipt: TelegramTransportReceipt = { botId, completedAt: null, attempts: [],
      ...(object(context) && id(c.operationId) && !c.operationId.includes(token) ? { operationId: c.operationId } : {}),
      ...(object(context) && id(c.recipientRef) && !c.recipientRef.includes(token) ? { recipientRef: c.recipientRef } : {}) };
    if (!signal || typeof signal.addEventListener !== 'function' || signal.aborted) return { outcome: notSent('telegram_cancelled_before_dispatch'), receipt };
    if (active) return { outcome: notSent('telegram_transport_busy'), receipt };
    active = true;
    const controller = new AbortController(), work: Work = { signal: controller.signal, receipt, dispatched: false };
    let timer: ReturnType<typeof setTimeout> | undefined, resolveStop!: (value: { outcome: Failure }) => void;
    const stopped = new Promise<{ outcome: Failure }>(resolve => { resolveStop = resolve; });
    const stop = (reason: string) => { resolveStop({ outcome: work.dispatched ? unknown(reason) : notSent(reason) }); controller.abort(); };
    const abort = () => stop(work.dispatched ? 'telegram_cancelled_after_dispatch' : 'telegram_cancelled_before_dispatch');
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop(work.dispatched ? 'telegram_timeout' : 'telegram_preflight_timeout'), timeoutMs);
    const operation = Promise.resolve().then(() => { now(); return task(work); }).then(value => ({ value }), error => ({ outcome: error instanceof Refusal ? error.outcome : work.dispatched ? unknown('telegram_operation_unknown') : notSent('telegram_preflight_failed') }));
    // Keep the slot until the real injected operation settles if it ignores abort.
    void operation.then(() => { active = false; controller.abort(); });
    const result = await Promise.race([operation, stopped]);
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    try { receipt.completedAt = new Date(now()).toISOString(); } catch { return { outcome: work.dispatched ? unknown('telegram_clock_invalid') : notSent('telegram_clock_invalid'), receipt: structuredClone(receipt) }; }
    return { ...result, receipt: structuredClone(receipt) };
  }
  async function sendText(work: Work, context: TelegramEffectContext, message: TelegramMessage): Promise<DeliveryOutcome> {
    const payload = messagePayload(message), target = await grant(work, context, 'sendMessage', true);
    if (target.chatType !== 'private' && JSON.stringify(payload.reply_markup ?? {}).includes('"web_app"')) return refuse('telegram_web_app_requires_private_chat');
    return acceptedMessage(await api(work, 'sendMessage', { chat_id: target.chatId!, ...payload, allow_paid_broadcast: false }, target), target);
  }
  async function sendPng(work: Work, context: TelegramEffectContext, photo: TelegramPhoto): Promise<DeliveryOutcome> {
    if (!object(photo) || !only(photo, ['caption', 'png', 'keyboard']) || !text(photo.caption, 1_024, true)) return refuse('telegram_photo_caption_invalid');
    const bytes = pngBytes(photo.png, maxPhotoBytes), reply_markup = keyboardPayload(photo.keyboard), target = await grant(work, context, 'sendPhoto', true);
    if (target.chatType !== 'private' && JSON.stringify(reply_markup ?? {}).includes('"web_app"')) return refuse('telegram_web_app_requires_private_chat');
    return acceptedMessage(await api(work, 'sendPhoto', { chat_id: target.chatId!, caption: photo.caption, ...(reply_markup ? { reply_markup } : {}), allow_paid_broadcast: false }, target, bytes), target);
  }
  const effect = async <T>(context: TelegramEffectContext, signal: AbortSignal, input: T,
    task: (work: Work, context: TelegramEffectContext, input: T) => Promise<DeliveryOutcome>): Promise<TelegramEffectResult> => {
    let c: TelegramEffectContext, value: T;
    try { c = structuredClone(context); value = structuredClone(input); }
    catch { return { outcome: notSent('telegram_input_invalid'), receipt: { botId, completedAt: null, attempts: [] } }; }
    const result = await bounded(c, signal, work => task(work, c, value)); return { outcome: result.outcome ?? result.value!, receipt: result.receipt };
  };
  const transport: TelegramTransport = {
    botId,
    read: Object.freeze({
      async getMe(context, signal) {
        const result = await bounded(context, signal, async work => {
          verifiedAt = null;
          const permission = await grant(work, context, 'getMe', false); const reply = await api(work, 'getMe', {}, permission);
          if (reply.outcome) throw new Refusal(reply.outcome);
          const me = reply.result;
          if (!object(me) || !Number.isSafeInteger(me.id) || String(me.id) !== botId || me.is_bot !== true ||
              typeof me.username !== 'string' || me.username.toLowerCase() !== EXPECTED_TELEGRAM_USERNAME.toLowerCase() || !text(me.first_name, 128) || me.first_name.includes(token)) {
            verifiedAt = null; throw new Refusal(unknown('telegram_bot_identity_mismatch'));
          }
          verifiedAt = now(); reply.attempt.providerAccepted = true;
          return { botId, username: EXPECTED_TELEGRAM_USERNAME, name: me.first_name };
        });
        return result.outcome ? { ok: false, outcome: result.outcome, receipt: result.receipt } : { ok: true, value: result.value!, receipt: result.receipt };
      },
      async getWebhookInfo(context, signal) {
        const result = await bounded(context, signal, async work => {
          const permission = await grant(work, context, 'getWebhookInfo', false); const reply = await api(work, 'getWebhookInfo', {}, permission);
          if (reply.outcome) throw new Refusal(reply.outcome);
          const info = reply.result;
          if (!object(info) || typeof info.url !== 'string' || info.url !== '' && !safeUrl(info.url) || !integer(info.pending_update_count, 0) || typeof info.has_custom_certificate !== 'boolean') throw new Refusal(unknown('telegram_webhook_unverified'));
          reply.attempt.providerAccepted = true;
          return { configured: info.url !== '', urlSha256: sha(info.url), pendingUpdateCount: info.pending_update_count, hasCustomCertificate: info.has_custom_certificate };
        });
        return result.outcome ? { ok: false, outcome: result.outcome, receipt: result.receipt } : { ok: true, value: result.value!, receipt: result.receipt };
      },
    }),
    effects: Object.freeze({
      sendMessage: (context, message, signal) => effect(context, signal, message, (work, c, m) => sendText(work, c, m)),
      sendPhoto: (context, photo, signal) => effect(context, signal, photo, (work, c, p) => sendPng(work, c, p)),
      answerCallbackQuery: (c, a, signal) => effect(c, signal, a, async (work, context, answer) => {
        if (!object(answer) || !only(answer, ['text', 'showAlert']) || answer.text !== undefined && !text(answer.text, 200, true) || answer.showAlert !== undefined && typeof answer.showAlert !== 'boolean') return refuse('telegram_callback_answer_invalid');
        const target = await grant(work, context, 'answerCallbackQuery', true), reply = await api(work, 'answerCallbackQuery', { callback_query_id: target.callbackQueryId!, text: answer.text ?? '', show_alert: answer.showAlert ?? false, cache_time: 0 }, target);
        if (reply.outcome) return reply.outcome;
        if (reply.result !== true) return unknown('telegram_callback_ack_unverified');
        reply.attempt.providerAccepted = true; return { kind: 'sent', receipt: `tg-callback-${sha(target.callbackQueryId!).slice(0, 24)}` };
      }),
      sendRenderedSchedule: (c, m, signal) => effect(c, signal, m, async (work, context, message) => {
        checkContext(context, true);
        if (!object(message) || !only(message, ['text', 'renderKey', 'keyboard']) || !id(message.renderKey)) return refuse('telegram_render_request_invalid');
        messagePayload({ text: message.text, ...(message.keyboard ? { keyboard: message.keyboard } : {}) });
        if (message.text.length > 1_024) {
          work.receipt.fallback = 'caption_limit'; return sendText(work, context, { text: message.text, keyboard: message.keyboard });
        }
        let png: Uint8Array;
        try {
          if (!renderer) throw new Error('RENDERER_UNAVAILABLE');
          png = await renderer(Object.freeze({ renderKey: message.renderKey, actorId: context.actorId, recipientRef: context.recipientRef, operationId: context.operationId }), work.signal);
          pngBytes(png, maxPhotoBytes);
        } catch {
          if (work.signal.aborted) return refuse('telegram_cancelled_before_dispatch');
          work.receipt.fallback = 'render_failed'; return sendText(work, context, { text: message.text, keyboard: message.keyboard });
        }
        const photoOutcome = await sendPng(work, context, { caption: message.text, png, keyboard: message.keyboard });
        const last = work.receipt.attempts.at(-1);
        if (photoOutcome.kind === 'not_sent' && last?.method === 'sendPhoto' && last.providerErrorCode === 400) {
          work.receipt.fallback = 'photo_rejected_400'; return sendText(work, context, { text: message.text, keyboard: message.keyboard });
        }
        return photoOutcome;
      }),
    }),
  };
  return Object.freeze(transport);
}

/** Reuses the campaign port without returning raw Telegram body, token URL or private chat ID. */
export function campaignSenderFromTelegramTransport(transport: TelegramTransport,
  resolveContext: (envelope: Readonly<CampaignEnvelope>, signal: AbortSignal) => Promise<TelegramEffectContext | null>): CampaignTelegramSender {
  return Object.freeze({ kind: 'telegram-release-campaign' as const, botId: transport.botId,
    async send(envelope: Readonly<CampaignEnvelope>, signal: AbortSignal) {
      let context: TelegramEffectContext | null;
      try { context = await resolveContext(envelope, signal); } catch { context = null; }
      if (!context || envelope.botId !== transport.botId || context.recipientRef !== envelope.recipientRef || context.operationId !== envelope.operationId) return { botId: transport.botId, recipientRef: envelope.recipientRef, body: null };
      const result = await transport.effects.sendMessage(context, { text: envelope.text, keyboard: [[{ text: 'Відкрити застосунок', url: envelope.appUrl }]] }, signal);
      const outcome = result.outcome, last = result.receipt.attempts.at(-1);
      let body: unknown = null;
      if (outcome.kind === 'sent' && last?.providerAccepted && last.messageId) body = { ok: true, result: { message_id: last.messageId } };
      else if (outcome.kind === 'rate_limited') body = { ok: false, error_code: 429, parameters: { retry_after: outcome.retryAfterSeconds } };
      else if (outcome.kind === 'not_sent' && last?.providerErrorCode && last.providerErrorCode < 500) body = { ok: false, error_code: last.providerErrorCode };
      return { botId: transport.botId, recipientRef: envelope.recipientRef, body };
    },
  });
}
