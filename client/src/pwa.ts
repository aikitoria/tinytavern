// Android WebAPK intent filters omit ports, so dev and prod need disjoint paths.
export const pwaStartUrl = (development: boolean) => (development ? '/dev/' : '/prod/');

export function pwaManifest(development: boolean) {
  const name = development ? 'TinyTavern Dev' : 'TinyTavern';
  const icon = development ? '/icon-dev' : '/icon';
  return {
    // Preserve the identity inferred from production's original start_url.
    id: development ? '/dev/' : '/',
    name,
    short_name: name,
    description: 'Tiny but mighty LLM chat frontend',
    start_url: pwaStartUrl(development),
    scope: pwaStartUrl(development),
    display: 'standalone',
    background_color: '#111113',
    theme_color: '#111113',
    icons: [
      { src: `${icon}.svg?v=tt2`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: `${icon}-192.png?v=tt2`, sizes: '192x192', type: 'image/png' },
      { src: `${icon}-512.png?v=tt2`, sizes: '512x512', type: 'image/png' },
    ],
  };
}
