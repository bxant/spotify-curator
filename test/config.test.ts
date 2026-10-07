import { describe, expect, it } from 'vitest';
import { redirectUri } from '../src/config';
import redirects from '../public/_redirects?raw';

describe('redirectUri', () => {
  it('returns to /callback on the page’s own origin, locally and when hosted', () => {
    expect(redirectUri('http://127.0.0.1:8888')).toBe('http://127.0.0.1:8888/callback');
    expect(redirectUri('https://curator.pages.dev')).toBe('https://curator.pages.dev/callback');
  });

  it('is served by the app on Cloudflare Pages', () => {
    const rules = redirects
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(rules).toContain('/callback /index.html 200');
  });
});
