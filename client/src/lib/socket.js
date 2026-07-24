// Single shared socket connection per page. We rely on Vite's dev proxy
// to forward /socket.io to the Express server in dev, and on the same
// origin in production.

import { io } from 'socket.io-client';

let socket = null;
export function getSocket() {
  if (!socket) {
    socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });
  }
  return socket;
}

// Convenience: dispatch a game action and optionally await the server's ack.
export function sendAction(type, data) {
  return new Promise((resolve) => {
    getSocket().emit('action', { type, data }, (res) => resolve(res || {}));
  });
}
