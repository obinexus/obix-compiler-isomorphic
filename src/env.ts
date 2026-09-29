// Local declarations keep this package free of the DOM lib: the identifiers below only ever
// appear as `typeof` probes, which are safe when the global does not exist.
declare const window: unknown;
declare const document: unknown;

/**
 * True when running where a DOM exists. Use it only at adapter boundaries (for example to choose
 * between server and client entry points), never inside a component's render.
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
