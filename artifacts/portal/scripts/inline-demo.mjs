// Turn dist-demo/ into one self-contained HTML file (scripts, styles and brand images inlined).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const dist = new URL('../dist-demo/', import.meta.url).pathname;
const assets = join(dist, 'assets');
let html = readFileSync(join(dist, 'index.html'), 'utf8');
const js = readdirSync(assets).find((f) => f.endsWith('.js'));
const css = readdirSync(assets).find((f) => f.endsWith('.css'));
let code = readFileSync(join(assets, js), 'utf8');
const pub = new URL('../public/', import.meta.url).pathname;
for (const img of ['greystone-icon-white.png', 'greystone-icon-navy.png', 'greystone-wordmark.png']) {
  const data = `data:image/png;base64,${readFileSync(join(pub, img)).toString('base64')}`;
  code = code.split(`/${img}`).join(data);
  html = html.split(`/${img}`).join(data);
}
const before = html.length;
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="\/assets\/[^"]+"[^>]*>/, () => `<style>${readFileSync(join(assets, css), 'utf8')}</style>`);
html = html.replace(/<script[^>]*src="\/assets\/[^"]+"[^>]*><\/script>/, () => `<script type="module">${code.replace(/<\/script>/g, '<\\/script>')}</script>`);
if (html.includes('/assets/')) throw new Error('an /assets/ reference survived inlining');
if (html.length < before + code.length) throw new Error('script was not inlined');
writeFileSync(join(dist, 'portal-demo.html'), html);
console.log('wrote dist-demo/portal-demo.html', Math.round(html.length / 1024), 'KB');
