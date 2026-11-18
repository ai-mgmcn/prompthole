// Runs inside a worker thread: tries each regex against nasty inputs. The parent kills this thread if one pattern hangs.
import { parentPort } from 'node:worker_threads';

const A = 'a'.repeat(40);
const INPUTS = [A + '!', '0'.repeat(40) + '!', ' '.repeat(40) + '!', 'ab'.repeat(25) + '!', 'a-'.repeat(25) + '!', 'a.'.repeat(25) + '@', '/'.repeat(40) + '!', 'word '.repeat(4000), 'x'.repeat(30000)];
parentPort.on('message', ({ items }) => {
  for (const it of items) {
    parentPort.postMessage({ start: it.i });
    let re; try { re = new RegExp(it.pattern, 'g' + (it.flags || '')); } catch { continue; }
    for (const s of INPUTS) { re.lastIndex = 0; re.test(s); }
  }
  parentPort.postMessage({ done: true });
});
