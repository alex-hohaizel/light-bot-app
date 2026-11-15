import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTelegramTransport, telegramKeyboardFromBotButtons, campaignSenderFromTelegramTransport,
  type TelegramAuthorizationPort, type TelegramFetch, type TelegramFetchResponse, type TelegramFetchRequest,
  type TelegramEffectContext, type TelegramEffectResult } from '../../server/production/telegram-transport.ts';
import { classifyCampaignReply, type CampaignEnvelope } from '../../server/release/update-campaign.ts';

const botId = '123456789', token = `${botId}:unit_fixture_secret_xxxxxxxxxxxxxxx`, initial = Date.parse('2026-11-08T15:00:00Z');
const read = { actorId: 'service:root', capabilityId: 'grant:read' };
const context: TelegramEffectContext = { actorId: 'actor:owned', capabilityId: 'grant:send', operationId: 'op:one', recipientRef: 'recipient:owned' };
const signal = () => new AbortController().signal;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1kAAAAASUVORK5CYII=', 'base64');
async function* body(value: unknown) { yield Buffer.from(JSON.stringify(value)); }
function response(url: string, value: unknown, status = 200, extra: Partial<TelegramFetchResponse> = {}): TelegramFetchResponse {
  return { url, status, headers: { get: key => key === 'content-type' ? 'application/json' : null }, body: body(value), ...extra };
}
const identity = { ok: true, result: { id: Number(botId), is_bot: true, username: 'PowerUkraineBot', first_name: 'Світло' } };
const success = { ok: true, result: { message_id: 42, chat: { id: 777, type: 'private' }, from: { id: Number(botId), is_bot: true } } };
const authorize: TelegramAuthorizationPort = async request => ({ ...request, expiresAt: '2026-11-09T00:00:00Z',
  ...(request.recipientRef ? { chatId: '777', chatType: 'private' as const, bindingRevision: 'mapping:1' } : {}),
  ...(request.method === 'answerCallbackQuery' ? { callbackQueryId: 'native-owned-query-123' } : {}) });
function harness(options: { authorize?: TelegramAuthorizationPort; fetch?: TelegramFetch; renderPhoto?: (request: any, signal: AbortSignal) => Promise<Uint8Array>;
  timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number; now?: () => number; identityMaxAgeMs?: number } = {}) {
  const calls: { url: string; request: TelegramFetchRequest; method: string }[] = [];
  const fetch: TelegramFetch = async (url, request) => {
    const method = url.split('/').at(-1)!; calls.push({ url, request, method });
    if (method === 'getMe') return response(url, identity);
    return options.fetch ? options.fetch(url, request) : response(url, method === 'answerCallbackQuery' ? { ok: true, result: true } : success);
  };
  const transport = createTelegramTransport({ expectedBotId: botId, token, fetch, authorize: options.authorize ?? authorize,
    now: options.now ?? (() => initial), renderPhoto: options.renderPhoto, limits: { timeoutMs: options.timeoutMs ?? 100,
      ...(options.maxRequestBytes ? { maxRequestBytes: options.maxRequestBytes } : {}), ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
      ...(options.identityMaxAgeMs ? { identityMaxAgeMs: options.identityMaxAgeMs } : {}) } });
  const ready = async () => { const result = await transport.read.getMe(read, signal()); assert.equal(result.ok, true); calls.length = 0; };
  return { transport, calls, ready };
}
const outcome = (result: TelegramEffectResult, kind: string, reason?: string) => {
  assert.equal(result.outcome.kind, kind);
  if (reason) { assert('reason' in result.outcome); assert.equal(result.outcome.reason, reason); }
};

