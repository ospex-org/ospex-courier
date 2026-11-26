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
   * On the connection that next sends a message carrying `marker` (a statement's text inside a transaction), the
   * next COMMIT it sends goes through to the database and the database's answer to it is dropped, and that connection
   * is cut. So the transaction commits and its client never hears that it did: a commit's acknowledgement lost after
   * the commit. Other connections are not touched. Resolves once it has cut.
   */
  dropCommitAfter(marker: string): Promise<void>;
  /**
   * The commands clients have sent through the relay since it started, on every connection: each simple query and
   * each execute of the extended protocol, as PostgreSQL counts a command, BEGIN, COMMIT and ROLLBACK included.
   */
  commands(): number;
  /**
   * The notices the database has sent the clients through the relay since the last call, on every connection: each
   * NoticeResponse's message, with the time it passed, in milliseconds since the epoch. They are read as they pass;
   * what the clients receive is not changed.
   */
  takeNotices(): Array<{ at: number; message: string }>;
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

/**
 * Reads the notices in what the database sends a client: its typed messages, each a type byte and a length, after the
 * one untyped byte that answers an SSL or GSS request where the client made one. Each NoticeResponse's message field is
 * handed on; nothing is changed.
 */
function noticeReader(askedFirst: () => boolean, notice: (message: string) => void): (chunk: Buffer) => void {
  let first = true;
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (first && pending.length > 0) {
      first = false;
      if (askedFirst()) pending = pending.subarray(1);
    }
    for (;;) {
      if (pending.length < 5) return;
      const length = pending.readInt32BE(1);
      if (pending.length < 1 + length) return;
      if (pending[0] === 0x4e) {
        // Its fields: a code byte and a zero-terminated text each, ended by a zero byte.
        let at = 5;
        while (at < 1 + length && pending[at] !== 0) {
          const stop = pending.indexOf(0, at + 1);
          if (stop < 0 || stop > length) break;
          if (pending[at] === 0x4d) notice(pending.subarray(at + 1, stop).toString('utf8'));
          at = stop + 1;
        }
      }
      pending = pending.subarray(1 + length);
    }
  };
}

/** A simple query whose text is COMMIT, as pg sends it: the type byte, the length, the text and its terminating zero. */
const COMMIT = Buffer.concat([Buffer.from('Q'), Buffer.from([0, 0, 0, 11]), Buffer.from('COMMIT', 'utf8'), Buffer.from([0])]);

export async function startTcpRelay(upstreamPort: number): Promise<TcpRelay> {
  const sockets = new Set<Socket>();
  let isCut = false;
  let isHeld = false;
  let dropAfter: { marker: Buffer; done: () => void } | null = null;
  let commitAfter: { marker: Buffer; done: () => void } | null = null;
  let commands = 0;
  let notices: Array<{ at: number; message: string }> = [];
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
    // Whether the client opened with an SSL or GSS request, whose answer is one untyped byte before the typed messages.
    let asked: boolean | null = null;
    socket.once('data', (chunk: Buffer) => {
      asked = chunk.length >= 4 && chunk.readInt32BE(0) === 8;
    });
    up.on('data', noticeReader(() => asked === true, (message) => notices.push({ at: Date.now(), message })));
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
    // The commit after a marked statement, on this connection only: the COMMIT goes up, and its answer does not come
    // down. The marker is looked for in what the client sends; the COMMIT after it is the next simple query whose
    // text is COMMIT.
    let markedHere: { done: () => void } | null = null;
    socket.on('data', (chunk: Buffer) => {
      if (markedHere === null) {
        const armed = commitAfter;
        if (armed === null || !chunk.includes(armed.marker)) return;
        commitAfter = null;
        markedHere = { done: armed.done };
        if (!chunk.includes(COMMIT)) return;
      } else if (!chunk.includes(COMMIT)) return;
      const done = markedHere.done;
      markedHere = null;
      up.unpipe(socket);
      up.once('data', () => {
        socket.destroy();
        up.destroy();
        done();
      });
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
    takeNotices() {
      const taken = notices;
      notices = [];
      return taken;
    },
    dropAnswerAfter(marker) {
      return new Promise<void>((resolve) => {
        dropAfter = { marker: Buffer.from(marker, 'utf8'), done: resolve };
      });
    },
    dropCommitAfter(marker) {
      return new Promise<void>((resolve) => {
        commitAfter = { marker: Buffer.from(marker, 'utf8'), done: resolve };
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
