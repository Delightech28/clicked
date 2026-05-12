import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';

export const conversationsRouter = Router();

conversationsRouter.use(requireAuth);

// List all conversations the authenticated user belongs to
conversationsRouter.get('/', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;

  const memberships = await db.query.conversationMembers.findMany({
    where: eq(conversationMembers.userId, userId),
    with: {
      conversation: {
        with: { members: { with: { user: { columns: { id: true, username: true, avatarUrl: true } } } } },
      },
    },
  });

  const result = memberships.map((m) => m.conversation);
  res.json(result);
});
