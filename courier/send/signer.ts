import { createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import { bytesToHex, concat, encodeFunctionData, getAddress, isAddressEqual, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { RELAY_ABI } from '../chain/abi';
import { orderHash } from '../orders/order';
import type { SealedSend } from '../check/precheck';

// The one place that holds the courier's key. The keystore is opened here at
// start, the key turned into a signing account at once, and only that account
// kept, inside this module's closure: nothing that opens the keystore, nothing
// that holds the key and no account leaves this file. What leaves it is one
// function, signCross, which signs one thing: a Cross, to the relay, carrying no
// coin, built from the orders the pre-check verified and sealed, at the nonce,
// gas and fees the send step chose. It reads nothing from the database. A test
// can reach inside its path only through the seams the tests' start file passes.
//
// The keystore: Web3 Secret Storage v3, scrypt and AES-128-CTR, the MAC the
// keccak256 of the derived key's second half and the ciphertext, the format a
// Foundry `cast wallet new` writes. Node's own crypto does the work, so no
// keystore library is added.

/** The selector of cross on the relay: the matching contract's own, the relay declaring it with the same types. */
export const CROSS_SELECTOR: Hex = '0x84075346';

/** Why the keystore was refused: unreadable, the wrong password, or a key whose address is not COURIER_ADDRESS. */
export type KeystoreProblem = 'unreadable' | 'wrong-password' | 'not-the-address';

export class KeystoreRefused extends Error {
  constructor(
    message: string,
    readonly problem: KeystoreProblem = 'unreadable',
  ) {
    super(message);
    this.name = 'KeystoreRefused';
  }
}

/** The signer refused to sign, or found its own signed bytes not what it was asked to sign: the courier's own fault. Nothing it made is kept. */
export class SignatureRefused extends Error {
  constructor(readonly check: string) {
    super(`the signer refused: ${check}`);
    this.name = 'SignatureRefused';
  }
}

const hexBytes = (v: unknown, name: string): Buffer => {
  if (typeof v !== 'string' || !/^(0x)?([0-9a-fA-F]{2})+$/.test(v)) throw new KeystoreRefused(`keystore: ${name} is not hex`);
  return Buffer.from(v.replace(/^0x/, ''), 'hex');
};

/** The keystore opened to its 32 bytes. Refuses anything but v3, scrypt and AES-128-CTR. Module-private. */
function decryptKeystore(json: string, password: string): Hex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new KeystoreRefused('keystore: not valid JSON');
  }
  const ks = parsed as Record<string, unknown>;
  if (ks.version !== 3) throw new KeystoreRefused('keystore: only version 3 is supported');
  const crypto = (ks.crypto ?? ks.Crypto) as Record<string, unknown> | undefined;
  if (typeof crypto !== 'object' || crypto === null) throw new KeystoreRefused('keystore: crypto section missing');
  if (crypto.cipher !== 'aes-128-ctr') throw new KeystoreRefused('keystore: only aes-128-ctr is supported');
  if (crypto.kdf !== 'scrypt') throw new KeystoreRefused('keystore: only the scrypt KDF is supported');
  const params = crypto.kdfparams as Record<string, unknown> | undefined;
  const n = params?.n;
  const r = params?.r;
  const p = params?.p;
  const dklen = params?.dklen;
  if (
    typeof n !== 'number' || typeof r !== 'number' || typeof p !== 'number' || typeof dklen !== 'number' ||
    !Number.isInteger(n) || n < 2 || (n & (n - 1)) !== 0 || n > 2 ** 20 ||
    !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16 || dklen !== 32
  ) {
    throw new KeystoreRefused('keystore: scrypt parameters are missing or out of range');
  }
  const salt = hexBytes(params?.salt, 'kdfparams.salt');
  const iv = hexBytes((crypto.cipherparams as Record<string, unknown> | undefined)?.iv, 'cipherparams.iv');
  const ciphertext = hexBytes(crypto.ciphertext, 'ciphertext');
  const mac = hexBytes(crypto.mac, 'mac');
  if (iv.length !== 16) throw new KeystoreRefused('keystore: iv must be 16 bytes');
  if (ciphertext.length !== 32) throw new KeystoreRefused('keystore: ciphertext must be 32 bytes');
  if (mac.length !== 32) throw new KeystoreRefused('keystore: mac must be 32 bytes');
  // Raw UTF-8 bytes, no Unicode normalisation: what Foundry's keystore writer hashes.
  const derived = scryptSync(Buffer.from(password, 'utf8'), salt, dklen, { N: n, r, p, maxmem: 128 * n * r * p + 64 * 1024 * 1024 });
  const expectedMac = Buffer.from(keccak256(concat([bytesToHex(derived.subarray(16, 32)), bytesToHex(ciphertext)])).slice(2), 'hex');
  if (!timingSafeEqual(expectedMac, mac)) throw new KeystoreRefused('keystore: wrong password, or the keystore is corrupt (MAC mismatch)', 'wrong-password');
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), iv);
  return bytesToHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/** The keystore opened and turned into an account at once; the key's bytes go no further. Module-private. */
