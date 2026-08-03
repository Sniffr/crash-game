import { WebSocket } from 'ws';

/** ws lookup by sessionId so auto-cashout can notify the right tabs. */
export const sessionSockets = new Map<string, Set<WebSocket>>();
export const clients = new Set<WebSocket>();

// ─── WS broadcast helpers ────────────────────────────────────────────────────
export function broadcast(message: Record<string, unknown>) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

export function sendToSession(sessionId: string, message: Record<string, unknown>) {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  const data = JSON.stringify(message);
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

export function safeSend(ws: WebSocket, message: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
