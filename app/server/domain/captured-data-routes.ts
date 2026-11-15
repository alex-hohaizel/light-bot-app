import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Express } from 'express';
import type { ScheduleView, SourceReference } from '../../shared/product-contract.ts';
import { localParts } from '../../shared/schedule-core.ts';
import { normalizeYasnoRaw } from './yasno-adapter.ts';
import { normalizeHourMatrix } from './hour-matrix-adapter.ts';
import { normalizeKharkivRss } from './kharkiv-adapter.ts';
import { assertIsolatedRuntimeReady } from '../isolated-guard.ts';
import { parseCapturedAddressBook } from './captured-address-book.ts';

const directory = path.resolve(process.cwd(), '../docs/light-bot-app/p1');
type Capture = { id: string; city: string; target: string; name: string; file: string; limitation: string };
const captures: Capture[] = [
  { id: 'yasno-kem', city: 'Київ', target: '1.1', name: 'YASNO · Київські електромережі', file: 'fixtures/yasno-kem.json', limitation: 'Технічна група. Зв’язок з конкретним будинком не підтверджено.' },
  { id: 'voe-mirror-vn-progr', city: 'Вінниця', target: 'GPV1.1', name: 'Вінниця · громадське дзеркало', file: 'fixtures/voe-mirror-vn-progr.json', limitation: 'Безплатний резерв і точна адресна прив’язка ще не прийняті. Старе дзеркало за 2025 рік виключене.' },
  { id: 'dtek-oem-official', city: 'Одеса', target: 'GPV1.1', name: 'ДТЕК Одеські електромережі', file: 'fixtures/dtek-oem-official.txt', limitation: 'Одна збережена публічна відповідь. Регулярне опитування цього маршруту заблоковане robots; обходу немає.' },
  { id: 'kharkiv-official-rss', city: 'Харків', target: '1.1', name: 'Харківобленерго · офіційний RSS', file: 'fixtures/kharkiv-official-rss.txt', limitation: 'План Харківобленерго. Київське джерело для Харкова не використовується; адресна прив’язка ще не прийнята.' },
];
function normalize(capture: Capture): ScheduleView {
  const registry = JSON.parse(readFileSync(path.join(directory, 'source-registry.json'), 'utf8')).sources;
  const entry = registry.find((source: any) => source.id === capture.id);
  if (!entry) throw new Error('CAPTURE_REGISTRY_MISSING');
  const evidence = entry.evidence.find((item: any) => item.path === capture.file);
  const raw = readFileSync(path.join(directory, capture.file), 'utf8');
  const digest = createHash('sha256').update(raw).digest('hex');
  if (digest !== evidence?.sha256) throw new Error('CAPTURE_HASH_MISMATCH');
  const source: SourceReference = { id: capture.id, name: capture.name, url: entry.source_url, revision: digest, accessCost: 0, verifiedLevel: 'catalog' };
  const context = { addressId: `unbound:${entry.operator_id}:${capture.target}`, addressLabel: `Технічна група ${capture.target.replace('GPV', '')}`,
    localityLabel: capture.city, serviceDate: '2026-11-07', observedAt: new Date(evidence.observed_at_utc).toISOString(), source,
    freshness: localParts(Date.now()).date === '2026-11-07' ? 'unknown' as const : 'stale' as const, synthetic: false };
  if (capture.id === 'yasno-kem') return normalizeYasnoRaw(raw, 'today', { ...context, namespace: 'yasno:25/902', operatorId: 'dtek-kem', targetId: capture.target });
  if (capture.id === 'kharkiv-official-rss') return normalizeKharkivRss(raw, { ...context, namespace: 'kharkiv:rss', operatorId: 'kharkiv-oe', targetId: capture.target });
  return normalizeHourMatrix(raw, { ...context, namespace: capture.id === 'dtek-oem-official' ? 'dtek:oem' : 'voe:vn-progr',
    operatorId: capture.id === 'dtek-oem-official' ? 'dtek-oem' : 'vinnytsia-oe', targetId: capture.target });
}
export function registerCapturedDataRoutes(app: Express) {
  assertIsolatedRuntimeReady();
  app.get('/api/review/data', (_req, res) => {
    const records = captures.map(capture => {
      try { return { ...capture, file: undefined, status: 'parsed', view: normalize(capture) }; }
      catch { return { ...capture, file: undefined, status: 'unavailable', view: null }; }
    });
    let addressCandidates: unknown[] = [];
    let addressCandidateStatus = 'unavailable';
    try {
      const cases = parseCapturedAddressBook(readFileSync(path.resolve(directory, '../p2/address-adapter/candidates.json'), 'utf8'));
      addressCandidates = cases.map(candidate => {
        const view = normalize({ ...captures[0], target: candidate.targetId });
        return { id: candidate.id, label: candidate.label, targetId: candidate.targetId, status: candidate.status, observedAt: candidate.observedAt,
          view: { ...view, addressId: candidate.addressId, addressLabel: `Публічний зразок · група ${candidate.targetId}`,
            bindingRevisionId: candidate.bindingRevisionId, deliveryEligible: false } };
      });
      addressCandidateStatus = 'parsed';
    } catch { /* A missing/changed proof book never activates a personal binding. */ }
    res.json({ mode: 'captured_public_preview', networkRequests: 0, addressBindingVerified: false, notifications: false, records, addressCandidates, addressCandidateStatus });
  });
}
