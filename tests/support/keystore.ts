import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { bytesToHex, concat, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';

// The test keystore: every keystore made here is made by the run, at test time,
// from one of the local chain's published test accounts (its public test
// words), under a password the run makes. It is handed to the courier under
// test in its own process's settings, and is never written to a file, printed
// or put in any evidence.

/** The local chain's own published test words: its accounts hold the local chain's coin and nothing else, anywhere. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

/**
 * A Web3 Secret Storage v3 keystore holding `plaintext` (32 bytes, normally a private key): scrypt and
 * AES-128-CTR, the MAC the keccak256 of the derived key's second half and the ciphertext. `over` replaces fields at
 * the top, for a case that needs a keystore of another shape.
 */
export function encryptForTest(plaintext: Hex, password: string, over: Record<string, unknown> = {}): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = scryptSync(Buffer.from(password, 'utf8'), salt, 32, { N: 8192, r: 8, p: 1 });
  const cipher = createCipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext.slice(2), 'hex')), cipher.final()]);
  const mac = keccak256(concat([bytesToHex(derived.subarray(16, 32)), bytesToHex(ciphertext)])).slice(2);
  return JSON.stringify({
    version: 3,
    id: 'made-by-the-test-run',
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams: { dklen: 32, n: 8192, p: 1, r: 8, salt: salt.toString('hex') },
      mac,
    },
    ...over,
  });
}

/** The private key of the local chain's test account at this index of its public words. */
export function testAccountKey(index: number): Hex {
  const key = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: index }).getHdKey().privateKey;
  if (key === null) throw new Error(`the test words gave no key at index ${index}`);
  return toHex(key);
}

/** The test account's index for an address, among the first 200 the rig uses; null for any other address. */
function indexOf(address: Address): number | null {
  const wanted = getAddress(address);
  for (let i = 0; i < 200; i++) if (mnemonicToAccount(TEST_MNEMONIC, { addressIndex: i }).address === wanted) return i;
  return null;
}

export interface TestKeystore {
  json: string;
  password: string;
}

/** The run's one password, made once: random, so no value of it is written anywhere a reader could take it from. */
const PASSWORD = randomBytes(18).toString('base64url');

const made = new Map<string, TestKeystore>();

/**
 * The keystore for the test account with this address, made once a run and kept in this process's memory only. Null
 * for an address that is not one of the local chain's test accounts: such an address has no key the run can make.
 */
export function testKeystoreFor(address: Address): TestKeystore | null {
  const k = getAddress(address);
  const known = made.get(k);
  if (known !== undefined) return known;
  const index = indexOf(k);
  if (index === null) return null;
  const store = { json: encryptForTest(testAccountKey(index), PASSWORD), password: PASSWORD };
  made.set(k, store);
  return store;
}
