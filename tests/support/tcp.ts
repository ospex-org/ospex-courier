import { once } from 'node:events';
import { connect, createServer, type Server, type Socket } from 'node:net';

// A plain TCP relay the tests control, between the courier and its database:
// it passes bytes through until it is cut, and then destroys every connection
// and refuses new ones until it is restored. How "the database stopped" is made
// on purpose.

export interface TcpRelay {
  port: number;
  cut(): void;
  restore(): void;
  close(): Promise<void>;
}

export async function startTcpRelay(upstreamPort: number): Promise<TcpRelay> {
  const sockets = new Set<Socket>();
  let isCut = false;
  const server: Server = createServer((socket) => {
    if (isCut) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const up = connect(upstreamPort, '127.0.0.1');
    sockets.add(up);
    socket.pipe(up).pipe(socket);
    const drop = () => {
      sockets.delete(socket);
      sockets.delete(up);
      socket.destroy();
      up.destroy();
    };
    socket.on('error', drop);
    up.on('error', drop);
    socket.once('close', drop);
    up.once('close', drop);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    cut() {
      isCut = true;
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    restore() {
      isCut = false;
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}
