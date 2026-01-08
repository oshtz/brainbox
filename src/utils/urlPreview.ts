/**
 * URL Preview Utilities for brainbox
 *
 * This module provides functions for URL validation, YouTube detection,
 * thumbnail generation, and favicon retrieval.
 */

/**
 * Checks if a string is a valid HTTP/HTTPS URL
 *
 * @param input - The string to check
 * @returns True if the input is a valid http:// or https:// URL
 *
 * @example
 * isUrl('https://example.com') // true
 * isUrl('ftp://example.com')   // false
 * isUrl('not a url')           // false
 */
export function isUrl(input?: string): boolean {
  if (!input) return false;
  try {
    const u = new URL(input);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Checks if a URL is a YouTube video URL
 *
 * Supports:
 * - youtube.com/watch?v=...
 * - youtube.com/shorts/...
 * - youtube.com/live/...
 * - youtu.be/...
 *
 * @param input - The URL to check
 * @returns True if the URL is a YouTube video URL
 */
export function isYouTubeUrl(input?: string): boolean {
  if (!isUrl(input)) return false;
  try {
    const u = new URL(input!);
    const host = u.hostname.toLowerCase();
    if (host.endsWith('youtube.com')) {
      return u.pathname.startsWith('/watch') || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/');
    }
    if (host === 'youtu.be') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Extracts the YouTube video ID from a URL
 *
 * @param input - The YouTube URL
 * @returns The video ID, or null if not a valid YouTube URL
 *
 * @example
 * getYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') // 'dQw4w9WgXcQ'
 * getYouTubeId('https://youtu.be/dQw4w9WgXcQ')                // 'dQw4w9WgXcQ'
 * getYouTubeId('https://youtube.com/shorts/abc123')           // 'abc123'
 */
export function getYouTubeId(input?: string): string | null {
  if (!isUrl(input)) return null;
  try {
    const u = new URL(input!);
    if (u.hostname.toLowerCase() === 'youtu.be') {
      return u.pathname.replace(/^\//, '') || null;
    }
    if (u.hostname.toLowerCase().endsWith('youtube.com')) {
      if (u.pathname.startsWith('/watch')) return u.searchParams.get('v');
      if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/')[2] || null;
      if (u.pathname.startsWith('/live/')) return u.pathname.split('/')[2] || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Generates a YouTube thumbnail URL for a video ID
 *
 * @param id - The YouTube video ID
 * @param quality - Thumbnail quality: 'max' (1280x720), 'hq' (480x360), 'mq' (320x180)
 * @returns The thumbnail URL
 *
 * @example
 * youtubeThumbnailUrl('dQw4w9WgXcQ', 'hq')
 * // 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
 */
export function youtubeThumbnailUrl(id: string, quality: 'max' | 'hq' | 'mq' = 'hq'): string {
  const file = quality === 'max' ? 'maxresdefault.jpg' : quality === 'mq' ? 'mqdefault.jpg' : 'hqdefault.jpg';
  return `https://i.ytimg.com/vi/${id}/${file}`;
}

/**
 * Generates a YouTube embed URL for a video ID
 *
 * @param id - The YouTube video ID
 * @returns The embed URL suitable for iframes
 */
export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube.com/embed/${id}`;
}

/**
 * Gets a favicon URL for a given website URL using Google's favicon service
 *
 * @param input - The website URL
 * @returns The favicon URL, or null if the input is not a valid URL
 *
 * @example
 * faviconForUrl('https://github.com')
 * // 'https://www.google.com/s2/favicons?sz=64&domain=github.com'
 */
export function faviconForUrl(input?: string): string | null {
  if (!isUrl(input)) return null;
  try {
    const u = new URL(input!);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  } catch {
    return null;
  }
}

