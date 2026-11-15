import type { Express, Response } from 'express';
import { parseReviewToolsRequest } from '../../shared/review-tools.ts';
import { SYNTHETIC_USER_ID, assertIsolatedRuntimeReady } from '../isolated-guard.ts';
// Route registration must not load the database graph or execute SQL.
const tools = () => import('./review-tools.ts');
function rejected(res: Response, error: unknown) {
  const failure = error as { code?: string; status?: number; message?: string };
  const invalid = error instanceof Error && error.message === 'INVALID_REVIEW_TOOLS_INPUT';
  const known = typeof failure.code === 'string' && typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500;
  res.status(invalid ? 400 : known ? failure.status! : 503).json({
    simulationOnly: true, code: invalid ? 'INVALID_REVIEW_TOOLS_INPUT' : known ? failure.code : 'TOOLS_SAVE_UNCONFIRMED',
    error: invalid ? 'Перевірте адресу, термін доступу й параметри дії.' : known ? failure.message : 'Результат дії ще не підтверджено. Повторіть той самий запит.',
  });
}
export function registerReviewToolsRoutes(app: Express) {
  assertIsolatedRuntimeReady();
  app.get('/api/review/tools', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await (await tools()).reviewToolsSnapshot(SYNTHETIC_USER_ID)); } catch (error) { rejected(res, error); }
  });
  app.post('/api/review/tools', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await (await tools()).commitReviewTools(SYNTHETIC_USER_ID, parseReviewToolsRequest(req.body))); } catch (error) { rejected(res, error); }
  });
  app.get('/api/review/share/:token', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await (await tools()).readReviewPublicShare(String(req.params.token))); } catch (error) { rejected(res, error); }
  });
}
