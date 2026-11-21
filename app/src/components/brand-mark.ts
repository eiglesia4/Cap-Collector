// The CapCollector brand mark (CAP-74, doc/spec/design/brand/README.md): the copper crown cap, inlined as SVG from
// app/design/mark-on-light.svg (a copy of the architect's file) so it scales crisply and needs no extra request.
// SPEC-GAP CAP-74: the story asks for mark-on-dark in dark mode, but the app has no dark theme (the ground stays
// #FAFAF7 whatever the system appearance), so the sign-in screen always uses mark-on-light; mark-on-dark is used by
// the dark launch image only, until a dark theme exists.
import markOnLight from '../../design/mark-on-light.svg?raw';

/** The mark as an inline, decorative `<svg>` (`data-brand-mark`), sized by CSS through `class`. */
export function BrandMark(props: { readonly class: string }): SVGSVGElement {
  const template = document.createElement('template');
  // Drop the XML prolog and the source comment: the HTML parser takes the bare <svg> element.
  template.innerHTML = markOnLight
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  const svg = template.content.querySelector('svg');
  if (!(svg instanceof SVGSVGElement)) throw new Error('brand mark: mark-on-light.svg has no <svg> root');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('class', props.class);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.dataset.brandMark = 'cap';
  return svg;
}
