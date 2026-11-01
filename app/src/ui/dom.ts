// Tiny DOM builder for the vanilla-TS component approach (no framework — decided in CAP-21, 2026-11-01).
// Text children are user-visible: in screens and components they must come from t() (T-app-006 enforces it).

export type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  attrs?: Record<string, string | boolean | undefined>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === true) el.setAttribute(name, '');
    else if (typeof value === 'string') el.setAttribute(name, value);
  }
  for (const [type, listener] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, listener as EventListener);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}
