import type { MetadataRoute } from 'next';

/**
 * Web app manifest — the "installed game" path to a truly maximized
 * experience on phones: "Add to Home Screen" launches RATFIRE with
 * `display: fullscreen`, so NO browser top bar, tab strip or address bar
 * exists at all (on Android even the system status bar is hidden).
 * This complements the in-browser Fullscreen API auto-request in page.tsx,
 * which maximizes the game during normal browsing sessions.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RATFIRE — Voxel Arena',
    short_name: 'RATFIRE',
    description:
      'Third-person voxel shooter: minecraft terrain, day/night cycle, rain, touch controls.',
    start_url: '/',
    display: 'fullscreen',
    orientation: 'any',
    background_color: '#0b0b0f',
    theme_color: '#0b0b0f',
    icons: [
      {
        src: '/logo.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
