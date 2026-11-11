import { mkdir, writeFile } from 'node:fs/promises';
import { isAddress, type Address } from 'viem';
import { checkNode } from '../courier/chain/node';
import { chainId, createJsonRpc, describeNodeFailure } from '../courier/chain/rpc';
import { readSet, SetRefused } from '../courier/chain/set';
import { isAcceptableRpcUrl } from '../courier/config';

// `yarn check:node`: what a node does with a block's hash and with an
// override, for each request the pre-check makes. It reads POLYGON_RPC_URL,
// SIGNPOST_ADDRESS and BETTING_ENTRY_ID, finds the relay and its sender from
// the signpost, runs the check, prints the verdicts and writes them to
// runs/check-node-<time>.json. It exits 1 when the node fails a request the
// pre-check needs. It sends nothing and holds no key.

const rpcUrl = (process.env.POLYGON_RPC_URL ?? '').trim();
const signpost = (process.env.SIGNPOST_ADDRESS ?? '').trim();
const entry = (process.env.BETTING_ENTRY_ID ?? '').trim();
const problems: string[] = [];
if (rpcUrl === '') problems.push('POLYGON_RPC_URL is not set');
else if (!isAcceptableRpcUrl(rpcUrl)) problems.push('POLYGON_RPC_URL must be an https:// URL (plain http only to this machine)');
if (!isAddress(signpost)) problems.push('SIGNPOST_ADDRESS is not an address');
if (!/^[0-9]{1,18}$/.test(entry)) problems.push('BETTING_ENTRY_ID must be a whole number');
if (problems.length > 0) {
  console.log(`check:node not run: ${problems.join('; ')}`);
  process.exit(1);
}

const rpc = createJsonRpc(rpcUrl);
try {
  const id = await chainId(rpc);
  const set = await readSet(rpc, { signpostAddress: signpost as Address, bettingEntryId: BigInt(entry) }, id);
  const check = await checkNode(rpc, { relay: set.relay, sender: set.sender });
  const record = { chainId: id.toString(), signpost: set.signpost, entry: set.entryId.toString(), relay: set.relay, sender: set.sender, check };
  const text = JSON.stringify(record, null, 2);
  console.log(text);
  await mkdir(new URL('../runs/', import.meta.url), { recursive: true });
  const file = new URL(`../runs/check-node-${check.checkedAt.replace(/[:.]/g, '-')}.json`, import.meta.url);
  await writeFile(file, `${text}\n`);
  console.log(`check:node: ${check.usable ? 'the node honours every request the pre-check makes' : 'the node FAILS a request the pre-check needs'}; written to runs/`);
  process.exitCode = check.usable ? 0 : 1;
} catch (err) {
  if (err instanceof SetRefused) console.log(`check:node not run: the set: ${err.message}`);
  else {
    const d = describeNodeFailure(err);
    console.log(`check:node not run: the node did not answer (${d.kind}${d.code === null ? '' : ` ${d.code}`})`);
  }
  process.exitCode = 1;
}
