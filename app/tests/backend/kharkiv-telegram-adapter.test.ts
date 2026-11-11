import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KharkivRssContext } from '../../server/domain/kharkiv-adapter.ts';
import {
  createKharkivTelegramNormalizer, KHARKIV_TELEGRAM_ENDPOINT, KHARKIV_TELEGRAM_QUEUE_IDS, KHARKIV_TELEGRAM_SOURCE,
  normalizeKharkivTelegram,
} from '../../server/domain/kharkiv-telegram-adapter.ts';

// Numeric queue ranges, message ID and publication instant from @kharkivenergy/2348.
// The surrounding HTML is a bounded reproduction of the public feed markup.
const intro = 'У середу, 11 листопада, з 00:00 до 24:00 у Харківській області будуть діяти графіки погодинних відключень (ГПВ).';
const tableHeading = 'Години відсутності електропостачання по чергам/підчергам з урахуванням часу на перемикання (орієнтовно):';
const ranges = [
  '1.1 02:00-09:00; 13:00-19:30; 23:00-24:00',
  '1.2 02:00-09:00; 13:00-19:30; 23:00-24:00',
  '2.1 06:00-09:00; 13:00-19:30',
  '2.2 06:00-09:00; 13:00-19:30',
  '3.1 00:00-02:00; 08:00-12:30; 16:30-23:00',
  '3.2 00:00-02:00; 08:00-12:30; 16:30-23:00',
  '4.1 00:00-02:00; 08:00-12:30; 16:30-23:00',
  '4.2 00:00-02:00; 08:00-12:30; 16:30-23:00',
  '5.1 00:00-05:30; 09:30-16:00; 20:00-24:00',
  '5.2 00:00-08:00; 09:30-16:00; 20:00-24:00',
  '6.1 00:00-08:00; 09:30-16:00; 20:00-24:00',
  '6.2 00:00-08:00; 09:30-16:00; 20:00-24:00',
];
const plan = ['‼️ <b>' + intro + '</b>', tableHeading, ...ranges,
  'Перелік адрес за чергами - <a href="https://oblenergo.kharkiv.ua/">тут</a>.',
  '➡️ ДЛЯ ПРОМИСЛОВОСТІ ТА БІЗНЕСУ з 00:00 до 24:00 діятимуть графіки обмеження потужності (ГОП).',
].join('<br>');
const postTime = '2026-11-10T19:55:17+00:00';

function post(body = plan, id = 2348, publishedAt = postTime): string {
  return '<div class="tgme_widget_message text_not_supported_wrap" data-post="kharkivenergy/' + id + '">' +
    '<div class="tgme_widget_message_text js-message_text" dir="auto">' + body + '</div>' +
    '<a class="tgme_widget_message_date" href="https://t.me/kharkivenergy/' + id + '">' +
    '<time datetime="' + publishedAt + '" class="time">21:55</time></a></div>';
}

const html = (...posts: string[]) => '<!DOCTYPE html><html><body>' + posts.join('') + '</body></html>';
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
function context(raw: string, overrides: Partial<KharkivRssContext> = {}): KharkivRssContext {
  return {
    namespace: 'kharkiv:rss', operatorId: 'kharkiv-oe', targetId: '1.1',
    addressId: 'manual-kharkiv-1.1', addressLabel: 'Група 1.1', localityLabel: 'Харків',
    serviceDate: '2026-11-11', observedAt: '2026-11-10T23:52:00Z',
    source: { id: KHARKIV_TELEGRAM_SOURCE, name: 'Харківобленерго', url: KHARKIV_TELEGRAM_ENDPOINT,
      revision: hash(raw), accessCost: 0, verifiedLevel: 'schedule' },
    freshness: 'current', synthetic: false, publicationPolicy: 'dated_12_queue_recurring_v2',
    ...overrides,
  };
}

