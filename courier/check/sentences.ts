// The sentences of a bet's verdict and of the door's three new answers, each
// as docs/API.md states it, word for word; `{…}` in the documented sentence is
// the value filled in here. A sentence says what happened, what was and was not
// recorded or sent, and what to do next.

export const DOOR = {
  NODE_UNUSABLE: "The courier's node failed the check made when the courier started, so the courier takes no order until it restarts on a node that passes. Nothing was recorded.",
  NOT_TAKING_BETS: 'The courier is not taking bets right now. This bet was not recorded. Post the same signed bet again.',
  BETS_CLOSED: (gameId: string, closesAt: string, T: string) => `Bets on game ${gameId} close at ${closesAt}, the start plus its window. The chain's time is ${T}, so no later block can take this order.`,
} as const;

export const VERDICT = {
  BET_LAPSED: (expiry: string, n: string, tPlusOne: string) => `This bet ran out of time before its turn came. Its expiry is ${expiry}, and at block ${n} a bet needed an expiry above ${tPlusOne}. Nothing was sent. Sign it again.`,
  CANCELLED: (n: string) => `At block ${n} this bet is cancelled on chain: by its own cancel, by its account moving to a new version, or by a floor raised above its order number on this line. Nothing was sent.`,
  BAD_SIGNATURE_NO_GRANT: (n: string, g: string) => `At block ${n}, this order's nonce names grant ${g}, and its account has made no grant of that number: there is no agent whose signature it could carry. Nothing was sent.`,
  BAD_SIGNATURE_NOT_AGENT: (n: string, g: string) => `At block ${n}, the signature is not the agent's of grant ${g}, the grant this order's nonce names: an order under a grant is signed by that grant's agent, not by its account and not by another key. Nothing was sent.`,
  AGENT_STAKE_ABOVE_CAP: (n: string, g: string, stakeCap: string, stake: string) => `At block ${n}, grant ${g} lets its agent sign an order for ${stakeCap} USDC at most. This order is signed for ${stake} USDC. Nothing was sent.`,
  LINE_NOT_IN_GRANT: (n: string, g: string) => `At block ${n}, grant ${g} names the lines its agent may sign on, and this order's line is not one of them. Nothing was sent.`,
  GRANT_GONE: (n: string, why: string) => `At block ${n} this bet's grant is gone: ${why}. Nothing was sent.`,
  FILLED: (n: string) => `At block ${n} this bet has less than a lot of its stake left on chain. Nothing was sent.`,
  NOT_REGISTERED: (n: string, relay: string) => `At block ${n} this bet's account has not registered the courier's relay, ${relay}. Nothing was sent.`,
  ABOVE_CAP: (n: string, cap: string, stake: string) => `At block ${n}, bets are capped at ${cap} USDC until the cap is lifted. This bet is signed for ${stake} USDC. Nothing was sent.`,
  UNKNOWN_GAME: (n: string, gameId: string) => `At block ${n}, game ${gameId} is not a game on the games set. Nothing was sent.`,
  NO_WRITTEN_START: (n: string, gameId: string) => `At block ${n}, game ${gameId} has no written start yet; the courier carries a game once its start is written. Nothing was sent.`,
  REPORTERS_NOT_THE_PUBLISHED_LIST: (n: string, gameId: string) => `At block ${n}, game ${gameId}'s reporters are not exactly the published list; the courier carries only games whose reporters are. Nothing was sent.`,
  GAME_ENDED: (n: string, gameId: string, status: string) => `At block ${n}, game ${gameId} has ended (status ${status}). Nothing was sent.`,
  BETS_CLOSED: (n: string, gameId: string, closesAt: string, T: string) => `At block ${n}, bets on game ${gameId} close at ${closesAt}, the start plus its window. The chain's time is ${T}, so no later block can take this bet. Nothing was sent.`,
  STOPPED: 'A stop for this bet was recorded while it was being checked. Nothing was sent.',
  NO_DEPTH: (n: string) => `At block ${n} no quote on the book meets this bet's price. Nothing was sent.`,
  ONLY_YOUR_OWN_QUOTES: (n: string) => `At block ${n} the only quotes that meet this bet's price are its own account's, and an account is never matched with itself. Nothing was sent.`,
  NOT_ENOUGH_DEPTH: (n: string, filled: string, minFill: string) => `At block ${n} the book can fill ${filled} USDC of this bet. It asks for at least ${minFill} USDC. Nothing was sent.`,
  DEPTH_EXAMINED_NONE: (examined: string, n: string) => `The courier examined the first ${examined} quotes in price order and found none that can fill this bet at block ${n}. Quotes behind them were not examined. Nothing was sent.`,
  DEPTH_EXAMINED_SOME: (examined: string, n: string, filled: string, minFill: string) => `The courier examined the first ${examined} quotes in price order. At block ${n} they fill ${filled} USDC of this bet, and it asks for at least ${minFill} USDC. Quotes behind them were not examined. Nothing was sent.`,
  DEPTH_SCAN_NONE: (rows: string, n: string) => `The courier took the first ${rows} quotes of its book for this side that it had not marked ended, in price order, and found none that can fill this bet at block ${n}. What lies behind them was not read. Nothing was sent.`,
  DEPTH_SCAN_SOME: (rows: string, n: string, filled: string, minFill: string) => `The courier took the first ${rows} quotes of its book for this side that it had not marked ended, in price order. At block ${n} the live quotes among them fill ${filled} USDC of this bet, and it asks for at least ${minFill} USDC. What lies behind them was not read. Nothing was sent.`,
  DEPTH_LISTED: (listed: string, n: string, filled: string, minFill: string) => `One fill lists ${listed} quotes at most. At block ${n} the first ${listed} quotes that can fill this bet cover ${filled} USDC of it, and it asks for at least ${minFill} USDC. Nothing was sent.`,
  CANNOT_PAY: (pull: string, n: string, balance: string, allowance: string) => `This bet needs ${pull} USDC from its account's wallet. At block ${n} the wallet holds ${balance} USDC and allows the positions contract ${allowance} USDC. Nothing was sent.`,
  COURIER_CANNOT_SEND: (n: string) => `At block ${n} the courier's key is not the relay's sender, so the courier cannot send. Nothing was sent.`,
  CROSS_WOULD_REVERT: (n: string, reason: string) => `The node ran the exact transaction at block ${n}, and it was refused: ${reason}. Nothing was sent.`,
  CROSS_WOULD_REVERT_AT_LIMIT: (n: string, reason: string) => `The node ran the exact transaction at block ${n} at the gas limit the courier would sign it with, and it was refused: ${reason}. Nothing was sent.`,
  CROSS_WOULD_REVERT_TRIMMED: (n: string, trimmedTo: string, reason: string) => `At block ${n}, a fill of this bet against all its listed quotes needs more gas than one transaction may carry, and the node refused the fill against the first ${trimmedTo} of them: ${reason}. Nothing was sent. Sign the bet again.`,
  CROSS_TOO_LARGE_ONE: (n: string) => `At block ${n} even a fill of this bet against one quote needs more gas than one transaction may carry. Nothing was sent.`,
  CROSS_TOO_LARGE_SEARCHED: (n: string, listed: string) => `At block ${n}, a fill of this bet against the ${listed} quotes listed for it needs more gas than one transaction may carry. The courier looked for a fill against fewer of them, taken in their order, that fits one transaction and meets this bet's minimum, and its search found none; that does not mean none exists. Nothing was sent. Sign the bet again with a smaller stake or a lower minimum.`,
  CHAIN_UNREACHABLE: 'The courier could not read the chain to check this bet, after two tries. Nothing was sent. Sign the bet again.',
  COURIER_FAULT: "The courier's own check of this bet went wrong. That is the courier's fault, and it is recorded as one. Nothing was sent. Sign the bet again.",
  NOT_SENT: (n: string) => `The courier checked this bet at block ${n} and found that it would fill as listed. The sender is a later build, so nothing was signed or sent.`,
} as const;
