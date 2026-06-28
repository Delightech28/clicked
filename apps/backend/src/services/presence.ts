/**
 * Online presence tracking (#13).
 *
 * Stores userId → socketId mapping in Redis with a 60-second TTL that is
 * refreshed on every heartbeat. Uses a Redis set per userId to support
 * multiple tabs/connections but counting as a single presence entry.
 *
 * - On connect:   add socketId to `presence:{userId}` set, set TTL 60s
 * - On heartbeat: refresh TTL to 60s
 * - On disconnect: remove socketId from set, if set empty → user_offline
 * - GET /users/:id/presence → { online: boolean }
 */
import type { Server } from 'socket.io';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers } from '../db/schema.js';

const PRESENCE_TTL = 60; // seconds

function presenceKey(userId: string): string {
  return `presence:${userId}`;
}

/**
 * Register a socket connection for a user. Adds the socketId to the
 * user's presence set and sets/refreshes the TTL.
 */
export async function setOnline(redis: Redis, userId: string, socketId: string): Promise<void> {
  const key = presenceKey(userId);
  await redis.sadd(key, socketId);
  await redis.expire(key, PRESENCE_TTL);
}

/**
 * Refresh the presence TTL (called on heartbeat).
 */
export async function refreshPresence(redis: Redis, userId: string): Promise<void> {
  const key = presenceKey(userId);
  const exists = await redis.exists(key);
  if (exists) {
    await redis.expire(key, PRESENCE_TTL);
  }
}

/**
 * Remove a socket connection from the user's presence set.
 * Returns true if the user has gone fully offline (no remaining sockets).
 */
export async function setOffline(redis: Redis, userId: string, socketId: string): Promise<boolean> {
  const key = presenceKey(userId);
  await redis.srem(key, socketId);
  const remaining = await redis.scard(key);
  if (remaining === 0) {
    await redis.del(key);
    return true;
  }
  return false;
}

/**
 * Check if a user is currently online.
 */
export async function isOnline(redis: Redis, userId: string): Promise<boolean> {
  const key = presenceKey(userId);
  const count = await redis.scard(key);
  return count > 0;
}

/**
 * Remove any socket IDs in the user's presence set that are no longer
 * connected anywhere in the Socket.IO cluster.
 */
export async function cleanupStaleSockets(
  io: Server,
  redis: Redis,
  userId: string,
  ignoredSocketId?: string,
): Promise<void> {
  const key = presenceKey(userId);
  const socketIds = await redis.smembers(key);
  if (socketIds.length === 0) return;

  await Promise.all(
    socketIds.map(async (sid) => {
      if (ignoredSocketId && sid === ignoredSocketId) return;
      try {
        const sockets = await io.in(sid).fetchSockets();
        if (sockets.length === 0) {
          await redis.srem(key, sid);
        }
      } catch (err) {
        console.warn(`[presence] Failed to check socket status for ${sid}:`, err);
      }
    }),
  );

  const remaining = await redis.scard(key);
  if (remaining === 0) {
    await redis.del(key);
  }
}

/**
 * Rebuild room subscriptions from active Redis socket mappings on gateway boot.
 */
export async function reconcileBoot(io: Server, redis: Redis): Promise<void> {
  let presenceKeys: string[];
  try {
    let cursor = '0';
    presenceKeys = [];
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'presence:*', 'COUNT', 100);
      cursor = nextCursor;
      presenceKeys.push(...keys);
    } while (cursor !== '0');
  } catch {
    presenceKeys = await redis.keys('presence:*');
  }

  for (const key of presenceKeys) {
    const userId = key.slice('presence:'.length);
    if (!userId) continue;

    const socketIds = await redis.smembers(key);
    if (socketIds.length === 0) continue;

    try {
      const memberships = await db.query.conversationMembers.findMany({
        where: eq(conversationMembers.userId, userId),
        columns: { conversationId: true },
      });

      for (const socketId of socketIds) {
        for (const m of memberships) {
          io.in(socketId).socketsJoin(m.conversationId);
        }
      }
    } catch (err) {
      console.warn(`[presence] Failed to rebuild subscriptions for ${userId}:`, err);
    }
  }
}
