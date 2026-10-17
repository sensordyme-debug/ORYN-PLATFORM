import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LAYER_STATE_REGISTRY } from '../../data/layerState.js';
import {
  HOST_CCTV_PACKS,
  HOST_LAYER_LICENCES,
  HOST_MAP_STACKS,
  hostLayerLicence,
  hostLayerOffered,
  installHostLicenceGuard,
} from './hostLicences.js';
import {
  NONCOMMERCIAL_MODULE_STUBS,
  NONCOMMERCIAL_PUBLIC_PATHS,
  NONCOMMERCIAL_REPLACEMENTS,
  applyNoncommercialReplacements,
  noncommercialExclusionPlugin,
} from '../../../build/noncommercial.js';
import { createBrowserViteConfig } from '../../../build/vite.js';
import { MAP_STACKS, PUBLIC_IMAGERY_STACK } from '../../maps/catalog.js';
import { createDefaultMapSources } from '../../maps/defaultSources.js';

const ORYN = HOST_LAYER_LICENCES.oryn;
const LAYER_IDS = [...LAYER_STATE_REGISTRY.map((e) => e.id), 'local-adsb'];

test('every engine layer has an explicit ORYN licence decision', () => {
  for (const id of LAYER_IDS) assert.ok(ORYN[id], `no decision for ${id}`);
  for (const id of Object.keys(ORYN))
    assert.ok(LAYER_IDS.includes(id), `policy for unknown layer ${id}`);
});

test('offered layers name their nature and every source licence; withheld ones say why', () => {
  const natures = [
    'observed',
    'forecast',
    'computed',
    'estimated',
    'reference',
  ];
  for (const [id, policy] of Object.entries(ORYN)) {
    if (policy.status === 'offered') {
      assert.ok(natures.includes(policy.nature), `${id} nature`);
      assert.ok(policy.sources.length > 0, `${id} sources`);
      for (const s of policy.sources) {
        assert.ok(s.name && s.licence && s.attribution, `${id} source fields`);
      }
    } else {
      assert.equal(policy.status, 'withheld');
      assert.ok(policy.reason && policy.reason.length > 10, `${id} reason`);
    }
  }
});

test('non-commercial, simulated and unverified layers are withheld in ORYN', () => {
  for (const id of [
    'telegeography-submarine-cables',
    'bhote-koshi-2026',
    'bhote-koshi-locator',
    'traffic',
    'ais-live-vessels',
    'directions',
    'gnss-integrity',
    'fire-perimeters',
    'satellites',
    'street-level',
  ])
    assert.equal(hostLayerOffered('oryn', id), false, id);
  assert.equal(hostLayerLicence('oryn', 'not-a-layer').status, 'withheld');
  // Outside a known host nothing is restricted.
  assert.equal(hostLayerLicence(null, 'traffic'), null);
  assert.equal(hostLayerOffered(null, 'traffic'), true);
});

test('the lifecycle guard refuses withheld layers on every path and allows offered ones', async () => {
  let guard = null;
  const unsubscribe = installHostLicenceGuard(
    {
      addVisibilityGuard: (fn) => {
        guard = fn;
        return () => (guard = null);
      },
    },
    'oryn',
  );
  assert.match(
    guard({ layerId: 'traffic', enabled: true, origin: 'share-state' }),
    /Not available in this deployment: .*simulated/,
  );
  assert.equal(
    guard({ layerId: 'earthquakes', enabled: true, origin: 'user' }),
    null,
  );
  // Turning a layer off is never blocked.
  assert.equal(
    guard({ layerId: 'traffic', enabled: false, origin: 'user' }),
    null,
  );
  unsubscribe();
  assert.equal(guard, null);
});

test('ORYN maps only public-domain imagery and lists only real camera packs', () => {
  assert.deepEqual([...HOST_MAP_STACKS.oryn], ['public-imagery']);
  // Host-only: the standalone catalog is unchanged.
  assert.ok(!MAP_STACKS.some((s) => s.id === PUBLIC_IMAGERY_STACK.id));
  const standalone = createDefaultMapSources({});
  assert.ok(
    !standalone.sources.some((s) => s.descriptor.id === 'public-imagery'),
  );
  const hosted = createDefaultMapSources({
    allowedStackIds: HOST_MAP_STACKS.oryn,
    terrain: 'ellipsoid',
  });
  assert.equal(hosted.defaultId, 'public-imagery');
  const byId = new Map(hosted.sources.map((s) => [s.descriptor.id, s]));
  assert.notEqual(byId.get('public-imagery').available, false);
  for (const id of ['esri-imagery', 'osm', 'photoreal', 'bing-aerial'])
    assert.equal(byId.get(id).available, false, id);
  assert.equal(byId.get('public-imagery').terrain.id, 'ellipsoid');
  for (const pack of HOST_CCTV_PACKS.oryn) assert.match(pack, /^[a-z]+$/);
  for (const excluded of [
    'austin',
    'caltrans',
    'deldot',
    'txdot',
    'nyc',
    'lithuania',
    'tfl',
    'catalonia',
    'toronto',
    'ontario',
    'nsw',
  ])
    assert.ok(!HOST_CCTV_PACKS.oryn.includes(excluded), excluded);
  assert.deepEqual([...HOST_CCTV_PACKS.oryn].sort(), [
    'calgary',
    'drivebc',
    'fintraffic',
    'vegvesen',
  ]);
});

