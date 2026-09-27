import cryptOfAsh from '../assets/music/crypt-of-ash.mp3?url';

/**
 * The background track. The file is pre-baked (see packages/client/README.md)
 * so its body loops seamlessly: the last 8 s crossfade into the intro, and a
 * 0.5 s copy of the start is appended so the loop points sit safely inside
 * the decoded buffer regardless of MP3 encoder padding.
 */
export const MUSIC_TRACK = {
  url: cryptOfAsh,
  loopStart: 0.25,
  loopEnd: 222.25,
};
