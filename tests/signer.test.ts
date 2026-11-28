import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeFunctionData, getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RELAY_ABI } from '../courier/chain/abi';
import { isSealedSend, sealSend, type SealedCross, type SealedSend } from '../courier/check/precheck';
import { orderHash, type OrderFields } from '../courier/orders/order';
import { CROSS_SELECTOR, KeystoreRefused, openSigner, SignatureRefused, type Envelope, type SignerDeps } from '../courier/send/signer';
import { encryptForTest, testAccountKey } from './support/keystore';

// The keystore and the one signer, in this process, with no chain: the keystore
// opened as the format says, and refused where it is not one, not opened by its
// password, or not COURIER_ADDRESS's key; the signer's refusals before anything
// is signed, each with every other input valid; and the bytes it signs read back
// field by field. Every key here is the local chain's published test account 4,
// or one generated at test time; every password is made by the run.

const CHAIN = 31337n;
const RELAY = getAddress('0x' + '5e'.repeat(20));
const MATCHING = getAddress('0x' + '3a'.repeat(20));
const KEY = testAccountKey(4);
const ADDRESS = privateKeyToAccount(KEY).address;
const PASSWORD = randomBytes(12).toString('base64url');
const KEYSTORE = encryptForTest(KEY, PASSWORD);

