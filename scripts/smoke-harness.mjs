import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const html = readFileSync('dist-harness/harness.html', 'utf8');
const errs = [];
const dom = new JSDOM(html, { runScripts: 'dangerously' });
dom.virtualConsole.on('jsdomError', (e) => errs.push(e.message));
const d = dom.window.document;
const txt = (id) => (d.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
console.log('errors      :', errs.length ? errs : 'none');
console.log('status      :', txt('status'));
console.log('summary     :', txt('summary'));
console.log('warn        :', txt('warn') || '(clear)');
console.log('deck rows   :', d.querySelectorAll('#groups tbody tr').length);
console.log('others val  :', d.querySelector('.others input')?.value);
console.log('table rows  :', d.querySelectorAll('#table tbody tr').length);
console.log('curve pts   :', (d.querySelector('#curve polyline')?.getAttribute('points') || '').split(' ').length);
console.log('grid cells  :', d.querySelectorAll('#grid table.heat td').length);
const rows = [...d.querySelectorAll('#table tbody tr')].slice(5, 9)
  .map(r => [...r.children].map(c => c.textContent.trim()).join(' | '));
console.log('sample rows :\n  ' + rows.join('\n  '));
// exercise an edit: overfill the deck
const ci = d.querySelector('#groups input.count');
ci.value = '40'; ci.dispatchEvent(new dom.window.Event('input'));
console.log('overfill warn:', txt('warn'));
// bad query
const q = d.getElementById('query');
ci.value = '4'; ci.dispatchEvent(new dom.window.Event('input'));
q.value = 'A >= '; q.dispatchEvent(new dom.window.Event('input'));
console.log('parse err   :', txt('status'));
q.value = 'A=1'; q.dispatchEvent(new dom.window.Event('input'));
console.log('non-mono    :', txt('status'));
console.log('non-mono sum:', txt('summary'));
