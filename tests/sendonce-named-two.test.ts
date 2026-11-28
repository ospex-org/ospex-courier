import { after, before, test } from 'node:test';
import pg from 'pg';
import { closeEach } from './support/close';
import { ENDS, namedLives, WHERE, WORDS } from './support/lives';
import { startStack, type Stack } from './support/stack';

// Send once across the lives of the process, where the node's answer to the one hand-off is a named error
// (tests/support/lives.ts): the process killed at once after the answer was committed, and the answer's record lost,
// its commit acknowledged to nobody, or cut before its commit. The answer recorded and a kill before its record are in
// tests/sendonce-named.test.ts.

let stack: Stack;
let pool: pg.Pool;
let lives: ReturnType<typeof namedLives>;

before(async () => {
  stack = await startStack('sendonce_named_two', { hooked: true, blockTime: 2, sending: true });
  stack.proxy.finalFollows(1n);
  pool = new pg.Pool({ connectionString: stack.databaseUrl, max: 2 });
  lives = namedLives(stack, pool);
});

after(() => closeEach(() => pool?.end(), () => stack?.close()));

for (const history of ['refused', 'accepted'] as const) {
  test(`the process killed after the answer of the named error "${WORDS}" ${WHERE[history]} was committed, with the final block held; then a restart: one signature and one request across both lives, the same Cross and nonce, nothing reserved before its outcome, and the Cross ${ENDS[history]} from the chain`, () =>
    lives.killedAfterCommit(history));
}

for (const at of [
  { committed: true, history: 'accepted' as const },
  { committed: false, history: 'refused' as const },
]) {
  const what = at.committed ? "the commit of the answer's record acknowledged to nobody, the record committed" : "the answer's record cut before its commit, the record not committed";
  test(`${what}, the node's answer the named error "${WORDS}" ${WHERE[at.history]}: the process stops sending, with no new signature, request or reservation; then a restart with the final block held: one signature and one request across both lives, the same Cross and nonce, and the Cross ${ENDS[at.history]} from the chain`, () =>
    lives.answerCut(at.committed, at.history));
}
