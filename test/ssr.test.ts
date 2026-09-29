import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { enforceFud, guardRender } from 'obix-compiler-fudguard';
import { FudViolationError, defineComponent, html, isBrowser, renderToString } from '../src/index.js';
import { hydrate } from '../src/hydrate.js';

const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'customElements', 'MutationObserver', 'matchMedia'] as const;

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const Counter = defineComponent({
  name: 'Counter',
  state: { count: 0 },
  actions: {
    increment: state => ({ count: state.count + 1 }),
    set: (state, value: number) => ({ count: value }),
  },
  render: state => html`
    <section>
      <strong>${state.count}</strong>
      <button data-action="increment">Increment</button>
      <button data-action="set" data-args="[10]">Set to 10</button>
    </section>`,
});

/** Files a built entry point pulls in: its own relative imports and workspace packages, transitively. */
function closureOf(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('node:')) continue;
      const next = specifier.startsWith('.')
        ? resolve(dirname(file), specifier)
        : fileURLToPath(import.meta.resolve(specifier));
      visit(next);
    }
  };
  visit(entry);
  return [...seen];
}

/** Remove comments so prose that mentions a global does not count as a reference. */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Every use of a DOM global other than a bare `typeof x` probe (which is safe when x is absent). */
function domGlobalReferences(source: string): string[] {
  const code = stripComments(source);
  const pattern = new RegExp(`\\b(${DOM_GLOBALS.join('|')})\\b`, 'g');
  const found: string[] = [];
  for (const match of code.matchAll(pattern)) {
    const before = code.slice(Math.max(0, (match.index ?? 0) - 12), match.index);
    if (!/typeof\s+$/.test(before)) found.push(match[0]);
  }
  return found;
}

describe('server rendering', () => {
  it('1. importing SSR under Node succeeds with no DOM globals', () => {
    const entry = pathToFileURL(join(packageDir, 'dist', 'index.js')).href;
    const script = `
      const has = () => ${JSON.stringify(DOM_GLOBALS)}.filter(name => name in globalThis);
      if (has().length) throw new Error('DOM globals present before import: ' + has());
      const mod = await import(${JSON.stringify(entry)});
      if (typeof mod.renderToString !== 'function') throw new Error('renderToString missing');
      if (has().length) throw new Error('import created DOM globals: ' + has());
      console.log('ok');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout.trim(), 'ok');
  });

  it('2. renderToString() succeeds with no window or document', () => {
    for (const name of DOM_GLOBALS) assert.equal(name in globalThis, false, `${name} must not exist in this test process`);
    const output = renderToString(Counter);
    assert.match(output, /<strong>0<\/strong>/);
    assert.equal(isBrowser(), false);
  });

  it('3. built SSR code is scanned for forbidden DOM globals', () => {
    const files = closureOf(join(packageDir, 'dist', 'index.js'));
    assert.ok(files.some(file => file.endsWith('env.js')), 'the environment probe is part of the scanned closure');
    assert.ok(files.some(file => file.includes('fudguard')), 'workspace dependencies are scanned too');
    assert.equal(files.some(file => /reactive/.test(file)), false, 'the browser runtime is not in the SSR closure');

    const violations = files.flatMap(file => domGlobalReferences(readFileSync(file, 'utf8')).map(name => `${file}: ${name}`));
    assert.deepEqual(violations, []);
  });

  it('the DOM-global scanner is not vacuous', () => {
    assert.deepEqual(domGlobalReferences('const w = window.innerWidth;'), ['window']);
    assert.deepEqual(domGlobalReferences('document.querySelector("a"); new MutationObserver(f);'), ['document', 'MutationObserver']);
    assert.deepEqual(domGlobalReferences('globalThis.matchMedia("(x)")'), ['matchMedia']);
    assert.deepEqual(domGlobalReferences("typeof window !== 'undefined' && typeof document !== 'undefined'"), []);
    assert.deepEqual(domGlobalReferences('// window is mentioned in prose\n/* document too */ const a = 1;'), []);
  });

  it('4. rendered output passes fudguard validation', () => {
    const output = renderToString(Counter);
    const report = enforceFud(output, Counter.state);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.ok, true);
  });

  it('5. the same state produces the same initial HTML on every path', () => {
    const server = renderToString(Counter);
    assert.equal(renderToString(Counter), server, 'deterministic across calls');
    assert.equal(renderToString(Counter, Counter.state), server);
    const clientPath = guardRender(Counter);
    assert.equal(clientPath.render(clientPath.state), server, 'the guarded client render path matches');

    const other = renderToString(Counter, { count: 7 });
    assert.match(other, /<strong>7<\/strong>/);
    assert.notEqual(other, server);
  });

  it('throws FudViolationError instead of emitting inaccessible markup', () => {
    const Broken = defineComponent({ name: 'Broken', state: {}, actions: {}, render: () => '<input type="text">' });
    assert.throws(() => renderToString(Broken), FudViolationError);
  });

  it('escapes state interpolated into markup', () => {
    const Greeting = defineComponent({ name: 'Greeting', state: { who: '<img src=x onerror=alert(1)>' }, actions: {}, render: s => html`<p>${s.who}</p>` });
    assert.equal(renderToString(Greeting), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('depends only on fudguard', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['obix-compiler-fudguard']);
  });
});

describe('hydrate (isolated handoff check)', () => {
  it('matches when the markup equals the initial render, ignoring whitespace', () => {
    const markup = renderToString(Counter).replace(/>\s+</g, '>\n  <');
    const result = hydrate(Counter, { innerHTML: markup });
    assert.equal(result.matches, true);
  });

  it('reports a mismatch with both sides', () => {
    const result = hydrate(Counter, { innerHTML: '<p>stale</p>' });
    assert.equal(result.matches, false);
    assert.equal(result.actual, '<p>stale</p>');
    assert.match(result.expected, /<strong>0<\/strong>/);
  });

  it('accepts an explicit state', () => {
    const markup = renderToString(Counter, { count: 3 });
    assert.equal(hydrate(Counter, { innerHTML: markup }, { count: 3 }).matches, true);
    assert.equal(hydrate(Counter, { innerHTML: markup }).matches, false);
  });

  it('the hydrate entry does not import the browser runtime', () => {
    const files = closureOf(join(packageDir, 'dist', 'hydrate.js'));
    assert.equal(files.some(file => /reactive/.test(file)), false);
  });
});
