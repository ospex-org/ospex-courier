import { after, before, test } from 'node:test';
import pg from 'pg';
import { NAMED_ERRORS, type NamedError } from '../courier/chain/rpc';
import { closeEach } from './support/close';
import { namedWitnesses } from './support/named';
import { startStack, type Stack } from './support/stack';

// The node's named errors after the one hand-off, given after the chain took the request: the node passes the exact
// bytes on, the chain takes them, and the courier is answered with the named error in place of the chain's answer.
// The last nine of the list, each a case of its own (tests/support/named.ts), and the same history where the Cross
// reverts; the first ten are in tests/named-accepted-1.test.ts, so that no file runs near the test's time-out.

let stack: Stack;
let pool: pg.Pool;
let w: ReturnType<typeof namedWitnesses>;

before(async () => {
  stack = await startStack('named_accepted_2', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  w = namedWitnesses(stack, pool, { firstAccount: 40, firstLine: 3_000 });
  await w.prepare();
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

for (const words of NAMED_ERRORS.slice(10)) {
  test(`the node's named error "${words}", given after the chain took the request: the answer is not known, with its words alone, and the lane is held while the receipt is not given and the final block is before the expiry; given the evidence, the Cross ends confirmed from its own receipt, with what it filled, one signature, one request and no hold of the key`, () => w.acceptedThenNamed(words));
}

test(`the node's named error "${NAMED_ERRORS[0]}", given after the chain took the request, and the Cross's own transaction reverts: the bettor takes back its approval in the Cross's block and before it; the answer is not known, with its words alone, while the receipt is not given and the final block is held; given the evidence, the Cross ends reverted, TakerPullRefused, by its own hash, with one signature, one request and no hold of the key`, () => w.acceptedThenNamedReverted(NAMED_ERRORS[0] as NamedError));

test('nothing produced the reserved NODE_REFUSED: no row and no line holds it', () => w.noneReserved());
