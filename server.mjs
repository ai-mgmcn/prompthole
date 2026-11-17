// PromptHole — a local gateway that shows and controls what you send to AI APIs, and what they ask your tools to run.
// Entry point: wiring only. Zero dependencies, Node 22+.
import http from 'node:http';
import { config } from './src/config.mjs';
import { createStore } from './src/store.mjs';
import { createApp } from './src/app.mjs';

const store = createStore(config);
const server = http.createServer(createApp({ store, config }));
process.on('SIGTERM', () => process.exit(0)); // a clean exit lets coverage flush

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`PromptHole listening on ${base}`);
  console.log(`  dashboard : ${base}/`);
  console.log(`  Claude    : ANTHROPIC_BASE_URL=${base}/anthropic`);
  console.log(`  OpenAI    : OPENAI_BASE_URL=${base}/openai/v1`);
});
