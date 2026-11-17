// Entry point: sidebar, tab routing and the refresh loop. Each page is { id, title, init?, load(first) }.
import { $, $$ } from './dom.js';
import { initDrawer, closeDrawer } from './drawer.js';
import { overview } from './pages/overview.js';
import { requests } from './pages/requests.js';
import { commands } from './pages/commands.js';
import { rules } from './pages/rules.js';
import { initImport } from './pages/import.js';
import { clients } from './pages/clients.js';
import { setup } from './pages/setup.js';

const PAGES = [overview, requests, commands, rules, clients, setup];
const LIVE = new Set(['over', 'log', 'commands']); // refreshed on the timer; the others only when opened
let current = overview;

const refresh = async (first) => {
  if (first || LIVE.has(current.id)) await current.load(first);
  $('#stamp').textContent = new Date().toLocaleTimeString();
};

function show(page) {
  current = page;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === page.id));
  PAGES.forEach((p) => $('#' + p.id).classList.toggle('hide', p !== page));
  $('#title').textContent = page.title;
  closeDrawer();
  refresh(true);
}

const app = document.querySelector('.app');
if (localStorage.getItem('prompthole.sb') === '1') app.classList.add('collapsed');
$('#sbT').onclick = () => { app.classList.toggle('collapsed'); localStorage.setItem('prompthole.sb', app.classList.contains('collapsed') ? '1' : '0'); };
$$('#tabs button').forEach((b) => { b.title = b.textContent.trim(); b.onclick = () => show(PAGES.find((p) => p.id === b.dataset.t)); });

initDrawer();
initImport();
PAGES.forEach((p) => p.init?.());
refresh(true);
setInterval(() => refresh(false), 2500);
