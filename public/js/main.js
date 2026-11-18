// Entry point: sidebar, tab routing and the refresh loop. Each page is { id, title, init?, load(first) }.
import { $, $$ } from './dom.js';
import { initDrawer, closeDrawer } from './drawer.js';
import { onNavigate } from './router.js';
import { overview } from './pages/overview.js';
import { requests } from './pages/requests.js';
import { commands } from './pages/commands.js';
import { rules } from './pages/rules.js';
import { initImport } from './pages/import.js';
import { clients } from './pages/clients.js';
import { setup } from './pages/setup.js';

const PAGES = [overview, requests, commands, rules, clients, setup];
const LIVE = new Set(['over', 'log']); // refreshed on the timer; the others only when opened
let current = overview;

let busy = false, failures = 0;
const refresh = async (first, payload) => {
  if (busy && !first) return; // never stack requests when the server is slow
  busy = true;
  try {
    if (first || LIVE.has(current.id)) await current.load(first, payload);
    failures = 0; $('#stamp').classList.remove('s-bad'); $('#stamp').textContent = new Date().toLocaleTimeString();
  } catch {
    failures++; $('#stamp').classList.add('s-bad'); $('#stamp').textContent = 'Connection lost — retrying…';
  } finally { busy = false; }
};

function show(page, payload) {
  current = page;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === page.id));
  PAGES.forEach((p) => $('#' + p.id).classList.toggle('hide', p !== page));
  $('#title').textContent = page.title;
  closeDrawer();
  refresh(true, payload);
}
onNavigate((id, payload) => show(PAGES.find((p) => p.id === id), payload)); // lets a page open another page with context

const app = document.querySelector('.app');
if (localStorage.getItem('prompthole.sb') === '1') app.classList.add('collapsed');
$('#sbT').onclick = () => { app.classList.toggle('collapsed'); localStorage.setItem('prompthole.sb', app.classList.contains('collapsed') ? '1' : '0'); };
$$('#tabs button').forEach((b) => { b.title = b.textContent.trim(); b.onclick = () => show(PAGES.find((p) => p.id === b.dataset.t)); });

initDrawer();
initImport();
PAGES.forEach((p) => p.init?.());
refresh(true);
// poll every 2.5 s, slower after failures, and not at all while the tab is hidden
const tick = () => setTimeout(async () => { if (!document.hidden) await refresh(false); tick(); }, Math.min(2500 * 2 ** failures, 20000));
tick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
