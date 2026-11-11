import { StartupRefused, startService } from './startup';

// The courier's entry: `yarn start`, or the Procfile's web process. A refusal
// to start is one plain line that names the setting. A stop (SIGTERM from a
// deploy, a changed setting or the daily restart) is written by this process
// to its run's row; if closing takes longer than ten seconds the process
// exits anyway.

const FORCED_EXIT_MS = 10_000;

startService(process.env).then(
  (service) => {
    console.log(`courier: listening on port ${service.port}, run ${service.run.id}`);
    const stop = (signal: string) => {
      console.log(`courier: stopping on ${signal}`);
      const forced = setTimeout(() => process.exit(1), FORCED_EXIT_MS);
      forced.unref();
      service.close(signal.toLowerCase()).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  },
  (err: unknown) => {
    console.log(`courier did not start: ${err instanceof StartupRefused ? err.message : err instanceof Error ? err.name : String(err)}`);
    process.exitCode = 1;
  },
);
