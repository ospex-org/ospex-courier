import { after, before, test } from 'node:test';
import pg from 'pg';
import { NAMED_ERRORS } from '../courier/chain/rpc';
import { closeEach } from './support/close';
import { namedWitnesses } from './support/named';
import { startStack, type Stack } from './support/stack';

// The node's named errors after the one hand-off, given after the chain took the request: the node passes the exact
// bytes on, the chain takes them, and the courier is answered with the named error in place of the chain's answer.
// The first ten of the list, each a case of its own (tests/support/named.ts); the other nine are in
// tests/named-accepted-2.test.ts, so that no file runs near the test's time-out.

let stack: Stack;
let pool: pg.Pool;
let w: ReturnType<typeof namedWitnesses>;

before(async () => {
  stack = await startStack('named_accepted_1', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  w = namedWitnesses(stack, pool, { firstAccount: 40, firstLine: 3_000 });
  await w.prepare();
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

for (const words of NAMED_ERRORS.slice(0, 10)) {
  test(`the node's named error "${words}", given after the chain took the request: the answer is not known, with its words alone, and the lane is held while the receipt is not given and the final block is before the expiry; given the evidence, the Cross ends confirmed from its own receipt, with what it filled, one signature, one request and no hold of the key`, () => w.acceptedThenNamed(words));
}

test('nothing produced the reserved NODE_REFUSED: no row and no line holds it', () => w.noneReserved());
