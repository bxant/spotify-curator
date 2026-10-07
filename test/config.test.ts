import { describe, expect, it } from 'vitest';
import { redirectUri } from '../src/config';
import redirects from '../public/_redirects?raw';

interface RedirectRule {
  source: string;
  destination: string;
  status: number;
}

function parseRedirects(text: string): RedirectRule[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [source, destination, status] = line.split(/\s+/);
      return { source, destination, status: status ? Number(status) : 301 };
    });
}

function matches(source: string, path: string): boolean {
  return source.endsWith('*') ? path.startsWith(source.slice(0, -1)) : source === path;
}

describe('redirectUri', () => {
  it('returns to /callback on the page’s own origin, locally and when hosted', () => {
    expect(redirectUri('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888/callback');
    expect(redirectUri('https://curator.pages.dev')).toBe('https://curator.pages.dev/callback');
  });

  it('is served by the app on Cloudflare Pages', () => {
    const rule = parseRedirects(redirects).find((r) => matches(r.source, new URL(redirectUri('https://curator.pages.dev')).pathname));
    expect(rule).toMatchObject({ destination: '/index.html', status: 200 });
  });
});
