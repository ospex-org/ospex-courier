# Incident notes

What went wrong, when, and what was changed because of it. One entry per incident, newest first. Nothing here yet
has run against a live chain: the courier is not deployed.

## Found while building

### A dropped idle database connection ended the process (first build)

The status test that stops the database found it: when the relay in front of the test database cut every
connection, the pool's idle clients raised an error on the pool itself, which had no listener, and the process
ended with an unhandled error instead of answering 503. The store now listens on the pool and logs the failure by
its code; the pool makes a new connection at the next query, and the status address answers `503` while the
database is down and `200` once it is back. The test that found it stays as the proof.
