import { quietSpellCases } from './support/quiet';

// The first bet after a quiet day, on the rig: a real earlier Cross; then a day of the chain with no bet, 43,200 empty
// blocks at least two seconds apart, mined in steps of 6,000 at most, each a case of its own, in which the courier asks
// the chain nothing and writes nothing; then one cent at 7:12:00 PM Central time on the chain's clock, good until
// 7:12:30. The chain's schedule and the clock are declared in tests/support/quiet.ts.

quietSpellCases('quiet_day', 'a quiet day of 43,200 blocks', 43_200, 6_000);