function openAccount(keystoreJson: string, password: string, expected: Address): PrivateKeyAccount {
  const key = decryptKeystore(keystoreJson, password);
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(key);
  } catch {
    // The curve library's error for bytes outside the valid key range quotes them as a number: neither its message
    // nor the error itself is kept.
    throw new KeystoreRefused('keystore: the decrypted bytes are not a valid private key');
  }
  if (!isAddressEqual(account.address, expected)) {
    throw new KeystoreRefused('COURIER_KEYSTORE_JSON holds a key whose address is not COURIER_ADDRESS; the courier will not sign with it', 'not-the-address');
  }
  return account;
}

/** The fields of a signed Cross, as the signer decoded them from its own bytes. */
export interface SignedFields {
  from: Address;
  to: Address;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: bigint;
}

/** A signed Cross: its bytes, which live in memory only until the hand-off, its hash and its fields. */
export interface SignedCross {
  raw: Hex;
  hash: Hex;
  fields: SignedFields;
}

/** The envelope the signer builds, which the tests' seam may change before the checks; production passes no seam. */
export interface Envelope {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** The seams inside the signing path, passed by the tests' start file only. */
export interface SignerSeams {
  /** Told of the object the send step passes, before any check: a test may hand on another in its place. */
  handed?: (checked: unknown) => unknown;
  /** Told of the envelope built with every input valid: a test may change its target or its value. */
  envelope?: (e: Envelope) => Envelope;
  /** Told of every signed attempt's bytes, at once, before the signer reads them back. */
  signed?: (raw: Hex) => void;
}

export interface SignerDeps {
  keystoreJson: string;
  keystorePassword: string;
  /** COURIER_ADDRESS: the address the opened key must have. */
  address: Address;
  /** The relay read from the signpost at start: the one target. */
  relay: Address;
  /** The matching contract: the orders' domain. */
  matching: Address;
  chainId: bigint;
  /** The mark only the pre-check's module gives a sealed send. */
  isSealed: (x: unknown) => x is SealedSend;
  /** The lane's epoch and the reservation it holds now, from this process's own memory; null where it holds none. */
  laneNow: () => { epoch: bigint; reservation: bigint } | null;
  seams?: SignerSeams;
}

export interface Signer {
  address: Address;
  /** Signs the one Cross the sealed send describes, or throws SignatureRefused. */
  signCross(checked: SealedSend): Promise<SignedCross>;
}

/** Opens the keystore and returns the signer, whose one signing entry is signCross. Throws KeystoreRefused. */
export function openSigner(deps: SignerDeps): Signer {
  const account = openAccount(deps.keystoreJson, deps.keystorePassword, deps.address);
  // What signing needs, taken now, and nothing else: the settings themselves, the keystore and its password among
  // them, are not kept, so that only the account outlives the opening.
  const seams = deps.seams ?? {};
  const relay = getAddress(deps.relay);
  const matching = deps.matching;
  /** The set's chain, as the orders' domain and the signed fields name it. */
  const setChain = deps.chainId;
  /** The same chain as the envelope numbers it. */
  const chainId = Number(setChain);
  const isSealed = deps.isSealed;
  const laneNow = deps.laneNow;
  return {
    address: account.address,
    async signCross(given) {
      const checked = seams.handed === undefined ? given : (seams.handed(given) as SealedSend);
      // 1. The mark: an object the pre-check sealed, in this process, and nothing shaped like one.
      if (!isSealed(checked)) throw new SignatureRefused('the object is not a send the pre-check sealed');
      // 2. The lane now: the epoch and the reservation the snapshot was made under.
      const now = laneNow();
      if (now === null || now.epoch !== checked.epoch || now.reservation !== checked.reservation) throw new SignatureRefused('the sealed send is not of the lane\'s current epoch and reservation');
      // 3. Every order hashes to the hash it carries.
      for (const o of [checked.taking, ...checked.resting]) {
        if (orderHash(o.order, setChain, matching).toLowerCase() !== o.hash.toLowerCase()) throw new SignatureRefused('an order no longer hashes to the hash it carries');
      }
      // 4. The calldata, built here from those orders with the pinned ABI's cross, is the calldata the pre-check proved.
      const data = encodeFunctionData({ abi: RELAY_ABI, functionName: 'cross', args: [{ order: checked.taking.order, signature: checked.taking.signature }, checked.resting.map((o) => ({ order: o.order, signature: o.signature }))] } as never);
      if (data.toLowerCase() !== checked.calldata.toLowerCase()) throw new SignatureRefused('the calldata of the sealed orders is not the calldata the pre-check proved');
      // 5. The envelope, every input valid; the tests' seam alone may change it.
      let envelope: Envelope = { chainId, to: relay, data, value: 0n, nonce: Number(checked.nonce), gas: checked.gas.limit, maxFeePerGas: checked.maxFeePerGas, maxPriorityFeePerGas: checked.maxPriorityFeePerGas };
      if (seams.envelope !== undefined) envelope = seams.envelope(envelope);
      // 6. The envelope is the one Cross allowed.
      if (!isAddressEqual(envelope.to, relay)) throw new SignatureRefused('the target is not the relay');
      if (envelope.data.slice(0, 10).toLowerCase() !== CROSS_SELECTOR) throw new SignatureRefused('the call is not cross');
      if (envelope.value !== 0n) throw new SignatureRefused('the value is not zero');
      if (envelope.chainId !== chainId) throw new SignatureRefused('the chain is not the set\'s');
      if (BigInt(envelope.nonce) !== checked.nonce || envelope.gas !== checked.gas.limit || envelope.maxFeePerGas !== checked.maxFeePerGas || envelope.maxPriorityFeePerGas !== checked.maxPriorityFeePerGas) {
        throw new SignatureRefused('the nonce, the gas or the fees are not the ones the send chose');
      }
      if (envelope.maxPriorityFeePerGas > envelope.maxFeePerGas) throw new SignatureRefused('the tip is above the fee cap');
      // 7. The signature: an EIP-1559 transaction.
      const raw = await account.signTransaction({ type: 'eip1559', ...envelope });
      seams.signed?.(raw);
      // 8. Its own bytes read back: every field the sealed send's, and the sender the key.
      const tx = parseTransaction(raw);
      const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
      const same =
        tx.type === 'eip1559' && tx.chainId === chainId && tx.to !== undefined && tx.to !== null && isAddressEqual(tx.to, relay) && (tx.value ?? 0n) === 0n &&
        (tx.data ?? '0x').toLowerCase() === checked.calldata.toLowerCase() && BigInt(tx.nonce ?? -1) === checked.nonce && tx.gas === checked.gas.limit &&
        tx.maxFeePerGas === checked.maxFeePerGas && tx.maxPriorityFeePerGas === checked.maxPriorityFeePerGas && isAddressEqual(from, account.address);
      if (!same) throw new SignatureRefused('the signed bytes are not the sealed send');
      return {
        raw,
        hash: keccak256(raw),
        fields: { from: account.address, to: relay, nonce: checked.nonce, gas: checked.gas.limit, maxFeePerGas: checked.maxFeePerGas, maxPriorityFeePerGas: checked.maxPriorityFeePerGas, chainId: setChain },
      };
    },
  };
}
