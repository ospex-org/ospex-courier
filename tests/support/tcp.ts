import { once } from 'node:events';
import { connect, createServer, type Server, type Socket } from 'node:net';

// A plain TCP relay the tests control, between the courier and its database:
// it passes bytes through until it is cut, and then destroys every connection
// and refuses new ones until it is restored. How "the database stopped" is made
// on purpose. It can also hold: every connection stays up and nothing passes
// either way until it is released, so a request of the courier's stands at its
// next statement for as long as the test says.

export interface TcpRelay {
  port: number;
  cut(): void;
  restore(): void;
  /** Holds every byte, both ways, on every connection, until `release`; the connections stay up. */
  hold(): void;
  release(): void;
  /**
   * The next message a client sends that carries `marker` (a statement's text, such as COMMIT) goes through to the
   * database; the database's answer to it on that connection is dropped, and that connection is cut. So the database
   * has the statement and the client never hears that it did. Resolves once it has cut.
   */
  dropAnswerAfter(marker: string): Promise<void>;
  /**
   * The commands clients have sent through the relay since it started, on every connection: each simple query and
   * each execute of the extended protocol, as PostgreSQL counts a command, BEGIN, COMMIT and ROLLBACK included.
   */
  commands(): number;
  close(): Promise<void>;
}

/** Counts the commands in what a client sends: its startup message first, then typed messages, each a type byte and a length. */
function commandCounter(count: () => void): (chunk: Buffer) => void {
  let started = false;
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (;;) {
      if (!started) {
        if (pending.length < 4) return;
        const length = pending.readInt32BE(0);
        if (pending.length < length) return;
        // An SSL or GSS request (eight bytes) comes before the startup message proper, which is untyped too.
        const request = length === 8;
        pending = pending.subarray(length);
        started = !request;
        continue;
      }
      if (pending.length < 5) return;
      const length = pending.readInt32BE(1);
      if (pending.length < 1 + length) return;
      const type = String.fromCharCode(pending[0] as number);
      if (type === 'Q' || type === 'E') count();
      pending = pending.subarray(1 + length);
    }
  };
}

export async function startTcpRelay(upstreamPort: number): Promise<TcpRelay> {
  const sockets = new Set<Socket>();
  let isCut = false;
  let isHeld = false;
  let dropAfter: { marker: Buffer; done: () => void } | null = null;
  let commands = 0;
  const server: Server = createServer((socket) => {
    if (isCut) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const up = connect(upstreamPort, '127.0.0.1');
    sockets.add(up);
    socket.pipe(up).pipe(socket);
    socket.on('data', commandCounter(() => commands++));
    socket.on('data', (chunk: Buffer) => {
      const armed = dropAfter;
      if (armed === null || !chunk.includes(armed.marker)) return;
      dropAfter = null;
      // The statement has gone up; its answer does not come down. The first bytes of the answer cut the connection.
      up.unpipe(socket);
      up.once('data', () => {
        socket.destroy();
        up.destroy();
        armed.done();
      });
      // Unpiped, the database's side is paused; it flows again so its answer reaches the listener above.
      up.resume();
    });
    if (isHeld) {
      socket.pause();
      up.pause();
    }
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
    hold() {
      isHeld = true;
      for (const s of sockets) s.pause();
    },
    release() {
      isHeld = false;
      for (const s of sockets) s.resume();
    },
    commands: () => commands,
    dropAnswerAfter(marker) {
      return new Promise<void>((resolve) => {
        dropAfter = { marker: Buffer.from(marker, 'utf8'), done: resolve };
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}
