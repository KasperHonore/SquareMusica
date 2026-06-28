import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';

// Static guard against broken relative imports after the layered restructure.
// The app cannot be booted in CI (better-sqlite3 native binary), so this walks
// every backend + test source file, extracts each RELATIVE import/export/dynamic
// specifier, and asserts the target resolves to a real file on disk. A wrong path
// passes `node --check` but explodes at runtime, so this is the safety net.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/** Recursively collect *.js files under a directory. */
function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...collectJsFiles(full));
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// Matches: import ... from '<spec>'; export ... from '<spec>'; import('<spec>')
const SPEC_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Resolve a relative module specifier to an existing file, or null if missing. */
function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, 'index.js')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) || null;
}

describe('relative import resolution', () => {
  const files = [
    ...collectJsFiles(join(repoRoot, 'src')),
    ...collectJsFiles(join(repoRoot, 'test'))
  ];

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every relative import/export/dynamic specifier resolves to a real file', () => {
    const missing = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(SPEC_RE)) {
        const spec = match[1] ?? match[2];
        if (!spec || !spec.startsWith('.')) continue; // only relative specifiers
        if (!resolveRelative(file, spec)) {
          missing.push(`${file.replace(repoRoot, '.')} -> ${spec}`);
        }
      }
    }

    expect(missing, `Unresolved relative imports:\n${missing.join('\n')}`).toEqual([]);
  });

  it('db.js can read schema.sql from its own directory', () => {
    const dbFile = join(repoRoot, 'src', 'persistence', 'db.js');
    const schemaPath = join(dirname(dbFile), 'schema.sql');
    expect(existsSync(schemaPath), `schema.sql missing at ${schemaPath}`).toBe(true);
  });
});
