// The close of a test file, or of its stack: each step in its own try, so a step that fails does not keep a later
// one from running, and a file's databases are dropped whatever failed before. The first failure is thrown once
// every step has run.

export async function closeEach(...steps: Array<() => unknown>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}
