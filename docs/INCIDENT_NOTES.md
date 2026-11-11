# Incident notes

What went wrong, when, and what was changed because of it. One entry per incident, newest first. Nothing here yet
has run against a live chain: the courier is not deployed.

## Found while building

### CI's first run: the contracts' build wrote no artifact for the files it was given (first build)

The first run of CI on the first push was red, 24 of 57 tests, every one the same missing file: the rig could not
open `contracts/out/CoinFixtures.sol/TestCoin.json` or `contracts/out/OspexGames.sol/OspexGames.json`. The build
step had succeeded: `forge build --skip test` followed by the paths of the files the rig deploys compiled all 127
files and wrote no artifact for exactly the files named. The same command had done the same on the machine the
suite was first run on, and the suite there was run against artifacts from the plain `forge build --skip test`;
the script was not changed to match. It is now the plain command. Nothing in the courier changed.

### A dropped idle database connection ended the process (first build)

The status test that stops the database found it: when the relay in front of the test database cut every
connection, the pool's idle clients raised an error on the pool itself, which had no listener, and the process
ended with an unhandled error instead of answering 503. The store now listens on the pool and logs the failure by
its code; the pool makes a new connection at the next query, and the status address answers `503` while the
database is down and `200` once it is back. The test that found it stays as the proof.
