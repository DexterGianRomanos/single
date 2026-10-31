// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,https://single-webapp.vercel.app').split(',').map((origin) => origin.trim()).filter(Boolean);

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST']
}));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 15e6, // 15 MB limit for base64 image attachments
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// State Management
let waitingQueue = [];
const activePairs = new Map();
const queueTimeouts = new Map();
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS || 20000);

function clearQueueTimeout(socketId) {
  const timer = queueTimeouts.get(socketId);
  if (timer) {
    clearTimeout(timer);
    queueTimeouts.delete(socketId);
  }
}

function scheduleQueueTimeout(socketId) {
  clearQueueTimeout(socketId);

  const timer = setTimeout(() => {
    waitingQueue = waitingQueue.filter((user) => user.socketId !== socketId);
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('queue_timeout', {
        message: 'No partner found. Please try again.'
      });
    }
    broadcastStats();
    queueTimeouts.delete(socketId);
  }, QUEUE_TIMEOUT_MS);

  queueTimeouts.set(socketId, timer);
}

/**
 * Broadcasts real-time statistics (total connected sockets and current queue size)
 * to all connected clients.
 */
function broadcastStats() {
  io.emit('stats_update', {
    onlineUsers: io.engine.clientsCount,
    queueSize: waitingQueue.length
  });
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Broadcast stats immediately when a client connects
  broadcastStats();

  // ----------------------------------------------------
  // 1. MATCHMAKING QUEUE & FILTERING
  // ----------------------------------------------------
  socket.on('find_chatmate', ({ gender, filterGender, location }) => {
    // Remove user if they were already in queue to avoid duplicate entries
    waitingQueue = waitingQueue.filter((u) => u.socketId !== socket.id);
    clearQueueTimeout(socket.id);

    socket.userProfile = {
      gender: gender || 'Unspecified',
      location: location || 'Unknown Location'
    };

    waitingQueue.push({
      socketId: socket.id,
      gender: socket.userProfile.gender,
      filterGender: filterGender || 'Any',
      location: socket.userProfile.location
    });

    socket.emit('queue_status', { message: 'Searching for a chatmate...' });
    scheduleQueueTimeout(socket.id);

    broadcastStats();
    tryMatchUsers();
  });

  function tryMatchUsers() {
    if (waitingQueue.length < 2) return;

    for (let i = 0; i < waitingQueue.length; i++) {
      for (let j = i + 1; j < waitingQueue.length; j++) {
        const u1 = waitingQueue[i];
        const u2 = waitingQueue[j];

        // Check mutual gender preference compatibility
        const u1AcceptsU2 = u1.filterGender === 'Any' || u1.filterGender === u2.gender;
        const u2AcceptsU1 = u2.filterGender === 'Any' || u2.filterGender === u1.gender;

        if (u1AcceptsU2 && u2AcceptsU1) {
          // Remove matched pair from queue
          waitingQueue.splice(j, 1);
          waitingQueue.splice(i, 1);

          const s1 = io.sockets.sockets.get(u1.socketId);
          const s2 = io.sockets.sockets.get(u2.socketId);

          if (s1 && s2) {
            clearQueueTimeout(u1.socketId);
            clearQueueTimeout(u2.socketId);

            const roomId = `room_${u1.socketId}_${u2.socketId}`;
            s1.join(roomId);
            s2.join(roomId);

            activePairs.set(u1.socketId, { roomId, partnerId: u2.socketId });
            activePairs.set(u2.socketId, { roomId, partnerId: u1.socketId });

            // Send dynamic profile info to respective partners
            io.to(u1.socketId).emit('chat_matched', {
              roomId,
              partnerInfo: { gender: u2.gender, location: u2.location }
            });
            io.to(u2.socketId).emit('chat_matched', {
              roomId,
              partnerInfo: { gender: u1.gender, location: u1.location }
            });

            broadcastStats();
          }

          return tryMatchUsers();
        }
      }
    }
  }

  // ----------------------------------------------------
  // 2. MESSAGING, IMAGES & TYPING INDICATORS
  // ----------------------------------------------------
  socket.on('send_message', ({ roomId, message, image }) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    io.to(roomId).emit('receive_message', {
      senderId: socket.id,
      message,
      image: image || null,
      time
    });
  });

  socket.on('typing', ({ roomId }) => {
    socket.to(roomId).emit('partner_typing', { isTyping: true });
  });

  socket.on('stop_typing', ({ roomId }) => {
    socket.to(roomId).emit('partner_typing', { isTyping: false });
  });

  // ----------------------------------------------------
  // 3. LEAVE CHAT & DISCONNECT HANDLERS
  // ----------------------------------------------------
  socket.on('leave_chat', () => {
    clearQueueTimeout(socket.id);
    handleUserLeave(socket);
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    clearQueueTimeout(socket.id);
    waitingQueue = waitingQueue.filter((u) => u.socketId !== socket.id);
    handleUserLeave(socket);
    broadcastStats();
  });

  function handleUserLeave(sock) {
    clearQueueTimeout(sock.id);
    const pair = activePairs.get(sock.id);
    if (pair) {
      const { roomId, partnerId } = pair;

      // Notify partner
      io.to(partnerId).emit('partner_left', { message: 'Your chatmate has disconnected.' });

      // Leave socket room
      sock.leave(roomId);
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) partnerSocket.leave(roomId);

      // Clear lookup records
      activePairs.delete(sock.id);
      activePairs.delete(partnerId);

      broadcastStats();
    }
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});