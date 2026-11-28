import { quietSpellCases } from './support/quiet';

// The first bet after about 41,000 blocks with no bet, the evening to the evening of the example, on the rig: a real
// earlier Cross; then 41,000 empty blocks, mined in steps of 6,000 at most, each a case of its own, in which the courier
// asks the chain nothing and writes nothing; then one cent at 7:12:00 PM Central time on the chain's clock, good until
// 7:12:30. The chain's schedule and the clock are declared in tests/support/quiet.ts.

quietSpellCases('quiet_41000', 'a quiet spell of 41,000 blocks', 41_000, 6_000);
