// Every page's inline scripts must at least parse. One stray duplicate declaration stops a whole
// page — the staff portal included — from running at all, and nothing else here would notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const DIR = new URL('../demo/', import.meta.url);
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.html'))) {
  test(`${file}: its scripts parse`, () => {
    const html = readFileSync(new URL(file, DIR), 'utf8');
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
      .filter(([, attrs]) => !/type="(module|application\/ld\+json)"/.test(attrs)).map((m) => m[2]);
    scripts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: `${file}#${i}` }), `script ${i} of ${file}`));
  });
}