function castAvailable(): boolean {
  try {
    execFileSync('cast', ['--version'], { stdio: 'ignore', env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' } });
    return true;
  } catch {
    return false;
  }
}

/** The address `cast wallet new` printed: "Address: 0x…" on one version, the bare address on another. */
function castPrintedAddress(stdout: string, stderr: string): string | undefined {
  return /Address:\s*(0x[0-9a-fA-F]{40})/.exec(`${stdout}\n${stderr}`)?.[1] ?? /^(0x[0-9a-fA-F]{40})\s*$/m.exec(stdout)?.[1];
}

/** The signer's other settings, with no lane held and no seal known: each case names what it needs. */
const base = (over: Partial<SignerDeps> = {}): SignerDeps => ({
  keystoreJson: KEYSTORE,
  keystorePassword: PASSWORD,
  address: ADDRESS,
  relay: RELAY,
  matching: MATCHING,
  chainId: CHAIN,
  isSealed: (x: unknown): x is SealedSend => false,
  laneNow: () => null,
  ...over,
});

test('a keystore made by `cast wallet new` opens to the address cast printed, and its wrong password is refused', async (t) => {
  if (!castAvailable()) {
    t.skip('cast is not on PATH; this is the one case that checks the reading against Foundry itself');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'courier-keystore-'));
  try {
    const password = randomBytes(12).toString('hex');
    const created = spawnSync('cast', ['wallet', 'new', dir, 'w'], { env: { ...process.env, CAST_PASSWORD: password, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' }, encoding: 'utf8' });
    assert.equal(created.status, 0, 'cast wallet new succeeded');
    const printed = castPrintedAddress(created.stdout, created.stderr);
    assert.ok(printed, 'cast printed an address');
    const keystoreJson = await readFile(join(dir, 'w'), 'utf8');
    const signer = openSigner(base({ keystoreJson, keystorePassword: password, address: printed as Address }));
    assert.equal(signer.address, getAddress(printed as string));
    assert.throws(() => openSigner(base({ keystoreJson, keystorePassword: 'not-the-password', address: printed as Address })), (e: unknown) => e instanceof KeystoreRefused && e.problem === 'wrong-password');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the opened key must be COURIER_ADDRESS: a match opens; a mismatch is refused, and the refusal names the two settings and neither address", () => {
  assert.equal(openSigner(base()).address, ADDRESS);
  const other = privateKeyToAccount(generatePrivateKey()).address;
  assert.throws(
    () => openSigner(base({ address: other })),
    (e: unknown) => e instanceof KeystoreRefused && e.problem === 'not-the-address' && /COURIER_KEYSTORE_JSON/.test(e.message) && /COURIER_ADDRESS/.test(e.message) && !e.message.toLowerCase().includes(other.toLowerCase()) && !e.message.toLowerCase().includes(ADDRESS.toLowerCase()),
  );
});

test('a wrong password is refused by the MAC before anything is decrypted', () => {
  assert.throws(() => openSigner(base({ keystorePassword: `${PASSWORD}x` })), (e: unknown) => e instanceof KeystoreRefused && e.problem === 'wrong-password' && /MAC mismatch/.test(e.message));
});

test('a keystore whose decrypted bytes are not a valid key is refused, and the refusal carries none of those bytes', () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // the curve's group order
  for (const bytes of [`0x${'00'.repeat(32)}`, `0x${N.toString(16)}`, `0x${'ff'.repeat(32)}`] as Hex[]) {
    let caught: unknown;
    assert.throws(
      () => openSigner(base({ keystoreJson: encryptForTest(bytes, 'pw'), keystorePassword: 'pw' })),
      (e: unknown) => {
        caught = e;
        return e instanceof KeystoreRefused && e.problem === 'unreadable' && e.message === 'keystore: the decrypted bytes are not a valid private key';
      },
    );
    const error = caught as Error & Record<string, unknown>;
    assert.equal('cause' in error, false, "the library's error is not kept as the cause");
    const everything = [String(error), error.stack ?? '', ...Object.getOwnPropertyNames(error).map((name) => String(error[name]))].join('\n').toLowerCase();
    const needles = [bytes.slice(2).toLowerCase(), ...(BigInt(bytes) === 0n ? [] : [BigInt(bytes).toString(), BigInt(bytes).toString(16)])];
    for (const needle of needles) assert.ok(!everything.includes(needle), `no ${needle.slice(0, 8)}… on the error`);
  }
});

test('only v3 scrypt and AES-128-CTR keystores are read', () => {
  const good = JSON.parse(encryptForTest(KEY, 'pw')) as { crypto: Record<string, unknown> };
  const variant = (crypto: Record<string, unknown>, top: Record<string, unknown> = {}) => JSON.stringify({ version: 3, ...top, crypto: { ...good.crypto, ...crypto } });
  const refused = (json: string, why: RegExp) => assert.throws(() => openSigner(base({ keystoreJson: json, keystorePassword: 'pw' })), (e: unknown) => e instanceof KeystoreRefused && why.test(e.message));
  refused(variant({}, { version: 1 }), /version 3/);
  refused(variant({ kdf: 'pbkdf2' }), /scrypt/);
  refused(variant({ cipher: 'aes-256-ctr' }), /aes-128-ctr/);
  refused(variant({ kdfparams: { dklen: 32, n: 3, p: 1, r: 8, salt: '00' } }), /scrypt parameters/);
  refused('{', /not valid JSON/);
  assert.equal(openSigner(base({ keystoreJson: variant({}), keystorePassword: 'pw' })).address, ADDRESS, 'the control');
});

// ──────────────────────────── the signer ────────────────────────────

/** An order of the test's own, whole and in the contract's shape, for the calldata: its signature is never checked here. */
const orderOf = (account: string, side: 0 | 1, nonce: bigint): OrderFields => ({
  account: getAddress(account),
  gameId: 7n,
  scorer: getAddress('0x' + '0c'.repeat(20)),
  lineTicks: 0,
  positionType: side,
  oddsTick: side === 1 ? 196 : 204,
  riskAmount: 10_000n,
  nonce,
  expiry: 1_800_000_000n,
  minFill: 0n,
});

const SIG: Hex = `0x${'1b'.repeat(65)}`;

/** A send shaped as the pre-check seals one, frozen, with the epoch and reservation given; `marks` is the seal the signer is told of. */
function sendOf(marks: WeakSet<object>, held: { epoch: bigint; reservation: bigint }, over: { nonce?: bigint; gas?: bigint; fees?: [bigint, bigint]; calldata?: Hex; takingHash?: Hex } = {}): SealedSend {
  const taking = orderOf('0x' + 'b0'.repeat(20), 1, 11n);
  const resting = [orderOf('0x' + 'a0'.repeat(20), 0, 12n), orderOf('0x' + 'a1'.repeat(20), 0, 13n)];
  const calldata = over.calldata ?? (encodeFunctionData({ abi: RELAY_ABI, functionName: 'cross', args: [{ order: taking, signature: SIG }, resting.map((o) => ({ order: o, signature: SIG }))] } as never) as Hex);
  const send: SealedSend = {
    taking: { order: taking, signature: SIG, hash: over.takingHash ?? orderHash(taking, CHAIN, MATCHING) },
    resting: resting.map((o) => ({ order: o, signature: SIG, hash: orderHash(o, CHAIN, MATCHING) })),
    calldata,
    block: { number: 100n, hash: `0x${'cd'.repeat(32)}`, time: 1_799_999_990n },
    gas: { estimate: 500_000n, limit: over.gas ?? 600_000n },
    epoch: held.epoch,
    reservation: held.reservation,
    nonce: over.nonce ?? 5n,
    maxFeePerGas: over.fees?.[0] ?? 3_000_000_000n,
    maxPriorityFeePerGas: over.fees?.[1] ?? 1_000_000_000n,
  };
  Object.freeze(send);
  marks.add(send);
  return send;
}

/** A signer told of `marks`, holding the lane at `held`, with the seams given; its signed attempts counted. */
function signerWith(marks: WeakSet<object>, held: { epoch: bigint; reservation: bigint } | null, seams: { envelope?: (e: Envelope) => Envelope; handed?: (x: unknown) => unknown } = {}) {
  const signed: Hex[] = [];
  const signer = openSigner(base({ isSealed: (x: unknown): x is SealedSend => typeof x === 'object' && x !== null && marks.has(x), laneNow: () => held, seams: { ...seams, signed: (raw) => signed.push(raw) } }));
  return { signer, signed };
}

const refusedBy = async (work: Promise<unknown>, check: RegExp): Promise<void> => {
  await assert.rejects(work, (e: unknown) => e instanceof SignatureRefused && check.test(e.check));
};

test("the signer refuses before anything is signed: an object it is not told is sealed; a sealed send of another epoch, or of another reservation, than the lane's now; an order that no longer hashes to its hash; calldata that is not the sealed orders' Cross; and, through the seam inside the signing path, a target that is not the relay and a value above zero, each with every other input valid. Nothing is signed for any of them, and the control is signed", async () => {
  const held = { epoch: 3n, reservation: 41n };
  const marks = new WeakSet<object>();
  const { signer, signed } = signerWith(marks, held);
  const control = sendOf(marks, held);
  // A look-alike: every field the control's, and no seal.
  await refusedBy(signer.signCross(structuredClone(control)), /not a send the pre-check sealed/);
  await refusedBy(signer.signCross(sendOf(marks, { epoch: 2n, reservation: 41n })), /epoch and reservation/);
  await refusedBy(signer.signCross(sendOf(marks, { epoch: 3n, reservation: 40n })), /epoch and reservation/);
  await refusedBy(signerWith(marks, null).signer.signCross(control), /epoch and reservation/);
  await refusedBy(signer.signCross(sendOf(marks, held, { takingHash: `0x${'ee'.repeat(32)}` })), /no longer hashes/);
  await refusedBy(signer.signCross(sendOf(marks, held, { calldata: '0x84075346' })), /calldata/);
  const seamed = (envelope: (e: Envelope) => Envelope) => signerWith(marks, held, { envelope });
  const target = seamed((e) => ({ ...e, to: getAddress('0x' + '77'.repeat(20)) }));
  await refusedBy(target.signer.signCross(control), /target is not the relay/);
  const value = seamed((e) => ({ ...e, value: 1n }));
  await refusedBy(value.signer.signCross(control), /value is not zero/);
  const nonce = seamed((e) => ({ ...e, nonce: e.nonce + 1 }));
  await refusedBy(nonce.signer.signCross(control), /nonce, the gas or the fees/);
  const gas = seamed((e) => ({ ...e, gas: e.gas - 1n }));
  await refusedBy(gas.signer.signCross(control), /nonce, the gas or the fees/);
  const selector = seamed((e) => ({ ...e, data: `0xa9059cbb${e.data.slice(10)}` as Hex }));
  await refusedBy(selector.signer.signCross(control), /not cross/);
  const tip = signerWith(marks, held).signer.signCross(sendOf(marks, held, { fees: [1_000_000_000n, 2_000_000_000n] }));
  await refusedBy(tip, /tip is above the fee cap/);
  assert.deepEqual([signed.length, target.signed.length, value.signed.length, nonce.signed.length, gas.signed.length, selector.signed.length], [0, 0, 0, 0, 0, 0], 'nothing was signed');
  // The control: signed, once.
  await signer.signCross(control);
  assert.equal(signed.length, 1);
});

test("a genuine call of the signer with a Cross row's fields: the nonce, the gas, the fees, the epoch and the reservation a row holds, read back from the database and made into the send's shape around the bet's orders, not sealed by the pre-check, is refused before anything is signed", async () => {
  const held = { epoch: 3n, reservation: 41n };
  const marks = new WeakSet<object>();
  const { signer, signed } = signerWith(marks, held);
  const sealed = sendOf(marks, held);
  // The row as the database holds it, its figures in text, as a planted signed row carries them.
  const row = { nonce: '999', gas_limit: '500000', max_fee_per_gas: '1', max_priority_fee: '1', epoch: '3', reservation: '41' };
  const fromRow = {
    ...sealed,
    nonce: BigInt(row.nonce),
    gas: { estimate: BigInt(row.gas_limit), limit: BigInt(row.gas_limit) },
    maxFeePerGas: BigInt(row.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(row.max_priority_fee),
    epoch: BigInt(row.epoch),
    reservation: BigInt(row.reservation),
  };
  await refusedBy(signer.signCross(fromRow), /not a send the pre-check sealed/);
  assert.equal(signed.length, 0, 'nothing was signed');
});

test("the bytes it signs are the sealed send's: an EIP-1559 transaction from the key to the relay, calling cross, carrying no coin, on the chain's id, at the nonce, gas and fees chosen; read back by the signer, and again here; the hash is the bytes' own", async () => {
  const held = { epoch: 1n, reservation: 7n };
  const marks = new WeakSet<object>();
  const { signer, signed } = signerWith(marks, held);
  const send = sendOf(marks, held, { nonce: 9n, gas: 777_000n, fees: [5_000_000_000n, 2_000_000_000n] });
  const out = await signer.signCross(send);
  assert.equal(signed.length, 1);
  assert.equal(signed[0], out.raw, "the seam saw the bytes the signer returned");
  assert.equal(out.hash, keccak256(out.raw));
  const tx = parseTransaction(out.raw);
  assert.equal(tx.type, 'eip1559');
  assert.equal(tx.chainId, 31337);
  assert.equal(tx.to?.toLowerCase(), RELAY.toLowerCase());
  assert.equal(tx.value ?? 0n, 0n);
  assert.equal(tx.data?.slice(0, 10), CROSS_SELECTOR);
  assert.equal(tx.data, send.calldata);
  assert.deepEqual([BigInt(tx.nonce ?? -1), tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas], [9n, 777_000n, 5_000_000_000n, 2_000_000_000n]);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: out.raw as never }), ADDRESS);
  assert.deepEqual(out.fields, { from: ADDRESS, to: RELAY, nonce: 9n, gas: 777_000n, maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n, chainId: CHAIN });
});

test("the pre-check's seal: a send is sealed only from a Cross the pre-check sealed, and the signer's mark knows only what the pre-check sealed", () => {
  const plain = { taking: {}, resting: [], calldata: '0x', block: {}, gas: { estimate: 1n, limit: 2n }, epoch: 1n, reservation: 1n } as unknown as SealedCross;
  assert.throws(() => sealSend(plain, { nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), /only a Cross the pre-check sealed/);
  const held = { epoch: 1n, reservation: 1n };
  const marks = new WeakSet<object>();
  assert.equal(isSealedSend(sendOf(marks, held)), false, "a send this test froze and marked is not the pre-check's");
  assert.equal(isSealedSend(null), false);
});

test("no form of the key, the password or the keystore is in anything the signer returns or throws", async () => {
  const held = { epoch: 1n, reservation: 2n };
  const marks = new WeakSet<object>();
  const { signer } = signerWith(marks, held);
  const seen: string[] = [];
  const keep = (x: unknown) => seen.push(typeof x === 'object' && x !== null ? `${JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v))} ${String(x)} ${(x as Error).stack ?? ''}` : String(x));
  keep(Object.keys(signer));
  keep(await signer.signCross(sendOf(marks, held)));
  await signer.signCross(structuredClone(sendOf(marks, held))).catch(keep);
  try {
    openSigner(base({ keystorePassword: 'wrong' }));
  } catch (e) {
    keep(e);
  }
  try {
    openSigner(base({ address: privateKeyToAccount(generatePrivateKey()).address }));
  } catch (e) {
    keep(e);
  }
  const all = seen.join('\n').toLowerCase();
  const ks = JSON.parse(KEYSTORE) as { crypto: { ciphertext: string; mac: string } };
  for (const needle of [KEY.slice(2).toLowerCase(), BigInt(KEY).toString(), PASSWORD.toLowerCase(), ks.crypto.ciphertext.toLowerCase(), ks.crypto.mac.toLowerCase()]) {
    assert.ok(!all.includes(needle), 'a form of the key, the password or the keystore came out');
  }
});

test("signing does not reach the settings the signer was opened with: opened from settings behind a revocable proxy, revoked as soon as the signer is returned, it signs a sealed Cross, and refuses the sends it refuses, each for its own reason", async () => {
  const held = { epoch: 3n, reservation: 41n };
  const marks = new WeakSet<object>();
  const signed: Hex[] = [];
  const { proxy, revoke } = Proxy.revocable(base({ isSealed: (x: unknown): x is SealedSend => typeof x === 'object' && x !== null && marks.has(x), laneNow: () => held, seams: { signed: (raw) => signed.push(raw) } }), {});
  const signer = openSigner(proxy);
  // From here any read of the settings throws: a signer that still reaches them fails at that read.
  revoke();
  const out = await signer.signCross(sendOf(marks, held));
  assert.equal(signed.length, 1);
  assert.equal(await recoverTransactionAddress({ serializedTransaction: out.raw as never }), ADDRESS);
  assert.equal(out.fields.chainId, CHAIN);
  await refusedBy(signer.signCross(structuredClone(sendOf(marks, held))), /not a send the pre-check sealed/);
  await refusedBy(signer.signCross(sendOf(marks, { epoch: 2n, reservation: 41n })), /epoch and reservation/);
  await refusedBy(signer.signCross(sendOf(marks, held, { takingHash: `0x${'ee'.repeat(32)}` })), /no longer hashes/);
  await refusedBy(signer.signCross(sendOf(marks, held, { calldata: '0x84075346' })), /calldata/);
  assert.equal(signed.length, 1, 'nothing more was signed');
});

test('a forced collection, once the signer is returned: a weak reference to the settings it was opened with is cleared while the signer is held, and the signer still signs', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const held = { epoch: 1n, reservation: 2n };
  const marks = new WeakSet<object>();
  // The settings made and dropped inside this function: the test keeps only the signer and a weak reference.
  const { signer, settings } = (() => {
    const deps = base({ isSealed: (x: unknown): x is SealedSend => typeof x === 'object' && x !== null && marks.has(x), laneNow: () => held });
    return { signer: openSigner(deps), settings: new WeakRef(deps) };
  })();
  // A turn apart before each collection, so that nothing this turn made keeps the settings alive.
  await new Promise((r) => setImmediate(r));
  gc();
  await new Promise((r) => setImmediate(r));
  gc();
  await new Promise((r) => setImmediate(r));
  assert.equal(settings.deref(), undefined, 'the settings were collected');
  await signer.signCross(sendOf(marks, held));
});
