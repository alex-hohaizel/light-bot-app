import type { Express, Request, Response } from "express";
import { isAuthenticated } from "./replit_integrations/auth";
import { isAuthenticatedMobileOrSession } from "./mobile-auth";
import {
  createPowerReport,
  getRecentReportsForQueue,
  getUserTotalReportCount,
  getUserReportCount,
  getLastUserReport,
  getUserStatus,
  getPointsForReport,
  getQueueAccuracyStats,
  getUserStreak,
} from "./storage-reports";

const REPORT_COOLDOWN_MS = 2 * 60 * 1000;

export function registerReportRoutes(app: Express) {
  app.post('/api/reports', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { city, queueId, hasPower, source } = req.body;
      if (!city || !queueId || typeof hasPower !== 'boolean') {
        return res.status(400).json({ error: 'Missing city, queueId, or hasPower' });
      }

      const last = await getLastUserReport(userId, city, queueId);
      if (last && Date.now() - new Date(last.reportedAt).getTime() < REPORT_COOLDOWN_MS) {
        const remaining = Math.ceil((REPORT_COOLDOWN_MS - (Date.now() - new Date(last.reportedAt).getTime())) / 1000);
        return res.status(429).json({ error: 'Too soon', retryAfter: remaining });
      }

      const report = await createPowerReport({
        userId,
        city,
        queueId,
        hasPower,
        source: source || 'web',
      });

      const totalReports = await getUserTotalReportCount(userId);
      const status = getUserStatus(totalReports);
      const points = getPointsForReport();

      res.json({
        report,
        points,
        totalReports,
        userStatus: status,
      });
    } catch (error: any) {
      console.error('[Reports] Error creating report:', error.message);
      res.status(500).json({ error: 'Failed to create report' });
    }
  });

  app.get('/api/reports/queue-status', async (req, res) => {
    try {
      const { city, queueId, minutes } = req.query;
      if (!city || !queueId) {
        return res.status(400).json({ error: 'Missing city or queueId' });
      }

      const parsedMins = minutes ? parseInt(String(minutes), 10) : 30;
      const mins = Math.min(Number.isFinite(parsedMins) ? parsedMins : 30, 120);
      const reports = await getRecentReportsForQueue(String(city), String(queueId), mins);

      if (reports.length === 0) {
        return res.json({
          status: 'unknown',
          confidence: 0,
          totalReports: 0,
          lastReport: null,
        });
      }

      const hasPowerCount = reports.filter(r => r.hasPower).length;
      const noPowerCount = reports.filter(r => !r.hasPower).length;
      const total = reports.length;

      let status: 'has_power' | 'no_power' | 'mixed';
      if (hasPowerCount > noPowerCount * 2) status = 'has_power';
      else if (noPowerCount > hasPowerCount * 2) status = 'no_power';
      else status = 'mixed';

      let confidence: number;
      if (total >= 6) confidence = 3;
      else if (total >= 3) confidence = 2;
      else confidence = 1;

      const lastReport = reports[0];

      res.json({
        status,
        confidence,
        totalReports: total,
        hasPowerCount,
        noPowerCount,
        lastReport: {
          hasPower: lastReport.hasPower,
          reportedAt: lastReport.reportedAt,
        },
      });
    } catch (error: any) {
      console.error('[Reports] Error getting queue status:', error.message);
      res.status(500).json({ error: 'Failed to get queue status' });
    }
  });

  app.get('/api/reports/user-stats', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay() + 1);
      weekStart.setHours(0, 0, 0, 0);
      if (now.getDay() === 0) weekStart.setDate(weekStart.getDate() - 7);

      const [totalReports, weeklyReports, streak] = await Promise.all([
        getUserTotalReportCount(userId),
        getUserReportCount(userId, weekStart, now),
        getUserStreak(userId),
      ]);
      const status = getUserStatus(totalReports);

      res.json({
        totalReports,
        weeklyReports,
        totalPoints: totalReports * getPointsForReport(),
        userStatus: status,
        streak,
      });
    } catch (error: any) {
      console.error('[Reports] Error getting user stats:', error.message);
      res.status(500).json({ error: 'Failed to get user stats' });
    }
  });

  app.get('/api/reports/queue-accuracy', async (req, res) => {
    try {
      const { city, queueId } = req.query;
      if (!city || !queueId) {
        return res.status(400).json({ error: 'Missing city or queueId' });
      }
      const stats = await getQueueAccuracyStats(String(city), String(queueId));
      res.json(stats);
    } catch (error: any) {
      console.error('[Reports] Error getting queue accuracy:', error.message);
      res.status(500).json({ error: 'Failed to get queue accuracy' });
    }
  });
}
