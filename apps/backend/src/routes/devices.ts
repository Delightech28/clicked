import { Router, type Router as RouterType } from 'express';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userDevices } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';

export const devicesRouter: RouterType = Router();

devicesRouter.use(requireAuth);

// GET /devices — list the caller's own devices.
//
// Returns every device registered to the authenticated user, including revoked
// ones (with `revokedAt` set) so clients can show device history. Active devices
// are listed first, then most recently registered. The device whose id is bound
// to the caller's JWT is flagged with `current: true`.
devicesRouter.get('/', async (req: AuthRequest, res) => {
  const { userId, deviceId: currentDeviceId } = req.auth!;

  try {
    const devices = await db.query.userDevices.findMany({
      where: eq(userDevices.userId, userId),
      columns: {
        id: true,
        deviceId: true,
        deviceName: true,
        platform: true,
        lastSeenAt: true,
        createdAt: true,
        revokedAt: true,
      },
      // Active devices (revoked_at IS NULL) first, then newest registration first.
      orderBy: [
        sql`case when ${userDevices.revokedAt} is null then 0 else 1 end`,
        desc(userDevices.createdAt),
      ],
    });

    res.json(
      devices.map((device) => ({
        id: device.id,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        platform: device.platform,
        lastSeenAt: device.lastSeenAt,
        createdAt: device.createdAt,
        revokedAt: device.revokedAt,
        current: currentDeviceId !== undefined && device.deviceId === currentDeviceId,
      })),
    );
  } catch {
    res.status(500).json({ error: 'Failed to list devices' });
  }
});
