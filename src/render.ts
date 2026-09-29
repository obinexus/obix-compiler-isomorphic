import { guardRender, toHtmlString, type ObixComponent } from 'obix-compiler-fudguard';

/**
 * Render a component to an HTML string. The pipeline is the same deterministic one the browser
 * runtime uses:
 *
 * ```text
 * state -> render -> fudguard -> HTML string
 * ```
 *
 * Nothing here touches a DOM. `state` defaults to the component's initial state. Throws
 * `FudViolationError` if the output violates an accessibility policy.
 */
export function renderToString<S extends object>(component: ObixComponent<S>, state?: S): string {
  const guarded = guardRender(component);
  return toHtmlString(guarded.render(state ?? component.state));
}
