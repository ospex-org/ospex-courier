import { after, before, test } from 'node:test';
import pg from 'pg';
import { closeEach } from './support/close';
import { ENDS, namedLives, WHERE, WORDS } from './support/lives';
import { startStack, type Stack } from './support/stack';

// Send once across the lives of the process, where the node's answer to the one hand-off is a named error, in its two
// histories (tests/support/lives.ts): the answer recorded and then a restart, and the process killed after the
// hand-off and before the answer's record. The answer's commit and a kill after it are in
// tests/sendonce-named-two.test.ts; the same cases with an answer lost and none named are in tests/sendonce.test.ts.

let stack: Stack;
let pool: pg.Pool;
let lives: ReturnType<typeof namedLives>;

before(async () => {
  stack = await startStack('sendonce_named', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  lives = namedLives(stack, pool);
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

for (const history of ['refused', 'accepted'] as const) {
  test(`the node's named error "${WORDS}" ${WHERE[history]}, recorded, then a restart with the final block held: the Cross unknown with the error's fixed words alone; one signature and one request for the bet across both lives, the same Cross and nonce, nothing reserved before its outcome, and the Cross ${ENDS[history]} from the chain`, () =>
    lives.recordedThenRestart(history));
}

for (const history of ['refused', 'accepted'] as const) {
  test(`the process killed after the hand-off was answered by the named error "${WORDS}" ${WHERE[history]}, before the answer's record, with the final block held; then a restart: one signature and one request across both lives, the same Cross and nonce, nothing reserved before its outcome, and the Cross ${ENDS[history]} from the chain`, () =>
    lives.killedBeforeRecord(history));
}
