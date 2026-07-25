// Bundles the harness into ONE self-contained .html — no server, no assets, no base-path trap.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'dist-harness/harness.html';
const res = await build({
  entryPoints: ['src/harness/main.ts'],
  bundle: true, format: 'iife', target: 'es2020', write: false, logLevel: 'warning',
});
const js = res.outputFiles[0].text;
const html = readFileSync('src/harness/harness.html', 'utf8')
  .replace('<!--BUNDLE-->', `<script>\n${js}</script>`);
mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(1)} kB`);
