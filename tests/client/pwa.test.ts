import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { pwaManifest } from '../../client/src/pwa.ts';

test('dev and prod PWAs have disjoint Android scopes even when ports are ignored', () => {
  const manifests = [pwaManifest(true), pwaManifest(false)];
  const origins = ['https://phone.test:5173', 'https://phone.test:5487'];
  const scopes = manifests.map((manifest, index) => new URL(manifest.scope, origins[index]).pathname);
  for (const [index, manifest] of manifests.entries()) {
    const launch = new URL(manifest.start_url, origins[index]);
    assert(launch.pathname.startsWith(scopes[index]!));
    assert(!launch.pathname.startsWith(scopes[1 - index]!), 'Android must not resolve the other installed app');
  }
  assert.notEqual(manifests[0]!.id, manifests[1]!.id);
  assert.notEqual(manifests[0]!.short_name, manifests[1]!.short_name);
  assert.equal(
    new URL(manifests[1]!.id, origins[1]).href,
    origins[1] + '/',
    'Production keeps its existing app identity',
  );
});
