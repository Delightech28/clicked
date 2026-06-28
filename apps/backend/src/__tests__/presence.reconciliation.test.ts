import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileBoot, cleanupStaleSockets, setOffline } from '../services/presence.js';

// ── DB mock ────────────────────────────────────────────────────────────────
const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findMany: mockFindMany },
    },
  },
}));

vi.mock('../db/schema.js', () => ({
  conversationMembers: {
    userId: 'userId',
    conversationId: 'conversationId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

// ── Redis & Socket mock ────────────────────────────────────────────────────

describe('Presence Reconciliation & Gateway Boot (#...)', () => {
  let mockRedis: any;
  let mockIo: any;
  let mockSocketsJoin: any;
  let mockFetchSockets: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSocketsJoin = vi.fn();
    mockFetchSockets = vi.fn().mockResolvedValue([]);

    mockIo = {
      in: vi.fn((sid: string) => ({
        socketsJoin: mockSocketsJoin,
        fetchSockets: () => mockFetchSockets(sid),
      })),
    };

    mockRedis = {
      scan: vi.fn(),
      keys: vi.fn(),
      smembers: vi.fn(),
      srem: vi.fn(),
      scard: vi.fn(),
      del: vi.fn(),
    };
  });

  describe('reconcileBoot', () => {
    it('rebuilds room subscriptions from active Redis socket mappings on boot', async () => {
      // redis.scan returns presence keys
      mockRedis.scan
        .mockResolvedValueOnce(['10', ['presence:user-1', 'presence:user-2']])
        .mockResolvedValueOnce(['0', []]);

      mockRedis.smembers.mockImplementation(async (key: string) => {
        if (key === 'presence:user-1') return ['socket-1a', 'socket-1b'];
        if (key === 'presence:user-2') return ['socket-2a'];
        return [];
      });

      mockFindMany.mockImplementation(async ({ where }: any) => {
        if (where.val === 'user-1') {
          return [{ conversationId: 'room-alpha' }, { conversationId: 'room-beta' }];
        }
        if (where.val === 'user-2') {
          return [{ conversationId: 'room-gamma' }];
        }
        return [];
      });

      await reconcileBoot(mockIo as any, mockRedis as any);

      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      expect(mockFindMany).toHaveBeenCalledTimes(2);

      // user-1 sockets joined room-alpha & room-beta
      expect(mockIo.in).toHaveBeenCalledWith('socket-1a');
      expect(mockIo.in).toHaveBeenCalledWith('socket-1b');
      expect(mockIo.in).toHaveBeenCalledWith('socket-2a');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-alpha');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-beta');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-gamma');
    });

    it('falls back to redis.keys if redis.scan throws', async () => {
      mockRedis.scan.mockRejectedValue(new Error('scan not supported'));
      mockRedis.keys.mockResolvedValue(['presence:user-3']);
      mockRedis.smembers.mockResolvedValue(['socket-3a']);
      mockFindMany.mockResolvedValue([{ conversationId: 'room-delta' }]);

      await reconcileBoot(mockIo as any, mockRedis as any);

      expect(mockRedis.keys).toHaveBeenCalledWith('presence:*');
      expect(mockSocketsJoin).toHaveBeenCalledWith('room-delta');
    });
  });

  describe('cleanupStaleSockets', () => {
    it('removes stale socket IDs from Redis presence set and deletes empty sets', async () => {
      mockRedis.smembers.mockResolvedValue(['socket-dead', 'socket-alive']);

      mockFetchSockets.mockImplementation(async (sid: string) => {
        if (sid === 'socket-alive') return [{ id: 'socket-alive' }]; // still connected
        return []; // dead socket
      });

      mockRedis.scard.mockResolvedValue(1);

      await cleanupStaleSockets(mockIo as any, mockRedis as any, 'user-1');

      expect(mockRedis.srem).toHaveBeenCalledWith('presence:user-1', 'socket-dead');
      expect(mockRedis.srem).not.toHaveBeenCalledWith('presence:user-1', 'socket-alive');
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('deletes presence key if all sockets were stale and removed', async () => {
      mockRedis.smembers.mockResolvedValue(['socket-dead-1']);
      mockFetchSockets.mockResolvedValue([]); // dead socket
      mockRedis.scard.mockResolvedValue(0);

      await cleanupStaleSockets(mockIo as any, mockRedis as any, 'user-2');

      expect(mockRedis.srem).toHaveBeenCalledWith('presence:user-2', 'socket-dead-1');
      expect(mockRedis.del).toHaveBeenCalledWith('presence:user-2');
    });

    it('ignores activeSocketId if passed', async () => {
      mockRedis.smembers.mockResolvedValue(['socket-new']);

      await cleanupStaleSockets(mockIo as any, mockRedis as any, 'user-3', 'socket-new');

      expect(mockFetchSockets).not.toHaveBeenCalled();
      expect(mockRedis.srem).not.toHaveBeenCalled();
    });
  });

  describe('setOffline', () => {
    it('removes socket ID and returns true when no sockets remain', async () => {
      mockRedis.scard.mockResolvedValue(0);
      const offline = await setOffline(mockRedis as any, 'user-1', 'socket-1');
      expect(mockRedis.srem).toHaveBeenCalledWith('presence:user-1', 'socket-1');
      expect(mockRedis.del).toHaveBeenCalledWith('presence:user-1');
      expect(offline).toBe(true);
    });

    it('returns false when surviving connections remain', async () => {
      mockRedis.scard.mockResolvedValue(1);
      const offline = await setOffline(mockRedis as any, 'user-1', 'socket-1');
      expect(mockRedis.srem).toHaveBeenCalledWith('presence:user-1', 'socket-1');
      expect(mockRedis.del).not.toHaveBeenCalled();
      expect(offline).toBe(false);
    });
  });
});