test('normalizes all twelve queues of post 2348 as a manual general plan', () => {
  const raw = html(post());
  for (const targetId of KHARKIV_TELEGRAM_QUEUE_IDS) {
    const view = normalizeKharkivTelegram(raw, context(raw, { targetId }));
    const expected = ranges.find(row => row.startsWith(targetId + ' '))!.slice(4).split('; ');
    assert.deepEqual(view.intervals.map(({ startLocal, endLocal }) => startLocal + '-' + endLocal), expected);
    assert.equal(view.namespace, 'kharkiv:rss');
    assert.equal(view.status, 'published');
    assert.equal(view.dayCoverage, 'complete');
    assert.equal(view.deliveryEligible, false);
    assert.equal(view.source.id, KHARKIV_TELEGRAM_SOURCE);
    assert.equal(view.source.url, 'https://t.me/kharkivenergy/2348');
    assert.equal(view.source.revision, hash(raw));
    assert.equal(view.publishedAt, '2026-11-10T19:55:17.000Z');
    assert.match(view.notice ?? '', /Групу обрано вручну.*аварійні відключення не підтверджено/);
  }
  const view = normalizeKharkivTelegram(raw, context(raw));
  assert.equal(view.intervals[0].startsAt, '2026-11-11T00:00:00.000Z');
  assert.equal(view.intervals.at(-1)?.endsAt, '2026-11-11T22:00:00.000Z');
});

test('takes the newest complete schedule for the exact service day and avoids unrelated feed revision drift', () => {
  const updatedPlan = plan.replace('1.1 02:00-09:00', '1.1 03:00-09:00');
  const recent = post(updatedPlan, 2349, '2026-11-10T20:10:00Z');
  const staleYear = post(plan, 1499, '2025-11-10T20:10:00Z');
  const otherDay = post(plan.replace('середу, 11', 'четвер, 12'), 2350, '2026-11-10T20:20:00Z');
  const photoRecap = post('11 листопада бригади працювали над відновленням. Фоторепортаж про погодинні відключення.', 2351, '2026-11-10T23:00:00Z');
  const first = html(staleYear, recent, otherDay, post(), photoRecap);
  const second = html(recent, otherDay);
  const views = [first, second].map(raw => normalizeKharkivTelegram(raw, context(raw)));
  assert.equal(views[0].source.url, 'https://t.me/kharkivenergy/2349');
  assert.equal(views[0].intervals[0].startLocal, '03:00');
  assert.equal(views[0].revisionId, views[1].revisionId);
  assert.notEqual(views[0].source.revision, views[1].source.revision);
});

test('scoped normalization keeps each observation and date isolated and returns independent interval objects', () => {
  const raw = html(post());
  const normalize = createKharkivTelegramNormalizer();
  const first = normalize(raw, context(raw));
  first.intervals[0].startLocal = '00:00';
  assert.throws(() => normalize(raw, context(raw, { serviceDate: '2026-11-12' })), /TELEGRAM_DATED_PLAN_MISSING/);
  assert.equal(normalize(raw, context(raw)).intervals[0].startLocal, '02:00');
  assert.throws(() => normalize(raw, context(raw, { observedAt: '2026-11-10T19:01:00Z' })), /TELEGRAM_PUBLICATION_AFTER_OBSERVATION/);
  const revised = html(post(plan.replace('1.1 02:00-09:00', '1.1 03:00-09:00')));
  assert.equal(normalize(revised, context(revised)).intervals[0].startLocal, '03:00');
});

test('does not silently reuse the older post for an incomplete or withdrawn newer announcement', () => {
  const attempts = [
    [plan.replace('<br>' + ranges[11], ''), /TELEGRAM_INCOMPLETE_QUEUE_TABLE/],
    ['Зміни до графіка відключень на 11.11.2026.', /TELEGRAM_BODY_DATE_OR_COVERAGE_CONFLICT/],
    ['Графіки відключень на сьогодні скасовано.', /TELEGRAM_PLAN_WITHDRAWN/],
    ['11 листопада на Харківщині діють аварійні відключення.', /TELEGRAM_EMERGENCY_OVERLAY_REQUIRES_REVIEW/],
  ] as const;
  for (const [body, error] of attempts) {
    const raw = html(post(), post(body, 2349, '2026-11-10T22:10:00Z'));
    assert.throws(() => normalizeKharkivTelegram(raw, context(raw)), error);
  }
});

