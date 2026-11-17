// The slide-in panel on the right, used for request details.
import { $ } from './dom.js';

export const openDrawer = (html) => { $('#dr').innerHTML = html; $('#dr').classList.add('open'); };
export const closeDrawer = () => $('#dr').classList.remove('open');
export const initDrawer = () => addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
