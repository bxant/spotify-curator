// Musicians Corner pages (#/musicians, opened in its own tab from the curator's header).
// It shows the key playlists of the current suggestions for playing along: each song's key,
// a capo hint for easy open shapes, and links that open Ultimate Guitar's chord search and
// the track in Spotify in new tabs. The playlist pages themselves are the curator's (track
// removal, Create in Spotify), with the play-along columns added through `musicianColumns`.

import { camelot } from '../curate';
import { button, h, type Child } from '../dom';
import { musiciansPlaylistHref } from '../route';
import type { CuratedPlaylist, LikedTrack, TrackKey } from '../types';
import { capoAdvice, capoHint, capoLabel, chordsUrl, isEasyKey, keyPlaylists, playUrl, playlistKey } from './guitar';

/** What the corner needs from the curator page, which owns covers, badges and Create in Spotify. */
export interface CornerUi {
  cover: (p: CuratedPlaylist) => HTMLElement;
  /** Create in Spotify, or Open in Spotify once it is there. */
  createControls: (p: CuratedPlaylist) => HTMLElement;
  /** Whether the playlist is already in the owner's Spotify. */
  saved: (p: CuratedPlaylist) => boolean;
  /** Remembers the scroll position before a playlist page opens. */
  beforeOpen: () => void;
}

export interface CornerState {
  /** The current suggestions (as shown, plus any already saved in Spotify). */
  playlists: CuratedPlaylist[];
  easy: boolean;
  /** Keys are still being looked up, so key playlists may still appear. */
  keysLoading: boolean;
}

export const EASY_KEYS_TEXT = 'G, C, D, A or E major, or E, A or D minor';

/** The Musicians Corner home: the easy-keys filter and a card per key playlist. */
export function musiciansHome(state: CornerState, ui: CornerUi, onEasy: (easy: boolean) => void): HTMLElement {
  const all = keyPlaylists(state.playlists, false);
  const shown = keyPlaylists(state.playlists, state.easy);

  const easy = h('input', { type: 'checkbox', id: 'easy-keys' }) as HTMLInputElement;
  easy.checked = state.easy;
  easy.addEventListener('change', () => onEasy(easy.checked));

  return h(
    'section',
    { class: 'corner', 'aria-labelledby': 'corner-title' },
    h(
      'header',
      { class: 'corner-head' },
      h('div', { class: 'eyebrow muted' }, 'Musicians Corner'),
      h('h1', { id: 'corner-title', tabindex: '-1' }, 'Play along to your key playlists'),
      h(
        'p',
        { class: 'muted' },
        'The key playlists from your current recommendations. Every song shows its key and where to put a capo to play it with easy open chords. ',
        'Chords ↗ searches Ultimate Guitar for the song and Play ↗ opens it in Spotify, each in a new tab.',
      ),
      h(
        'label',
        { class: 'easy-toggle', for: 'easy-keys' },
        easy,
        h('span', {}, h('strong', {}, 'Easy guitar keys only'), h('span', { class: 'muted small' }, ` — ${EASY_KEYS_TEXT}: open chords, no capo`)),
      ),
      h('p', { class: 'recs-count', role: 'status' }, all.length === 0 ? '' : shown.length === all.length ? `${all.length} key playlists` : `${shown.length} of ${all.length} key playlists`),
    ),
    shown.length > 0
      ? h('div', { class: 'grid' }, ...shown.map((p) => cornerCard(p, state.easy, ui)))
      : emptyState(state, all.length, () => onEasy(false)),
  );
}

function emptyState(state: CornerState, total: number, showAll: () => void): HTMLElement {
  if (total > 0) {
    return h(
      'div',
      { class: 'muted empty' },
      h('p', {}, `None of your ${total} key playlists is in an easy key (${EASY_KEYS_TEXT}).`),
      h('p', {}, 'Each one still has a capo hint. For other keys, curate a different set in the curator tab, then reopen Musicians Corner ↗ from there.'),
      button('Show all keys', { class: 'ghost small' }, showAll),
    );
  }
  if (state.keysLoading) {
    return h(
      'div',
      { class: 'panel corner-loading' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', {}, 'Finding the musical keys of your liked songs… Key playlists appear here when the lookup finishes.'),
      h('p', { class: 'muted small' }, 'Progress is shown in the corner of the page.'),
    );
  }
  return h(
    'div',
    { class: 'muted empty' },
    h('p', {}, 'No key playlists in your current recommendations.'),
    h('p', {}, 'Key playlists need at least 15 liked songs in one key. Curate a different set in the curator tab, then reopen Musicians Corner ↗ from there, or check back after liking more songs.'),
  );
}

function cornerCard(p: CuratedPlaylist, easy: boolean, ui: CornerUi): HTMLElement {
  const link = h('a', { class: 'card-link', href: musiciansPlaylistHref(p.key, easy) }, p.name);
  link.addEventListener('click', ui.beforeOpen);
  const k = playlistKey(p);
  return h(
    'article',
    { class: `card kind-key${ui.saved(p) ? ' is-saved' : ''}` },
    h(
      'div',
      { class: 'card-head' },
      ui.cover(p),
      h(
        'div',
        { class: 'card-title' },
        h(
          'div',
          { class: 'badges' },
          k && h('span', { class: 'badge' }, `Camelot ${camelot(k)}`),
          isEasyKey(k) && h('span', { class: 'badge easy' }, 'Easy key'),
          ui.saved(p) && h('span', { class: 'badge saved' }, 'In your Spotify'),
        ),
        h('h3', {}, link),
        h('div', { class: 'meta' }, `${p.tracks.length} tracks`),
      ),
    ),
    h(
      'div',
      { class: 'card-body' },
      k && h('p', { class: 'capo-advice' }, capoAdvice(k)),
      h('span', { class: 'open-hint', 'aria-hidden': 'true' }, 'Open to play along →'),
      ui.createControls(p),
    ),
  );
}

/** A column the track table adds to each row. */
export interface TrackColumn {
  header: string;
  cls: string;
  cell: (t: LikedTrack) => Child;
}

/** The play-along columns of a Musicians Corner playlist page: capo hint, then the outbound links. */
export function musicianColumns(trackKeys: Record<string, TrackKey | null>): TrackColumn[] {
  return [
    {
      header: 'Capo',
      cls: 'col-capo',
      cell: (t) => {
        const k = trackKeys[t.id];
        if (!k) return h('span', { class: 'muted' }, 'Key unknown');
        return h('span', { title: capoAdvice(k), class: capoHint(k).capo === 0 ? 'capo easy' : 'capo' }, capoLabel(k));
      },
    },
    {
      header: 'Play along',
      cls: 'col-links',
      cell: (t) =>
        h(
          'div',
          { class: 'play-links' },
          outbound(chordsUrl(t), 'Chords ↗', `Search Ultimate Guitar for chords and tabs of ${t.name} (opens in a new tab)`),
          outbound(playUrl(t), 'Play ↗', `Play ${t.name} on Spotify (opens in a new tab)`),
        ),
    },
  ];
}

function outbound(href: string, label: string, description: string): HTMLElement {
  return h('a', { class: 'button ghost small', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': description, title: description }, label);
}