test('rejects any malformed queue, partial coverage, wrong weekday or missing switching semantics', () => {
  const attempts = [
    [plan.replace('6.2 ', '6.1 '), /TELEGRAM_QUEUE_DUPLICATE_OR_UNKNOWN/],
    [plan.replace('6.2 ', '7.2 '), /TELEGRAM_QUEUE_DUPLICATE_OR_UNKNOWN/],
    [plan.replace('6.2 00:00-08:00', '6.2 00:60-08:00'), /TELEGRAM_INTERVAL_CLOCK/],
    [plan.replace('6.2 00:00-08:00; 09:30-16:00', '6.2 00:00-10:00; 09:30-16:00'), /TELEGRAM_INTERVAL_OVERLAP_OR_ORDER/],
    [plan.replace('з 00:00 до 24:00', 'з 01:00 до 24:00'), /TELEGRAM_BODY_DATE_OR_COVERAGE_CONFLICT/],
    [plan.replace('середу', 'четвер'), /TELEGRAM_BODY_DATE_OR_COVERAGE_CONFLICT/],
    [plan.replace(' з урахуванням часу на перемикання (орієнтовно)', ''), /TELEGRAM_PLAN_SEMANTICS_NOT_RECOGNIZED/],
  ] as const;
  for (const [body, error] of attempts) {
    const raw = html(post(body));
    assert.throws(() => normalizeKharkivTelegram(raw, context(raw)), error);
  }
});

test('rejects unknown message origins, forwarding, invalid timestamps, duplicate IDs and simultaneous ambiguity', () => {
  const attempts = [
    [html(post().replace('https://t.me/kharkivenergy/2348', 'https://t.me/another_channel/2348')), /TELEGRAM_UNTRUSTED_MESSAGE/],
    [html(post().replace('</time></a>', '</time></a><span class="tgme_widget_message_forwarded_from"></span>')), /TELEGRAM_UNTRUSTED_MESSAGE/],
    [html(post(plan, 2348, '2026-11-10T19:55:17')), /TELEGRAM_PUBLICATION_FORMAT/],
    [html(post(plan, 2348, '2026-11-30T19:55:17Z')), /TELEGRAM_DATED_PLAN_MISSING/],
    [html(post(plan, 2348, '2026-11-11T01:55:17Z')), /TELEGRAM_PUBLICATION_AFTER_OBSERVATION/],
    [html(post(), post()), /TELEGRAM_DATED_PLAN_AMBIGUOUS/],
    [html(post(), post(plan, 2349)), /TELEGRAM_DATED_PLAN_AMBIGUOUS/],
    [html(post().replace('data-post="kharkivenergy/', 'data-post="another_channel/')), /TELEGRAM_DATED_PLAN_MISSING/],
  ] as const;
  for (const [raw, error] of attempts) {
    assert.throws(() => normalizeKharkivTelegram(raw, context(raw)), error);
  }
});

test('pins raw bytes and the public feed origin and does not certify a house', () => {
  const raw = html(post());
  const trusted = context(raw);
  assert.throws(() => normalizeKharkivTelegram(raw + ' ', trusted), /RAW_SOURCE_HASH_MISMATCH/);
  assert.throws(() => normalizeKharkivTelegram(raw, context(raw, { source: {
    ...trusted.source, url: 'https://t.me/s/kharkivenergy?before=2348',
  } })), /TELEGRAM_OPERATOR_NAMESPACE_OR_ORIGIN_MISMATCH/);
  assert.throws(() => normalizeKharkivTelegram(raw, context(raw, { source: {
    ...trusted.source, verifiedLevel: 'address',
  } })), /PARSER_CANNOT_CERTIFY_ADDRESS_OR_INTEGRATION/);
  assert.equal(normalizeKharkivTelegram(raw, context(raw, { observedAt: '2026-11-12T01:00:00Z' })).status, 'stale');
});
