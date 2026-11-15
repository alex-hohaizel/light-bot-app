import type { Express } from "express";
import { isAuthenticatedMobileOrSession } from "./mobile-auth";
import { getLatestDigest, getUserDigests, createWeeklyDigest } from "./storage-digest";
import { getUserReportCount, getUserTotalReportCount, getUserStatus, getPointsForReport, getQueueReportsForDateRange } from "./storage-reports";
import { getUserLocations } from "./storage-locations";
import { getUserSettings } from "./storage";
import type { LocationDigestEntry } from "@shared/models/weekly-digest";
import type { WeeklyDigest } from "@shared/models/weekly-digest";

function getWeekStart(date: Date = new Date()): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getPreviousWeekStart(date: Date = new Date()): Date {
  const ws = getWeekStart(date);
  ws.setDate(ws.getDate() - 7);
  return ws;
}

function formatDay(date: Date): string {
  const days = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота'];
  return days[date.getDay()];
}

/** Legacy rows were generated with random outage/accuracy values and have no
 * verified schedule-history provenance. Preserve rows; never promote them to
 * measured statistics or manufacture a new weekly digest. */
export async function generateDigestForUser(_userId: string): Promise<{
  digest: WeeklyDigest; userStatus: ReturnType<typeof getUserStatus>; totalPoints: number;
} | null> {
  return null;
}

export function registerDigestRoutes(app: Express) {
  app.get('/api/user/digest', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const digest = await generateDigestForUser(userId);
      if (!digest) {
        return res.json(null);
      }

      const totalReports = await getUserTotalReportCount(userId);
      const status = getUserStatus(totalReports);

      res.json({
        digest,
        userStatus: status,
        totalPoints: totalReports * getPointsForReport(),
      });
    } catch (error: any) {
      console.error('[Digest] Error getting digest:', error.message);
      res.status(500).json({ error: 'Failed to get digest' });
    }
  });

  app.get('/api/user/digests', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const limit = Math.min(parseInt(String(req.query.limit) || '10', 10), 52);
      const digests: never[] = []; // Unverified historical rows stay in storage, outside measured output.
      res.json(digests);
    } catch (error: any) {
      console.error('[Digest] Error getting digests:', error.message);
      res.status(500).json({ error: 'Failed to get digests' });
    }
  });

  app.post('/api/user/digest/generate', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const result = await generateDigestForUser(userId);
      if (!result) {
        return res.status(422).json({ code: 'VERIFIED_HISTORY_REQUIRED', error: 'Для тижневого підсумку ще недостатньо перевіреної історії.' });
      }

      res.json(result);
    } catch (error: any) {
      console.error('[Digest] Error generating digest:', error.message);
      res.status(500).json({ error: 'Failed to generate digest' });
    }
  });
}