test('factory validates exact token prefix without reading env, dispatching, exposing token or providing writer startup methods', async () => {
  let calls = 0;
  for (const secret of ['wrong', '987654321:unit_fixture_secret_xxxxxxxxxxxxxxx']) assert.throws(() => createTelegramTransport({ expectedBotId: botId, token: secret,
    fetch: async () => { calls++; throw new Error('NO'); }, now: () => initial }), error => error instanceof Error && error.message === 'INVALID_TELEGRAM_TRANSPORT' && !error.message.includes(secret));
  const t = createTelegramTransport({ expectedBotId: botId, token, fetch: async () => { calls++; throw new Error('NO'); }, now: () => initial });
  assert.deepEqual(Object.keys(t.read), ['getMe', 'getWebhookInfo']); assert(!('setWebhook' in t)); assert(!('start' in t));
  assert.equal(calls, 0); assert(!JSON.stringify(t).includes(token));
  const result = await t.read.getMe(read, signal()); assert.equal(result.ok, false);
  outcome(await t.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent', 'telegram_capability_unavailable'); assert.equal(calls, 0);
});
test('effects require a prior explicit verified getMe and fresh identity, not only a configured credential', async () => {
  let now = initial; const h = harness({ now: () => now, identityMaxAgeMs: 1_000 });
  outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent', 'telegram_bot_identity_unverified'); assert.equal(h.calls.length, 0);
  await h.ready(); now += 1_001;
  outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent', 'telegram_bot_identity_unverified'); assert.equal(h.calls.length, 0);
});
test('getMe rejects wrong bot, username, is_bot and malformed identity without leaking raw provider data', async () => {
  for (const patch of [{ id: 999 }, { username: 'OtherBot' }, { is_bot: false }, { first_name: token }]) {
    let calls = 0;
    const t = createTelegramTransport({ expectedBotId: botId, token, authorize, now: () => initial, fetch: async url => { calls++; return response(url, { ...identity, result: { ...identity.result, ...patch } }); } });
    const result = await t.read.getMe(read, signal()); assert.equal(result.ok, false); assert(!JSON.stringify(result).includes(token));
    outcome(await t.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent', 'telegram_bot_identity_unverified'); assert.equal(calls, 1);
  }
});
test('getWebhookInfo is read-only and returns a digest, never full secret path, query, provider errors or IP', async () => {
  const webhook = 'https://example.invalid/secret-existing-webhook?private=value';
  const h = harness({ fetch: async url => response(url, { ok: true, result: { url: webhook, pending_update_count: 3, has_custom_certificate: false,
    last_error_message: token, ip_address: '192.0.2.44' } }) });
  const result = await h.transport.read.getWebhookInfo(read, signal()); assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { configured: true, urlSha256: createHash('sha256').update(webhook).digest('hex'), pendingUpdateCount: 3, hasCustomCertificate: false });
  const serialized = JSON.stringify(result); for (const privateValue of [webhook, token, '192.0.2.44']) assert(!serialized.includes(privateValue));
  assert.deepEqual(h.calls.map(c => c.method), ['getWebhookInfo']); assert.equal(Buffer.from(h.calls[0].request.body).toString(), '{}');
});
test('exact actor, capability, operation, recipient, mapping and expiry are checked before dispatch', async () => {
  for (const patch of [{ actorId: 'foreign' }, { capabilityId: 'foreign' }, { operationId: 'foreign' }, { recipientRef: 'foreign' },
    { method: 'sendPhoto' }, { botId: 'foreign' }, { chatId: '@username' }, { chatId: '777.0' }, { chatId: '9007199254740999' },
    { bindingRevision: '' }, { expiresAt: '2026-11-08T15:00:00Z' }]) {
    const h = harness({ authorize: async req => ({ ...(await authorize(req, signal()))!, ...(req.method === 'sendMessage' ? patch : {}) } as any) });
    await h.ready(); outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent'); assert.equal(h.calls.length, 0);
  }
});
test('message payload is plain text and paid broadcasts, arbitrary chat IDs and unknown options cannot bypass the whitelist', async () => {
  const h = harness(); await h.ready();
  outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено. <b>Це текст</b>' }, signal()), 'sent');
  const call = h.calls[0], payload = JSON.parse(Buffer.from(call.request.body).toString());
  assert.equal(call.request.redirect, 'error'); assert.equal(call.request.credentials, 'omit'); assert.equal(call.request.headers['accept-encoding'], 'identity');
  assert.equal(payload.chat_id, '777'); assert.equal(payload.parse_mode, undefined); assert.equal(payload.allow_paid_broadcast, false);
  for (const extra of [{ allow_paid_broadcast: true }, { chat_id: '888' }, { parse_mode: 'HTML' }]) {
    outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.', ...extra } as any, signal()), 'not_sent', 'telegram_message_invalid');
  }
  assert.equal(h.calls.length, 1);
});
test('native callback_data is 1…64 UTF-8 bytes, preserves engine IDs, never truncates or silently hashes', async () => {
  const callback = 'bzz_550e8400-e29b-41d4-a716';
  const rows = telegramKeyboardFromBotButtons([{ label: 'Стан зараз', callbackId: callback }]); assert.equal((rows[0][0] as any).callbackData, callback);
  const h = harness(); await h.ready();
  for (const value of ['x'.repeat(64), 'я'.repeat(32), callback]) outcome(await h.transport.effects.sendMessage(context,
    { text: 'Оберіть дію.', keyboard: [[{ text: 'Стан зараз', callbackData: value }]] }, signal()), 'sent');
  for (const value of ['x'.repeat(65), 'я'.repeat(33), '']) outcome(await h.transport.effects.sendMessage(context,
    { text: 'Оберіть дію.', keyboard: [[{ text: 'Стан зараз', callbackData: value }]] }, signal()), 'not_sent');
  assert.equal(h.calls.length, 3);
  assert.throws(() => telegramKeyboardFromBotButtons([{ label: 'Стан', callbackId: 'long-'.repeat(20) }]));
});
test('keyboard caps and URL whitelist reject unsafe links, excess buttons and multiple button actions', async () => {
  const h = harness(); await h.ready();
  for (const keyboard of [[[ { text: 'Відкрити', url: 'javascript:alert(1)' } ]], [[ { text: 'Відкрити', url: 'https://user:password@example.invalid' } ]],
    [[{ text: 'Стан', callbackData: 'ok', url: 'https://example.invalid' }]], Array.from({ length: 9 }, () => [{ text: 'Стан', callbackData: 'ok' }])])
    outcome(await h.transport.effects.sendMessage(context, { text: 'Оберіть дію.', keyboard } as any, signal()), 'not_sent');
  assert.equal(h.calls.length, 0);
});
test('sent requires ok, positive message_id, exact numeric chat/type and matching bot sender', async () => {
  for (const value of [{ ok: true, result: {} }, { ok: true, result: { ...success.result, message_id: 0 } },
    { ok: true, result: { ...success.result, chat: { id: 888, type: 'private' } } },
    { ok: true, result: { ...success.result, chat: { id: 777, type: 'group' } } },
    { ok: true, result: { ...success.result, from: { id: 999, is_bot: true } } }, { ok: 'true', result: success.result }]) {
    const h = harness({ fetch: async url => response(url, value) }); await h.ready();
    outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'unknown'); assert.equal(h.calls.length, 1);
  }
});
test('403 is terminal, 429 requires bounded numeric retry_after, and all 5xx are ambiguous without retries', async () => {
  for (const [code, parameters, kind] of [[403, undefined, 'not_sent'], [429, { retry_after: 2 }, 'rate_limited'],
    [429, undefined, 'unknown'], [429, { retry_after: 0 }, 'unknown'], [429, { retry_after: '2' }, 'unknown'],
    [429, { retry_after: 86401 }, 'unknown'], [500, undefined, 'unknown'], [503, undefined, 'unknown']] as const) {
    const h = harness({ fetch: async url => response(url, { ok: false, error_code: code, parameters, description: token }, code) }); await h.ready();
    const result = await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()); outcome(result, kind);
    assert.equal(h.calls.length, 1); assert(!JSON.stringify(result).includes(token));
    if (code === 403) assert.deepEqual(result.outcome, { kind: 'not_sent', retryable: false, reason: 'telegram_forbidden' });
  }
});
test('native callback query ID comes only from trusted inbox mapping; Boolean true acknowledgement is separate from a message', async () => {
  const h = harness(); await h.ready(); const ctx = { ...context, callbackRef: 'inbox:callback' };
  const result = await h.transport.effects.answerCallbackQuery(ctx, { text: 'План оновлено.' }, signal()); outcome(result, 'sent');
  assert(result.outcome.kind === 'sent' && result.outcome.receipt.startsWith('tg-callback-'));
  const payload = JSON.parse(Buffer.from(h.calls[0].request.body).toString()); assert.equal(payload.callback_query_id, 'native-owned-query-123'); assert.equal(payload.cache_time, 0);
  outcome(await h.transport.effects.answerCallbackQuery({ ...ctx, callbackQueryId: 'foreign-query' } as any, {}, signal()), 'not_sent', 'telegram_context_invalid');
  outcome(await h.transport.effects.answerCallbackQuery(context, {}, signal()), 'not_sent', 'telegram_callback_unverified'); assert.equal(h.calls.length, 1);
});
test('PNG photo upload is bounded multipart with complete caption, fixed filename, no file path or remote photo URL', async () => {
  const h = harness(); await h.ready();
  const result = await h.transport.effects.sendPhoto(context, { caption: 'За планом світло з’явиться о 18:00.', png }, signal()); outcome(result, 'sent');
  const call = h.calls[0], multipart = Buffer.from(call.request.body).toString('latin1');
  assert.equal(call.method, 'sendPhoto'); assert(call.request.headers['content-type'].startsWith('multipart/form-data; boundary=lba'));
  assert(multipart.includes('filename="schedule.png"')); assert(multipart.includes('Content-Type: image/png')); assert(multipart.includes('allow_paid_broadcast')); assert(multipart.includes('false'));
  assert.equal(result.receipt.attempts[0].messageId, 42); assert(!JSON.stringify(result).includes('"chatId"')); assert(!JSON.stringify(result).includes('"chat_id"')); assert(!JSON.stringify(result).includes(token));
  outcome(await h.transport.effects.sendPhoto(context, { caption: 'План', png: 'https://example.invalid/photo.png' } as any, signal()), 'not_sent', 'telegram_photo_invalid');
});
test('render failure and long caption fall back before provider dispatch using the full original text', async () => {
  const long = 'Р'.repeat(1_100); let renders = 0;
  const h = harness({ renderPhoto: async () => { renders++; throw new Error(token); } }); await h.ready();
  const first = await h.transport.effects.sendRenderedSchedule(context, { text: 'План на цю дату ще не опублікований.', renderKey: 'view:one' }, signal());
  outcome(first, 'sent'); assert.equal(first.receipt.fallback, 'render_failed'); assert.deepEqual(h.calls.map(c => c.method), ['sendMessage']);
  const second = await h.transport.effects.sendRenderedSchedule(context, { text: long, renderKey: 'view:one' }, signal()); outcome(second, 'sent');
  assert.equal(second.receipt.fallback, 'caption_limit'); assert.equal(JSON.parse(Buffer.from(h.calls[1].request.body).toString()).text, long); assert.equal(renders, 1);
});
test('photo definite 400 can fall back after a second current scoped authorization, with both attempts retained', async () => {
  const grants: string[] = [];
  const h = harness({ renderPhoto: async () => png, authorize: async (req, sig) => { grants.push(`${req.method}:${req.dispatchIndex}:${req.fallbackFrom ?? ''}`); return authorize(req, sig); },
    fetch: async url => url.endsWith('sendPhoto') ? response(url, { ok: false, error_code: 400 }, 400) : response(url, success) }); await h.ready();
  const result = await h.transport.effects.sendRenderedSchedule(context, { text: 'План оновлено.', renderKey: 'view:one' }, signal()); outcome(result, 'sent');
  assert.deepEqual(h.calls.map(c => c.method), ['sendPhoto', 'sendMessage']); assert.equal(result.receipt.fallback, 'photo_rejected_400');
  assert.equal(result.receipt.attempts.length, 2); assert.equal(result.receipt.attempts[0].providerAccepted, false); assert.equal(result.receipt.attempts[0].providerErrorCode, 400);
  assert(grants.includes('sendMessage:2:photo_rejected_400'));
});
test('photo 403,429,5xx, redirect, malformed and network failures never dispatch text fallback', async () => {
  for (const scenario of ['403', '429', '500', 'redirect', 'malformed', 'network']) {
    const h = harness({ renderPhoto: async () => png, fetch: async url => {
      if (scenario === 'network') throw new Error(`https://api.telegram.org/bot${token}/sendPhoto`);
      if (scenario === 'redirect') return response('https://evil.example/redirect', success);
      if (scenario === 'malformed') return response(url, { ok: true });
      const code = Number(scenario); return response(url, { ok: false, error_code: code, ...(code === 429 ? { parameters: { retry_after: 2 } } : {}) }, code);
    } }); await h.ready();
    const result = await h.transport.effects.sendRenderedSchedule(context, { text: 'План оновлено.', renderKey: 'view:one' }, signal()); assert.notEqual(result.outcome.kind, 'sent');
    assert.deepEqual(h.calls.map(c => c.method), ['sendPhoto']); assert(!JSON.stringify(result).includes(token));
  }
});
test('timeout after photo dispatch remains unknown, holds ignored-abort slot and cannot later trigger fallback', async () => {
  let release!: (value: TelegramFetchResponse) => void;
  const h = harness({ timeoutMs: 10, renderPhoto: async () => png, fetch: async () => new Promise(resolve => { release = resolve; }) }); await h.ready();
  const result = await h.transport.effects.sendRenderedSchedule(context, { text: 'План оновлено.', renderKey: 'view:one' }, signal()); outcome(result, 'unknown', 'telegram_timeout');
  assert.equal(h.calls[0].request.signal.aborted, true);
  outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent', 'telegram_transport_busy');
  release(response(h.calls[0].url, { ok: false, error_code: 400 }, 400)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.map(c => c.method), ['sendPhoto']); assert.equal(result.receipt.attempts[0].providerAccepted, false);
});
test('aborted or timed out authorization cannot dispatch later when its promise resolves', async () => {
  let release!: (value: any) => void;
  const h = harness({ timeoutMs: 10, authorize: async req => req.method === 'getMe' ? authorize(req, signal()) : new Promise(resolve => { release = resolve; }) }); await h.ready();
  const result = await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()); outcome(result, 'not_sent', 'telegram_preflight_timeout');
  release({ ...(await authorize({ ...context, method: 'sendMessage', botId, dispatchIndex: 1 }, signal()))! }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
  const controller = new AbortController(); controller.abort(); outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, controller.signal), 'not_sent');
});
test('request/response byte caps, malformed UTF-8, media type and encoding reject safely', async () => {
  const small = harness({ maxRequestBytes: 2 }); await small.ready();
  outcome(await small.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent', 'telegram_request_too_large'); assert.equal(small.calls.length, 0);
  for (const extra of [
    { headers: { get: (key: string) => key === 'content-type' ? 'text/html' : null } },
    { headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'content-encoding' ? 'gzip' : null } },
    { headers: { get: (key: string) => key === 'content-type' ? 'application/json' : key === 'content-length' ? '999999999' : null } },
    { body: (async function* () { yield new Uint8Array([0xc3, 0x28]); })() },
    { body: (async function* () { yield new Uint8Array(131_073); })() },
  ]) {
    const h = harness({ fetch: async url => response(url, success, 200, extra) }); await h.ready();
    outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'unknown'); assert.equal(h.calls.length, 1);
  }
});
test('campaign bridge preserves sent/rate/terminal facts but maps ambiguous 5xx to unknown, never raw body', async () => {
  const envelope: CampaignEnvelope = { releaseId: 'release:1', deploymentId: 'deployment:1', buildSha256: 'a'.repeat(64), botId,
    origin: 'https://example.invalid', operationId: context.operationId, recipientRef: context.recipientRef, text: 'Ми оновили застосунок.', appUrl: 'https://example.invalid/' };
  for (const code of [200, 403, 429, 500]) {
    const h = harness({ fetch: async url => response(url, code === 200 ? success : { ok: false, error_code: code, description: token,
      ...(code === 429 ? { parameters: { retry_after: 3 } } : {}) }, code) }); await h.ready();
    const sender = campaignSenderFromTelegramTransport(h.transport, async () => context), reply = await sender.send(envelope, signal());
    const classified = classifyCampaignReply(envelope, reply); assert.equal(classified.kind, code === 200 ? 'sent' : code === 403 ? 'not_sent' : code === 429 ? 'rate_limited' : 'unknown');
    const serialized = JSON.stringify(reply); assert(!serialized.includes(token)); assert(!serialized.includes('"chat"')); assert(!serialized.includes('description'));
  }
});
test('in-flight context/payload mutation cannot change the authorized destination or rendered text', async () => {
  let release!: (value: Uint8Array) => void;
  const h = harness({ renderPhoto: async () => new Promise(resolve => { release = resolve; }) }); await h.ready();
  const ctx = { ...context }, message = { text: 'План для вашої адреси.', renderKey: 'view:one' };
  const result = h.transport.effects.sendRenderedSchedule(ctx, message, signal());
  await new Promise(resolve => setImmediate(resolve)); ctx.recipientRef = 'foreign'; ctx.operationId = 'foreign'; message.text = 'Changed';
  release(png); const delivered = await result; outcome(delivered, 'sent'); assert.equal(delivered.receipt.recipientRef, context.recipientRef);
  assert(Buffer.from(h.calls[0].request.body).includes(Buffer.from('План для вашої адреси.'))); assert(!Buffer.from(h.calls[0].request.body).includes(Buffer.from('Changed')));
});
test('secret-like context or text cannot escape through receipts or provider payloads', async () => {
  const h = harness(); await h.ready();
  for (const ctx of [{ ...context, operationId: token }, { ...context, recipientRef: token }]) {
    const result = await h.transport.effects.sendMessage(ctx, { text: 'План оновлено.' }, signal()); outcome(result, 'not_sent'); assert(!JSON.stringify(result).includes(token));
  }
  outcome(await h.transport.effects.sendMessage(context, { text: token }, signal()), 'not_sent', 'telegram_sensitive_payload_rejected'); assert.equal(h.calls.length, 0);
});
test('capability expiry is checked again immediately before dispatch after authorization work', async () => {
  let effectPhase = false;
  const ticks = [initial, initial + 999, initial + 999, initial + 1_001];
  const h = harness({ now: () => effectPhase ? ticks.shift() ?? initial + 1_001 : initial, authorize: async (req, sig) => {
    const granted = await authorize(req, sig);
    if (req.method === 'sendMessage') return { ...granted!, expiresAt: new Date(initial + 1_000).toISOString() };
    return granted;
  } }); await h.ready(); effectPhase = true;
  outcome(await h.transport.effects.sendMessage(context, { text: 'План оновлено.' }, signal()), 'not_sent', 'telegram_capability_invalid'); assert.equal(h.calls.length, 0);
});
test('Mini App keyboard buttons cannot be sent into a group, and emoji captions use a conservative native length bound', async () => {
  const group = harness({ authorize: async (req, sig) => ({ ...(await authorize(req, sig))!, ...(req.recipientRef ? { chatId: '-100777', chatType: 'supergroup' } : {}) }) }); await group.ready();
  outcome(await group.transport.effects.sendMessage(context, { text: 'Відкрити застосунок.', keyboard: [[{ text: 'Відкрити', webAppUrl: 'https://example.invalid/' }]] }, signal()), 'not_sent', 'telegram_web_app_requires_private_chat');
  assert.equal(group.calls.length, 0);
  const h = harness({ renderPhoto: async () => png }); await h.ready(); const value = '🙂'.repeat(600);
  const result = await h.transport.effects.sendRenderedSchedule(context, { text: value, renderKey: 'view:one' }, signal()); outcome(result, 'sent');
  assert.equal(result.receipt.fallback, 'caption_limit'); assert.equal(h.calls[0].method, 'sendMessage'); assert.equal(JSON.parse(Buffer.from(h.calls[0].request.body).toString()).text, value);
});
