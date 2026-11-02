// Lets a node test import the real ui/ modules, which use absolute browser paths ('/config.js').
// Each test file runs in its own process, so hooks and globals set here stay in that file.
import { registerHooks } from 'node:module';

export const UI = new URL('../../ui/', import.meta.url);

const stubUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

// stubs: { '/app.js': 'export function toast(){}' } replaces a module with the given source.
export function resolveUiModules(stubs = {}) {
  registerHooks({
    resolve(spec, ctx, next) {
      if (stubs[spec]) return { url: stubUrl(stubs[spec]), shortCircuit: true };
      if (spec.startsWith('/') && !spec.startsWith('//')) return next(new URL(spec.slice(1), UI).href, ctx);
      return next(spec, ctx);
    },
  });
}

export function installStorage() {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  });
  return store;
}
