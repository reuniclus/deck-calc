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

// derived `others` must track every count edit and every deck-size change
const othersVal = () => d.querySelector('.others input').value;
const setCount = (i, v) => {
  const el = d.querySelectorAll('#groups input.count')[i];
  el.value = String(v); el.dispatchEvent(new dom.window.Event('input'));
};
d.querySelector('button.dpreset[data-n="99"]').click();
setCount(0, 4); setCount(1, 5);
console.log('others 99/4+5:', othersVal(), othersVal() === '90' ? 'OK' : 'WRONG (expected 90)');
setCount(1, 12);
console.log('others 99/4+12:', othersVal(), othersVal() === '83' ? 'OK' : 'WRONG (expected 83)');
d.querySelector('button.dpreset[data-n="40"]').click();
console.log('others 40/4+12:', othersVal(), othersVal() === '24' ? 'OK' : 'WRONG (expected 24)');
setCount(0, 30);
console.log('overfill class:', d.querySelector('.others').className,
  txt('warn').slice(0, 40));

// ── queries follow group IDs, not names ──────────────────────────────────────
setCount(0, 4); setCount(1, 3);
const qbox = d.getElementById('query');
const setName = (i, v) => {
  const el = d.querySelectorAll('#groups input.name')[i];
  el.value = v; el.dispatchEvent(new dom.window.Event('input'));
};
qbox.value = 'A>=1 & B>=1'; qbox.dispatchEvent(new dom.window.Event('input'));
const pBefore = txt('summary');
setName(0, 'blink etb');
console.log('after rename :', qbox.value);
console.log('  same result:', txt('summary') === pBefore ? 'OK (unchanged)' : 'WRONG');
console.log('  status     :', txt('status').slice(0, 40));
setName(0, 'any');
console.log('keyword name :', qbox.value, '->', txt('status').slice(0, 30));
setName(0, 'A');
d.querySelector('#groups button.del').click();
console.log('after delete :', txt('status'));
