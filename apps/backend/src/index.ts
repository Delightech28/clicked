import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { socketAuthMiddleware, type AuthSocket } from './middleware/socketAuth.js';
import { registerMessagingHandlers } from './socket/messaging.js';
import { app } from './app.js';

dotenv.config();

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

io.use(socketAuthMiddleware);

io.on('connection', (socket: AuthSocket) => {
  console.log('User connected:', socket.auth?.userId, socket.id);
  registerMessagingHandlers(io, socket);
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.auth?.userId);
  });
});

const PORT = process.env['PORT'] ?? 3001;
httpServer.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});