import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Inlines the compiled browser-safe modem modules and the terminal UI into one standalone
 * HTML file, so the web build is a single artifact GitHub Pages can serve with no bundler,
 * no CDN and no network at runtime. The modules are the same tested DSP the CLI uses; only
 * the CommonJS wrapper below is web-specific.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cjsDir = join(root, 'build', 'webcjs');
const outDir = join(root, 'docs');

const modules = readdirSync(cjsDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: f.replace(/\.js$/, ''), code: readFileSync(join(cjsDir, f), 'utf8') }));

const registry = modules
  .map(({ name, code }) => `__def(${JSON.stringify(name)}, function (exports, require, module) {\n${code}\n});`)
  .join('\n');

const runtime = `
(function () {
  var __mods = Object.create(null);
  var __cache = Object.create(null);
  function __def(name, fn) { __mods[name] = fn; }
  function __req(id) {
    var name = String(id).replace(/^\\.\\//, '').replace(/\\.js$/, '');
    if (__cache[name]) return __cache[name].exports;
    var fn = __mods[name];
    if (!fn) throw new Error('module not bundled: ' + id);
    var module = { exports: {} };
    __cache[name] = module;
    fn(module.exports, __req, module);
    return module.exports;
  }
${registry}
  self.QNR = __req('webmodem');
})();
`;

const ui = readFileSync(join(root, 'web', 'app.js'), 'utf8');
const css = readFileSync(join(root, 'web', 'app.css'), 'utf8');
const shell = readFileSync(join(root, 'web', 'index.template.html'), 'utf8');

const html = shell
  .replace('/*__CSS__*/', () => css)
  .replace('/*__MODEM__*/', () => runtime)
  .replace('/*__APP__*/', () => ui);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
writeFileSync(join(outDir, '.nojekyll'), '');

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`docs/index.html  ${kb} kB  (${modules.length} modem modules inlined, no external requests)`);
