import { isAddress, type Address } from 'viem';

// The courier's settings, read from the environment. Every problem is listed
// at once, and no value is ever echoed: a problem names the setting and what
// is wrong with it.
//
// This is the first build's list: the database, the node, where the set is,
// the low-wallet mark and the port. The key's three settings
// (COURIER_KEYSTORE_JSON, COURIER_KEYSTORE_PASSWORD, COURIER_ADDRESS) arrive
// with the sender, which is the build that first holds a key.

export interface CourierConfig {
  /** The courier's own Postgres. */
  databaseUrl: string;
  /** The node. https anywhere; plain http only to this machine, where the tests run a local chain. */
  rpcUrl: string;
  /** The signpost, and the betting entry's number on it: where the set is. */
  signpostAddress: Address;
  bettingEntryId: bigint;
  /** Under this many POL the key's wallet is reported low. 3 unless set. */
  lowPol: number;
  port: number;
  /**
   * The file holding the certificate authority the database is verified
   * against, when it is not the pinned db/database-ca.pem: a test authority.
   * It can name another authority and nothing else; verification is never off.
   */
  databaseCaFile?: string;
}

export type ConfigResult = { ok: true; config: CourierConfig } | { ok: false; problems: string[] };

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** https anywhere; plain http only to this machine. */
export function isAcceptableRpcUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function isPostgresUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export const DEFAULT_LOW_POL = 3;

/** Validates the courier's settings and names what is wrong. Never echoes a value. */
export function readCourierConfig(env: Record<string, string | undefined>): ConfigResult {
  const problems: string[] = [];
  const get = (name: string) => (env[name] ?? '').trim();

  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl === '') problems.push('DATABASE_URL is not set');
  else if (!isPostgresUrl(databaseUrl)) problems.push('DATABASE_URL must be a postgres:// URL');

  const rpcUrl = get('POLYGON_RPC_URL');
  if (rpcUrl === '') problems.push('POLYGON_RPC_URL is not set');
  else if (!isAcceptableRpcUrl(rpcUrl)) problems.push('POLYGON_RPC_URL must be an https:// URL (plain http only to this machine, for a local chain)');

  const signpostAddress = get('SIGNPOST_ADDRESS');
  if (signpostAddress === '') problems.push('SIGNPOST_ADDRESS is not set');
  else if (!isAddress(signpostAddress)) problems.push('SIGNPOST_ADDRESS is not an address');

  const entryText = get('BETTING_ENTRY_ID');
  if (entryText === '') problems.push('BETTING_ENTRY_ID is not set');
  else if (!/^[0-9]{1,18}$/.test(entryText)) problems.push('BETTING_ENTRY_ID must be a whole number: the betting entry\'s place on the signpost');

  const lowPolText = get('COURIER_LOW_POL');
  let lowPol = DEFAULT_LOW_POL;
  if (lowPolText !== '') {
    if (!/^[0-9]{1,9}(\.[0-9]{1,18})?$/.test(lowPolText)) problems.push('COURIER_LOW_POL must be a number of POL, such as 3 or 2.5');
    else lowPol = Number(lowPolText);
  }

  // 0 is a port too: any free one, which is how the tests start the process beside one another.
  const portText = get('PORT');
  const port = Number(portText);
  if (portText === '') problems.push('PORT is not set');
  else if (!/^[0-9]{1,5}$/.test(portText) || port > 65535) problems.push('PORT must be a whole number from 0 to 65535');

  const databaseCaFile = get('DATABASE_CA_FILE');

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      databaseUrl,
      rpcUrl,
      signpostAddress: signpostAddress as Address,
      bettingEntryId: BigInt(entryText),
      lowPol,
      port,
      ...(databaseCaFile === '' ? {} : { databaseCaFile }),
    },
  };
}
