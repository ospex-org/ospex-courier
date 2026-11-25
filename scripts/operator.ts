import { isAddress, type Address } from 'viem';
import { chainId, createJsonRpc, describeNodeFailure } from '../courier/chain/rpc';
import { readSet, SetRefused } from '../courier/chain/set';
import { createChainReader } from '../courier/chain/snapshot';
import { readCourierConfig } from '../courier/config';
import { createStore, openPool, pinnedAuthority } from '../courier/records/store';
import { clearLane, restoreShut } from '../courier/send/operator';

// The operator's command, one command, run by hand.
//
//   yarn operator shut --copy-time <the restored copy's time, ISO 8601>
//     After every old courier process is stopped and before any courier starts on the restored database: records the
//     restore's incident and the database-wide sending hold, and shuts every lane by its line. Nothing in this build
//     releases that hold.
//
//   yarn operator clear --lane <address> --found "<what the operator found>"
//     The recorded clear of an ordinary hold: opens the lane only when every nonce below the key's count at a
//     compatible final block is explained. It refuses a lane shut at a restore.
//
// It reads the courier's own settings, as the courier does, and prints what it did, never a setting's value.

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const usage = 'usage: operator shut --copy-time <ISO time> | operator clear --lane <address> --found "<what was found>"';
if (command !== 'shut' && command !== 'clear') {
  console.log(`operator: not run: ${usage}`);
  process.exit(1);
}
const copyTime = flag('copy-time');
const lane = flag('lane');
const found = flag('found');
if (command === 'shut' && (copyTime === undefined || Number.isNaN(Date.parse(copyTime)))) {
  console.log('operator: not run: --copy-time must be the restored copy\'s time, ISO 8601');
  process.exit(1);
}
if (command === 'clear' && (lane === undefined || !isAddress(lane) || found === undefined || found.trim() === '')) {
  console.log('operator: not run: --lane must be an address and --found must say what the operator found');
  process.exit(1);
}

const read = readCourierConfig(process.env);
if (!read.ok) {
  console.log(`operator: not run: settings: ${read.problems.join('; ')}`);
  process.exit(1);
}
const config = read.config;
const authority = pinnedAuthority(config.databaseCaFile);
const store = createStore(openPool(config.databaseUrl, authority), openPool(config.databaseUrl, authority, 1), (l) => console.log(l), openPool(config.databaseUrl, authority, 1));
const rpc = createJsonRpc(config.rpcUrl);
try {
  const id = await chainId(rpc);
  const set = await readSet(rpc, { signpostAddress: config.signpostAddress, bettingEntryId: config.bettingEntryId }, id);
  const run = await store.runs.start();
  try {
    const chain = createChainReader({ rpc, conditions: store.conditions, run: run.id });
    if (command === 'shut') {
      const shut = await restoreShut({ store, rpc, chain, set, run: run.id }, copyTime as string);
      console.log(`operator: the restore's incident is line ${shut.line}; ${shut.lanes.length} lane${shut.lanes.length === 1 ? '' : 's'} shut by it; the relay's sender ${shut.relaySender === 'unavailable' ? 'could not be read, and sending is held all the same' : `${shut.relaySender.address} at block ${shut.relaySender.block.number}`}`);
    } else {
      const cleared = await clearLane({ store, rpc, chain, set, run: run.id }, lane as Address, found as string);
      console.log(cleared.cleared ? `operator: lane ${lane} cleared by line ${cleared.line}; ${cleared.explainedBySearch.length} nonce${cleared.explainedBySearch.length === 1 ? '' : 's'} explained by the search` : `operator: lane ${lane} not cleared: ${cleared.why}`);
      process.exitCode = cleared.cleared ? 0 : 1;
    }
  } finally {
    await store.runs.stop(run.id, `operator: ${command}`);
  }
} catch (err) {
  if (err instanceof SetRefused) console.log(`operator: not run: the set: ${err.message}`);
  else {
    const d = describeNodeFailure(err);
    console.log(`operator: not run: the node did not answer (${d.kind}${d.code === null ? '' : ` ${d.code}`})`);
  }
  process.exitCode = 1;
} finally {
  await store.close().catch(() => undefined);
}
