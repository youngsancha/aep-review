// Static link check of the PWA's module graph. There is no bundler, so nothing else checks these.
//
//  · A named import the target does not export is a SyntaxError at link time: the whole app goes
//    blank, and no unit test sees it because each test imports a single leaf. The browser harness
//    cannot see it either for /db.js, which it swaps for a mock.
//  · The module list lives in three places: the real import graph, the importmap in index.html, and
//    SHELL_CRITICAL in the service worker. If they drift the app still works online and only the
//    offline boot dies: a module missing from the importmap is requested without ?v=, which is not
//    the key the service worker cached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const read = (p) => readFileSync(p, 'utf8');
const pathOf = (spec) => join(UI, spec.split('?')[0]);

const STATIC_IMPORT = /^\s*(?:import|export)\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function namedImports(clause) {
  const out = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  const beforeBrace = clause.split('{')[0].replace(/,/g, ' ').trim();
  if (beforeBrace && !beforeBrace.startsWith('*')) out.push('default');
  return out;
}

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {     // unanchored: the vendored bundle is minified
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^\s*export\s+default\b/m.test(src)) names.add('default');
  return names;
}

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'vendor') jsFiles(p, out); }
    else if (name.endsWith('.js') && !name.startsWith('_') && name !== 'service-worker.js') out.push(p);
  }
  return out;
}

// spec paths ('/views/episode.js') reachable from the entry module, static and dynamic.
function reachable(entry) {
  const seen = new Set();
  const walk = (spec) => {
    if (seen.has(spec)) return;
    seen.add(spec);
    if (spec.endsWith('.mjs')) return;        // vendored bundle, imports nothing of ours
    const src = read(pathOf(spec));
    for (const m of src.matchAll(STATIC_IMPORT)) walk(m[2]);
    for (const m of src.matchAll(DYNAMIC_IMPORT)) walk(m[1]);
  };
  walk(entry);
  return seen;
}

const graph = reachable('/app.js');

test('every named import resolves to a real export', () => {
  const broken = [];
  for (const file of jsFiles(UI)) {
    const src = read(file);
    for (const m of src.matchAll(STATIC_IMPORT)) {
      const target = pathOf(m[2]);
      if (!existsSync(target)) { broken.push(`${relative(UI, file)}: missing file ${m[2]}`); continue; }
      const exported = exportsOf(read(target));
      for (const name of namedImports(m[1])) {
        if (!exported.has(name)) broken.push(`${relative(UI, file)}: ${m[2]} has no export '${name}'`);
      }
    }
    for (const m of src.matchAll(DYNAMIC_IMPORT)) {
      if (!existsSync(pathOf(m[1]))) broken.push(`${relative(UI, file)}: missing file ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('the parser really sees imports (guards this test against silently matching nothing)', () => {
  assert.ok(graph.size >= 15, `only ${graph.size} modules reachable`);
  assert.ok(graph.has('/views/episode.js') && graph.has('/vendor/supabase-js.mjs'));
  assert.deepEqual(namedImports('{ a, b as c }'), ['a', 'b']);
  assert.deepEqual(namedImports('* as ns'), []);
  assert.deepEqual(namedImports('def, { a }'), ['a', 'default']);
  assert.deepEqual([...exportsOf('export { x as y };\nexport async function f() {}')].sort(), ['f', 'y']);
});

test('every reachable module is in the importmap, and the importmap lists nothing else', () => {
  const html = read(join(UI, 'index.html'));
  const block = /const paths = \[([\s\S]*?)\];/.exec(html);
  assert.ok(block, 'paths list not found in index.html');
  const mapped = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...graph].sort(), [...mapped].sort());
});

test('every reachable module is precached as critical, with the versioned key', () => {
  const sw = read(join(UI, 'service-worker.js'));
  const block = /const SHELL_CRITICAL = \[([\s\S]*?)\n\];/.exec(sw);
  assert.ok(block, 'SHELL_CRITICAL not found in service-worker.js');
  const shell = new Set([...block[1].matchAll(/'([^']+)'\s*\+\s*Q/g)].map((m) => m[1]));
  const css = '/style.css';
  assert.ok(shell.has(css), 'style.css must be precached');
  shell.delete(css);
  assert.deepEqual([...graph].sort(), [...shell].sort());
});

test('no module under ui/ is orphaned', () => {
  const onDisk = jsFiles(UI).map((p) => '/' + relative(UI, p).split(sep).join('/'));
  // config.js is imported by everything; app.js is the entry. Anything else unreachable is dead weight.
  const orphans = onDisk.filter((spec) => !graph.has(spec));
  assert.deepEqual(orphans, []);
});