test('commercial build: stubs keep exports, replacements must match, public pack is removed', async () => {
  for (const code of Object.values(NONCOMMERCIAL_MODULE_STUBS)) {
    assert.match(code, /^\/\/ Withheld:/);
    assert.doesNotMatch(code, /\d+\.\d{4,}/);
  }
  const stubbed = await import(
    `data:text/javascript,${encodeURIComponent(NONCOMMERCIAL_MODULE_STUBS['src/data/bhoteKoshiFloodPath.js'])}`
  );
  assert.deepEqual(stubbed.BHOTE_KOSHI_FLOOD_PATH, []);

  assert.throws(
    () =>
      applyNoncommercialReplacements(
        'nothing here',
        NONCOMMERCIAL_REPLACEMENTS['src/data/bhoteKoshiLocator.js'],
        'x.js',
      ),
    /expected one match/,
  );

  const root = mkdtempSync(path.join(tmpdir(), 'gev-nc-'));
  try {
    const plugin = noncommercialExclusionPlugin({ root });
    plugin.configResolved({ root, build: { outDir: 'dist' } });
    const flood = path.join(root, 'src/data/bhoteKoshiFloodPath.js');
    assert.match(
      plugin.load(flood),
      /BHOTE_KOSHI_FLOOD_PATH = Object\.freeze\(\[\]\)/,
    );
    assert.equal(plugin.load(path.join(root, 'src/other.js')), null);
    for (const rel of NONCOMMERCIAL_PUBLIC_PATHS) {
      mkdirSync(path.join(root, 'dist', rel), { recursive: true });
      writeFileSync(path.join(root, 'dist', rel, 'event.json'), '{}');
    }
    plugin.closeBundle();
    for (const rel of NONCOMMERCIAL_PUBLIC_PATHS)
      assert.equal(existsSync(path.join(root, 'dist', rel)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const names = (config) => config.plugins.flat().map((p) => p?.name);
  assert.ok(
    names(createBrowserViteConfig({ excludeNoncommercial: true })).includes(
      'exclude-noncommercial-data',
    ),
  );
  assert.ok(
    !names(createBrowserViteConfig({})).includes('exclude-noncommercial-data'),
  );
});

test('public imagery: GIBS ancestors crop the right quadrant; USGS only inside its coverage', async () => {
  const Cesium = await import('cesium');
  const { gibsAncestor, tileTouchesUsgsCoverage, PUBLIC_IMAGERY_DETAIL_LEVEL } =
    await import('../../maps/imagery.js');
  // At or above GIBS's last level the tile is its own ancestor.
  assert.deepEqual(gibsAncestor(5, 7, 4), {
    x: 5,
    y: 7,
    level: 4,
    sx: 0,
    sy: 0,
    size: 256,
  });
  // Level 10 is two levels below GIBS level 8: a 64-px window of the parent.
  assert.deepEqual(gibsAncestor(1023, 514, 10), {
    x: 255,
    y: 128,
    level: 8,
    sx: 192,
    sy: 128,
    size: 64,
  });
  const scheme = new Cesium.WebMercatorTilingScheme();
  const level = PUBLIC_IMAGERY_DETAIL_LEVEL + 4;
  const tileAt = (lon, lat) => {
    const xy = scheme.positionToTileXY(
      Cesium.Cartographic.fromDegrees(lon, lat),
      level,
    );
    return scheme.tileXYToRectangle(xy.x, xy.y, level);
  };
  assert.equal(tileTouchesUsgsCoverage(tileAt(-77.6, 35.9)), true); // North Carolina
  assert.equal(tileTouchesUsgsCoverage(tileAt(-149.9, 61.2)), true); // Anchorage
  assert.equal(tileTouchesUsgsCoverage(tileAt(2.35, 48.85)), false); // Paris
  assert.equal(tileTouchesUsgsCoverage(tileAt(151.2, -33.9)), false); // Sydney
});
