import type { Express } from "express";
import { isAuthenticated } from "./replit_integrations/auth";
import { isAuthenticatedMobileOrSession } from "./mobile-auth";
import {
  getUserLocations,
  getUserLocation,
  createUserLocation,
  updateUserLocation,
  deleteUserLocation,
  migrateUserSettingsToLocation,
  reorderUserLocations,
  generateShareId,
  removeShareId,
  getLocationByShareId,
} from "./storage-locations";
import { broadcastSettingsToUser } from "./routes";
import { ensureSeedDataForQueue } from "./storage-reports";

export function registerLocationRoutes(app: Express) {
  app.get('/api/user/locations', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      await migrateUserSettingsToLocation(userId);

      const locations = await getUserLocations(userId);
      res.json(locations);
    } catch (error: any) {
      console.error('[Locations] Error getting locations:', error.message);
      res.status(500).json({ error: 'Failed to get locations' });
    }
  });

  app.post('/api/user/locations', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { name, city, lookupMode, street, houseNumber, queueId, isPrimary, notifyEnabled, notifyBeforeOff, notifyBeforeOn, telegramNotify } = req.body;

      if (!name || typeof name !== 'string' || name.length > 100) {
        return res.status(400).json({ error: 'Invalid name' });
      }

      const location = await createUserLocation({
        userId,
        name: name.trim(),
        city: city || 'Вінниця',
        lookupMode: lookupMode || 'queue',
        street: street || '',
        houseNumber: houseNumber || '',
        queueId: queueId || '',
        isPrimary: isPrimary || false,
        notifyEnabled: notifyEnabled !== false,
        notifyBeforeOff: notifyBeforeOff || 30,
        notifyBeforeOn: notifyBeforeOn || 15,
        telegramNotify: telegramNotify !== false,
      });

      if (queueId) {
        ensureSeedDataForQueue(city || 'Вінниця', queueId).catch(e =>
          console.error('[Seed] Error seeding for new location:', e.message)
        );
      }

      const allLocations = await getUserLocations(userId);
      broadcastSettingsToUser(userId, { locations: allLocations }, req.body._tabId);

      res.json(location);
    } catch (error: any) {
      if (error.message === 'Maximum 5 locations allowed') {
        return res.status(400).json({ error: 'Максимум 5 локацій' });
      }
      console.error('[Locations] Error creating location:', error.message);
      res.status(500).json({ error: 'Failed to create location' });
    }
  });

  app.put('/api/user/locations/:id', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const existing = await getUserLocation(id, userId);
      if (!existing) return res.status(404).json({ error: 'Location not found' });

      const allowed: Record<string, string> = {
        name: 'string', city: 'string', lookupMode: 'string',
        street: 'string', houseNumber: 'string', queueId: 'string',
      };
      const boolFields = ['isPrimary', 'notifyEnabled', 'telegramNotify'];
      const numFields = ['notifyBeforeOff', 'notifyBeforeOn', 'orderIndex'];

      const data: Record<string, any> = {};
      for (const [key, type] of Object.entries(allowed)) {
        if (key in req.body && typeof req.body[key] === type) data[key] = req.body[key];
      }
      for (const key of boolFields) {
        if (key in req.body && typeof req.body[key] === 'boolean') data[key] = req.body[key];
      }
      for (const key of numFields) {
        if (key in req.body && typeof req.body[key] === 'number') data[key] = req.body[key];
      }

      const location = await updateUserLocation(id, userId, data);

      const allLocations = await getUserLocations(userId);
      broadcastSettingsToUser(userId, { locations: allLocations }, req.body._tabId);

      res.json(location);
    } catch (error: any) {
      console.error('[Locations] Error updating location:', error.message);
      res.status(500).json({ error: 'Failed to update location' });
    }
  });

  app.delete('/api/user/locations/:id', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const currentLocations = await getUserLocations(userId);
      if (currentLocations.length <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last location', code: 'LAST_LOCATION' });
      }

      await deleteUserLocation(id, userId);

      const allLocations = await getUserLocations(userId);
      broadcastSettingsToUser(userId, { locations: allLocations }, req.body?._tabId);

      res.json({ success: true });
    } catch (error: any) {
      console.error('[Locations] Error deleting location:', error.message);
      res.status(500).json({ error: 'Failed to delete location' });
    }
  });

  app.put('/api/user/locations-reorder', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const { orderedIds } = req.body;
      if (!Array.isArray(orderedIds) || orderedIds.some((id: any) => typeof id !== 'number')) {
        return res.status(400).json({ error: 'Invalid orderedIds' });
      }

      await reorderUserLocations(userId, orderedIds);

      const allLocations = await getUserLocations(userId);
      broadcastSettingsToUser(userId, { locations: allLocations }, req.body._tabId);

      res.json({ success: true });
    } catch (error: any) {
      console.error('[Locations] Error reordering locations:', error.message);
      res.status(500).json({ error: 'Failed to reorder locations' });
    }
  });

  app.post('/api/user/locations/:id/share', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const shareId = await generateShareId(id, userId);
      res.json({ shareId, url: `/s/${shareId}` });
    } catch (error: any) {
      console.error('[Locations] Error generating share link:', error.message);
      res.status(500).json({ error: 'Failed to generate share link' });
    }
  });

  app.delete('/api/user/locations/:id/share', isAuthenticatedMobileOrSession, async (req: any, res) => {
    try {
      const userId = req.user?.claims?.sub;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      await removeShareId(id, userId);
      res.json({ success: true });
    } catch (error: any) {
      console.error('[Locations] Error removing share link:', error.message);
      res.status(500).json({ error: 'Failed to remove share link' });
    }
  });

  app.post('/api/compare/share', async (req, res) => {
    try {
      const { locations, ttlDays = 7 } = req.body;
      if (!Array.isArray(locations) || locations.length < 2 || locations.length > 5) {
        return res.status(400).json({ error: 'Need 2-5 locations' });
      }
      const days = Math.min(Math.max(Number(ttlDays) || 7, 1), 30);
      const compact = locations.map((l: any) => ({
        n: l.name, c: l.city, q: l.queueId,
        s: l.street || undefined, h: l.houseNumber || undefined,
      }));
      const { nanoid } = await import('nanoid');
      const shareId = nanoid(8);
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const { db } = await import('./db');
      const { compareShares } = await import('../shared/models/compare-shares');
      await db.insert(compareShares).values({
        shareId,
        data: JSON.stringify(compact),
        expiresAt,
      });
      res.json({ shareId, url: `/c/${shareId}` });
    } catch (error: any) {
      console.error('[Compare] Error creating share link:', error.message);
      res.status(500).json({ error: 'Failed to create compare link' });
    }
  });

  app.get('/api/compare/data/:shareId', async (req, res) => {
    try {
      const { shareId } = req.params;
      if (!shareId || shareId.length < 6 || shareId.length > 16) {
        return res.status(400).json({ error: 'Invalid share ID' });
      }
      const { db } = await import('./db');
      const { compareShares } = await import('../shared/models/compare-shares');
      const { eq } = await import('drizzle-orm');
      const [row] = await db.select().from(compareShares).where(eq(compareShares.shareId, shareId)).limit(1);
      if (!row) return res.status(404).json({ error: 'not_found' });
      if (new Date() > row.expiresAt) return res.status(410).json({ error: 'expired', expiresAt: row.expiresAt.toISOString() });
      const decoded = JSON.parse(row.data);
      const locations = decoded.map((l: any) => ({
        name: l.n, city: l.c, queueId: l.q,
        street: l.s || undefined, houseNumber: l.h || undefined,
      }));
      res.json({ locations, expiresAt: row.expiresAt.toISOString() });
    } catch (error: any) {
      console.error('[Compare] Error fetching share:', error.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/share/:shareId', async (req, res) => {
    try {
      const { shareId } = req.params;
      if (!shareId || shareId.length < 8 || shareId.length > 32) {
        return res.status(400).json({ error: 'Invalid share ID' });
      }

      const loc = await getLocationByShareId(shareId);
      if (!loc) return res.status(404).json({ error: 'Not found' });

      res.json({
        name: loc.name,
        city: loc.city,
        queueId: loc.queueId,
        street: loc.street || undefined,
        houseNumber: loc.houseNumber || undefined,
      });
    } catch (error: any) {
      console.error('[Share] Error fetching shared location:', error.message);
      res.status(500).json({ error: 'Server error' });
    }
  });
}
