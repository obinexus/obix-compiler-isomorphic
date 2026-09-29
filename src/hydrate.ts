import { renderToString } from './render.js';
import type { ObixComponent } from 'obix-compiler-fudguard';

/** Anything that exposes its markup, such as a DOM `Element`. Declared structurally: no DOM lib. */
export interface HydrationRoot {
  readonly innerHTML: string;
}

export interface HydrationResult {
  /** True when the server-rendered markup equals what the component renders now. */
  readonly matches: boolean;
  readonly expected: string;
  readonly actual: string;
}

const normalize = (markup: string): string => markup.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

/**
 * Check that server-rendered markup in `root` matches the component's initial render, before the
 * browser runtime takes over. This package never mounts anything; hand off by calling `mount()`
 * from `obix-compiler-reactive` when `matches` is true.
 *
 * The comparison is textual (whitespace-normalised), so a browser that re-serialises attributes
 * differently can report a mismatch for markup that is semantically equal.
 */
export function hydrate<S extends object>(component: ObixComponent<S>, root: HydrationRoot, state?: S): HydrationResult {
  const expected = normalize(renderToString(component, state));
  const actual = normalize(root.innerHTML);
  return { matches: expected === actual, expected, actual };
}
