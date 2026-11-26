import { after, before, test } from 'node:test';
import pg from 'pg';
import { NAMED_ERRORS } from '../courier/chain/rpc';
import { closeEach } from './support/close';
import { namedWitnesses } from './support/named';
import { startStack, type Stack } from './support/stack';

// The node's named errors after the one hand-off, given before the request reaches the chain: the last nine of the
// list, each a case of its own (tests/support/named.ts). The first ten are in tests/named-refused-1.test.ts, so that
// no file runs near the test's time-out.

let stack: Stack;
let pool: pg.Pool;
let w: ReturnType<typeof namedWitnesses>;

before(async () => {
  stack = await startStack('named_refused_2', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  w = namedWitnesses(stack, pool, { firstAccount: 40, firstLine: 3_000 });
  await w.prepare();
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

for (const words of NAMED_ERRORS.slice(10)) {
  test(`the node's named error "${words}", given before the request reaches the chain: the answer is not known, with its words alone; the lane holds the bet and a later bet does not reserve first; at a final block at the bet's expiry, to the second, it ends expired unmined with its total there and no hold of the key; and the next bet fills`, () => w.refusedBeforeForwarding(words));
}

test('nothing produced the reserved NODE_REFUSED: no row and no line holds it', () => w.noneReserved());
