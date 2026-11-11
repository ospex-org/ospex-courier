import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';

// A TLS front for the test Postgres, so the store's certificate check is
// proved against a test authority: the front holds a server certificate
// issued by authority A for "localhost", answers the client's SSLRequest with
// "S", completes the TLS handshake, and pipes the plain bytes to the real
// server. The store, given authority A, connects; given authority B, it is
// refused. The certificates are made with openssl when the test runs, and
// live only in a temporary folder.

export interface TestAuthorities {
  /** Authority A, which issued the front's certificate: PEM. */
  authorityA: string;
  /** Authority B, which issued nothing the front presents: PEM. */
  authorityB: string;
  serverCert: string;
  serverKey: string;
  /** A certificate from A for another name, for the hostname check. */
  otherNameCert: string;
  otherNameKey: string;
  dir: string;
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Makes the two authorities and the server certificate. Needs `openssl` on the PATH; fails, and does not skip, without it. */
export function makeAuthorities(): TestAuthorities {
  const dir = mkdtempSync(join(tmpdir(), 'courier-tls-'));
  const ten_years = '3650';
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'a.key', '-out', 'a.pem', '-days', ten_years, '-subj', '/CN=Courier test authority A'], dir);
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'b.key', '-out', 'b.pem', '-days', ten_years, '-subj', '/CN=Courier test authority B'], dir);
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n');
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost'], dir);
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'a.pem', '-CAkey', 'a.key', '-CAcreateserial', '-out', 'server.pem', '-days', ten_years, '-extfile', 'server.ext'], dir);
  writeFileSync(join(dir, 'other.ext'), 'subjectAltName=DNS:database.example\nbasicConstraints=CA:FALSE\n');
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.key', '-out', 'other.csr', '-subj', '/CN=database.example'], dir);
  openssl(['x509', '-req', '-in', 'other.csr', '-CA', 'a.pem', '-CAkey', 'a.key', '-CAcreateserial', '-out', 'other.pem', '-days', ten_years, '-extfile', 'other.ext'], dir);
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  return {
    authorityA: read('a.pem'),
    authorityB: read('b.pem'),
    serverCert: read('server.pem'),
    serverKey: read('server.key'),
    otherNameCert: read('other.pem'),
    otherNameKey: read('other.key'),
    dir,
  };
}

const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 0xd2, 0x16, 0x2f]);

export interface TlsFront {
  port: number;
  /** How many connections completed a TLS handshake. */
  handshakes: number;
  close(): Promise<void>;
}

/** A TLS front on a free port, presenting `cert`, piping to the plain Postgres at `upstreamPort` on this machine. */
export async function startTlsFront(upstreamPort: number, cert: string, key: string): Promise<TlsFront> {
  const front = { port: 0, handshakes: 0 } as TlsFront;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', (first: Buffer) => {
      if (!first.subarray(0, 8).equals(SSL_REQUEST)) {
        // Not a TLS request: a plain connection is refused by the front, which exists to present a certificate.
        socket.end('N');
        return;
      }
      socket.write('S');
      const tls = new TLSSocket(socket, { isServer: true, cert, key });
      tls.on('error', () => tls.destroy());
      tls.once('secure', () => {
        front.handshakes++;
        const up = netConnect(upstreamPort, '127.0.0.1');
        up.on('error', () => tls.destroy());
        tls.pipe(up).pipe(tls);
        up.once('close', () => tls.destroy());
        tls.once('close', () => up.destroy());
      });
    });
    socket.on('error', () => socket.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  front.port = typeof address === 'object' && address !== null ? address.port : 0;
  front.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return front;
}
