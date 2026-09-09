import { watch } from 'node:fs';

// Restart a separate application process so shutdown persists unfinished generations.
// Watch both source directories, including shared contracts absent from the runtime import graph.
let child: ReturnType<typeof Bun.spawn> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let restarting = false;
let requested = false;
let stopping = false;

async function restart(): Promise<void> {
  requested = true;
  if (restarting || stopping) return;
  restarting = true;
  try {
    while (requested && !stopping) {
      requested = false;
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await child.exited;
      }
      if (!stopping) {
        child = Bun.spawn([process.execPath, 'server/src/index.ts'], {
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        });
      }
    }
  } finally {
    restarting = false;
  }
}
const watchers = ['server/src', 'shared/src'].map((directory) =>
  watch(directory, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void restart();
    }, 50);
  }),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopping = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await child.exited;
    }
    process.exit(0);
  });
}
await restart();
