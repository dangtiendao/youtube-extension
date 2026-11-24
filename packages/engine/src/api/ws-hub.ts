import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { WsEvent } from '@tubevault/shared';

export class WsHub {
  private readonly wss: WebSocketServer;

  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
  }

  attach(
    server: http.Server,
    validateUpgrade: (req: http.IncomingMessage, url: URL) => boolean,
    onClientConnected?: (ws: WebSocket) => void
  ): void {
    server.on('upgrade', (req, socket, head) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname !== '/ws' || !validateUpgrade(req, url)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
          onClientConnected?.(ws);
        });
      } catch {
        socket.destroy();
      }
    });
  }

  broadcast(event: WsEvent): void {
    if (this.wss.clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  sendTo(ws: WebSocket, event: WsEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  close(): void {
    for (const client of this.wss.clients) {
      client.close();
    }
    this.wss.close();
  }
}
