import type { Express } from 'express';
import type { BotInput } from '../../shared/bot/types.ts';
import { PLAN_STATUS_COPY, type PlanStatus } from '../../shared/product-contract.ts';
import { SYNTHETIC_USER_ID, assertIsolatedRuntimeReady } from '../isolated-guard.ts';
import {registerReviewToolsRoutes} from './review-tools-routes.ts';
import { parseProfileRequest } from './profile-service.ts';
// Module inspection/route registration must not initialize a database pool.
const localStore = () => import('./bot-session-store.ts');

function inputFrom(value: unknown): BotInput {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.id)) throw new Error('INVALID_INPUT');
  if (input.id.startsWith('app:') || input.id.startsWith('event:')) throw new Error('INVALID_INPUT');
  if ((input.kind === 'command' || input.kind === 'text') && typeof input.text === 'string' && input.text.length <= 1000) return { id: input.id, kind: input.kind, text: input.text };
  if (input.kind === 'callback' && typeof input.callbackId === 'string' && input.callbackId.length <= 512) return { id: input.id, kind: 'callback', callbackId: input.callbackId };
  throw new Error('INVALID_INPUT');
}
export function registerProductReviewRoutes(app: Express) {
  assertIsolatedRuntimeReady();
  registerReviewToolsRoutes(app);
  // Parent isolated auth pins actor to the one synthetic profile; callers cannot choose it.
  app.get('/api/review/profile', async (_req, res) => {
    try { res.json(await (await localStore()).profileSnapshot(SYNTHETIC_USER_ID)); }
    catch { res.status(503).json({ error: 'Не вдалося отримати тестовий профіль.', simulationOnly: true }); }
  });
  app.post('/api/review/profile', async (req, res) => {
    try {
      const request = parseProfileRequest(req.body);
      res.json(await (await localStore()).commitProfileMutation(SYNTHETIC_USER_ID, request));
    }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      const conflict = ['INPUT_ID_CONFLICT', 'PROFILE_REVISION_CONFLICT', 'PROFILE_BINDING_REVISION_CONFLICT'].includes(code);
      const invalid = code === 'INVALID_PROFILE_INPUT';
      const rejected = ['PROFILE_ADDRESS_NOT_FOUND', 'PROFILE_OPTION_NOT_FOUND', 'PROFILE_ADDRESS_ALREADY_SAVED', 'PROFILE_ADDRESS_LIMIT', 'PROFILE_BINDING_NOT_VERIFIED'].includes(code);
      res.status(conflict ? 409 : invalid ? 400 : rejected ? 422 : 503).json({ code: conflict || invalid || rejected ? code : 'PROFILE_SAVE_UNCONFIRMED',
        error: conflict ? 'Профіль змінився в іншому вікні або боті. Оновіть його й перевірте дію ще раз.' :
          invalid ? 'Перевірте введені дані та явне підтвердження адреси.' :
            rejected ? 'Цю зміну не застосовано. Перевірте адресу, прив’язку або вже збережений будинок.' :
              'Збереження ще не підтверджено. Повторіть той самий запит.', simulationOnly: true });
    }
  });
  app.get('/api/review/bot', async (_req, res) => {
    try { res.json(await (await localStore()).botSnapshot(SYNTHETIC_USER_ID)); }
    catch { res.status(503).json({ error: 'Локальна сесія ще не готова. Повторіть запит.' }); }
  });
  app.post('/api/review/bot/reset', async (req, res) => {
    try { res.json(await (await localStore()).resetBotSession(SYNTHETIC_USER_ID, req.body?.mode === 'returning')); }
    catch { res.status(503).json({ error: 'Не вдалося підготувати тестовий профіль.' }); }
  });
  app.post('/api/review/bot', async (req, res) => {
    try {
      const input = inputFrom(req.body?.input);
      const status = req.body?.status || 'published';
      if (!Object.hasOwn(PLAN_STATUS_COPY, status)) throw new Error('INVALID_INPUT');
      res.json(await (await localStore()).commitBotInput(SYNTHETIC_USER_ID, input, status as PlanStatus));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      res.status(message === 'INPUT_ID_CONFLICT' ? 409 : message === 'INVALID_INPUT' ? 400 : 503)
        .json({ error: message === 'INPUT_ID_CONFLICT' ? 'Цей ID вже належить іншій дії.' : 'Не вдалося зберегти дію. Повторіть той самий запит.', simulationOnly: true });
    }
  });
}
