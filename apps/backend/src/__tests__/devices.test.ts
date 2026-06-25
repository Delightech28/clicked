import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signToken } from '../lib/jwt.js';

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      userDevices: {
        findMany: vi.fn(),
      },
    },
  },
}));

const { devicesRouter } = await import('../routes/devices.js');
const { db } = await import('../db/index.js');

const app = express();
app.use(express.json());
app.use('/devices', devicesRouter);

const USER_ID = 'auth-user-id';
const CURRENT_DEVICE_ID = 'device-web-1';
const TOKEN = signToken({ userId: USER_ID, walletAddress: 'GAUTH', deviceId: CURRENT_DEVICE_ID });
const AUTH_HEADER = `Bearer ${TOKEN}`;

const CREATED_AT = new Date('2026-05-31T12:00:00.000Z');
const LAST_SEEN_AT = new Date('2026-06-20T08:30:00.000Z');
const REVOKED_AT = new Date('2026-06-10T09:00:00.000Z');

// As the DB orders them: active devices first, then revoked.
const ROWS = [
  {
    id: 'row-1',
    deviceId: CURRENT_DEVICE_ID,
    deviceName: 'Chrome on Mac',
    platform: 'web',
    lastSeenAt: LAST_SEEN_AT,
    createdAt: CREATED_AT,
    revokedAt: null,
  },
  {
    id: 'row-2',
    deviceId: 'device-ios-1',
    deviceName: 'iPhone',
    platform: 'ios',
    lastSeenAt: null,
    createdAt: CREATED_AT,
    revokedAt: null,
  },
  {
    id: 'row-3',
    deviceId: 'device-android-old',
    deviceName: 'Old Pixel',
    platform: 'android',
    lastSeenAt: null,
    createdAt: CREATED_AT,
    revokedAt: REVOKED_AT,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /devices', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/devices');
    expect(res.status).toBe(401);
  });

  it('returns 401 when the token is invalid', async () => {
    const res = await request(app).get('/devices').set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  it('scopes the query to the authenticated user only', async () => {
    vi.mocked(db.query.userDevices.findMany).mockResolvedValue([] as never);

    await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    const arg = vi.mocked(db.query.userDevices.findMany).mock.calls[0]?.[0];
    expect(arg).toBeDefined();
    expect(arg).toHaveProperty('where');
    expect(arg).toHaveProperty('orderBy');
  });

  it('returns the devices including revoked ones, preserving active-first order', async () => {
    vi.mocked(db.query.userDevices.findMany).mockResolvedValue(ROWS as never);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((d: { id: string }) => d.id)).toEqual(['row-1', 'row-2', 'row-3']);

    // Revoked device is present with its revokedAt timestamp set.
    expect(res.body[2].revokedAt).toBe(REVOKED_AT.toISOString());
    expect(res.body[0].revokedAt).toBeNull();
  });

  it('flags only the device from the caller JWT as current', async () => {
    vi.mocked(db.query.userDevices.findMany).mockResolvedValue(ROWS as never);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ deviceId: CURRENT_DEVICE_ID, current: true });
    expect(res.body[1].current).toBe(false);
    expect(res.body[2].current).toBe(false);
  });

  it('marks every device not-current when the JWT carries no deviceId', async () => {
    vi.mocked(db.query.userDevices.findMany).mockResolvedValue(ROWS as never);
    const tokenNoDevice = signToken({ userId: USER_ID, walletAddress: 'GAUTH' });

    const res = await request(app).get('/devices').set('Authorization', `Bearer ${tokenNoDevice}`);

    expect(res.status).toBe(200);
    expect(res.body.every((d: { current: boolean }) => d.current === false)).toBe(true);
  });

  it('returns the exact response shape with no leaked internal fields', async () => {
    vi.mocked(db.query.userDevices.findMany).mockResolvedValue([
      { ...ROWS[0], userId: USER_ID, identityPublicKey: 'SECRET', registrationId: 42 },
    ] as never);

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body[0]).sort()).toEqual(
      [
        'createdAt',
        'current',
        'deviceId',
        'deviceName',
        'id',
        'lastSeenAt',
        'platform',
        'revokedAt',
      ].sort(),
    );
    expect(res.body[0]).not.toHaveProperty('userId');
    expect(res.body[0]).not.toHaveProperty('identityPublicKey');
    expect(res.body[0]).not.toHaveProperty('registrationId');
  });

  it('returns 500 when the database query fails', async () => {
    vi.mocked(db.query.userDevices.findMany).mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/devices').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to list devices' });
  });
});
