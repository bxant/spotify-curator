// Tiny DOM helpers shared by every view (no framework): element builder, icons, buttons.

export type Child = Node | string | null | undefined | false;

export function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

export const ICONS = {
  note: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z',
  tag: 'M21.4 11.6 12.4 2.6A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9a2 2 0 0 0 2.82 0l7-7a2 2 0 0 0 0-2.82ZM6.5 8A1.5 1.5 0 1 1 6.5 5a1.5 1.5 0 0 1 0 3Z',
  shuffle:
    'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41ZM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5Zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13Z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM2 13h2v-2H2v2Zm18 0h2v-2h-2v2ZM11 2v2h2V2h-2Zm0 18v2h2v-2h-2ZM5.99 4.58 4.58 5.99l1.41 1.42L7.41 6 5.99 4.58Zm12.02 12.03-1.41 1.41 1.41 1.42 1.42-1.42-1.42-1.41ZM19.42 6 18 4.58 16.59 6 18 7.41 19.42 6ZM7.41 18.01 6 16.59l-1.42 1.42L6 19.42l1.41-1.41Z',
  moon: 'M12.3 22a10 10 0 0 1-2.9-19.57A8 8 0 0 0 21.57 14.6 10 10 0 0 1 12.3 22Z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z',
  filter: 'M10 18h4v-2h-4v2ZM3 6v2h18V6H3Zm3 7h12v-2H6v2Z',
  bars: 'M10 20h4V4h-4v16Zm-6 0h4v-8H4v8Zm12-11v11h4V9h-4Z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z',
} as const;

export function icon(name: keyof typeof ICONS): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

export function button(label: Child | Child[], attrs: Record<string, string>, onClick: () => void): HTMLButtonElement {
  const el = h('button', { type: 'button', ...attrs }, ...(Array.isArray(label) ? label : [label])) as HTMLButtonElement;
  el.addEventListener('click', onClick);
  return el;
}
