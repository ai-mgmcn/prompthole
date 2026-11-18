// Test helper: stop a spawned server and wait until it has really exited.
// Deleting its data folder before that races with the server's last writes (audit file, events) and fails with ENOTEMPTY on Linux.
import fs from 'node:fs';

export function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const force = setTimeout(() => child.kill('SIGKILL'), 3000); // a server that ignores SIGTERM must not hang the test run
    child.once('exit', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  });
}

export async function stopAndRemove(child, dir) {
  await stopServer(child);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
