// PromptHole — the Pi-hole for AI: a local gateway that shows and controls what you send to AI APIs, and what they ask your tools to run.
// Entry point: wiring only. Zero dependencies, Node 22+.
import http from 'node:http';
import { config } from './src/config.mjs';
import { createStore } from './src/store.mjs';
import { createScanPool } from './src/scan-pool.mjs';
import { createApp } from './src/app.mjs';

const store = createStore(config);
const pool = createScanPool({ size: config.scanWorkers, timeoutMs: config.scanTimeoutMs });
const server = http.createServer(createApp({ store, config, pool }));
server.requestTimeout = 0; // AI requests and streams can legitimately run for many minutes
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { store.flush(); process.exit(0); }); // a clean exit also lets coverage flush
process.on('uncaughtException', (e) => console.error('uncaught:', e)); // one bad connection must not take the gateway down
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`PromptHole listening on ${base}`);
  console.log(`  dashboard : ${base}/`);
  console.log(`  Claude    : ANTHROPIC_BASE_URL=${base}/anthropic`);
  console.log(`  OpenAI    : OPENAI_BASE_URL=${base}/openai/v1`);
});
