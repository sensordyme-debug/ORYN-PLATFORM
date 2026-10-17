import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveHost, applyHostDocument, HOST_NAMES } from './hostMode.js';
import {
  hostFeedState,
  describeRowControls,
  describeLayer,
  eventRef,
  selectionRef,
  scalarFields,
} from './hostBridge.js';
import {
  normalizeBasePath,
  cesiumBasePathPlugin,
  createBrowserViteConfig,
} from '../../../build/vite.js';
import { isEmbedDocumentRequest } from '../../../build/embed-framing.js';

test('only allow-listed hosts enable host mode', () => {
  assert.deepEqual(HOST_NAMES, ['oryn']);
  assert.equal(resolveHost({ search: '?host=oryn' }), 'oryn');
  assert.equal(resolveHost({ search: '?host=evil' }), null);
  assert.equal(resolveHost({ search: '' }), null);
  assert.equal(resolveHost(undefined), null);
});

test('host documents are marked once and load the host fonts once', () => {
  const appended = [];
  const documentRef = {
    documentElement: { dataset: {} },
    head: { appendChild: (node) => appended.push(node) },
    createElement: () => ({ dataset: {} }),
    querySelector: (selector) =>
      appended.find(
        (node) => selector.includes(node.dataset.hostFonts) && node.rel,
      ) ?? null,
  };
  assert.equal(applyHostDocument(null, documentRef), false);
  assert.equal(applyHostDocument('evil', documentRef), false);
  assert.equal(applyHostDocument('oryn', documentRef), true);
  assert.equal(applyHostDocument('oryn', documentRef), true);
  assert.equal(documentRef.documentElement.dataset.host, 'oryn');
  assert.equal(appended.length, 1);
  assert.match(appended[0].href, /^https:\/\/fonts\.googleapis\.com\/.*Geist/);
});

test('feed states map onto the host vocabulary without inventing currency', () => {
  assert.equal(hostFeedState('nominal'), 'current');
  assert.equal(hostFeedState('degraded'), 'partial');
  assert.equal(hostFeedState('stale'), 'stale');
  assert.equal(hostFeedState('unavailable'), 'unavailable');
  assert.equal(hostFeedState('off'), 'off');
  assert.equal(hostFeedState(undefined), 'off');
  const off = describeLayer({ id: 'a', name: 'A', enabled: false, stats: {} });
  assert.equal(off.state, 'off');
  const loading = describeLayer({
    id: 'a',
    name: 'A',
    enabled: true,
    stats: { loading: true },
  });
  assert.equal(loading.state, 'loading');
  const now = Date.now();
  const current = describeLayer(
    {
      id: 'earthquakes',
      name: 'Earthquakes (24h)',
      source: 'USGS',
      enabled: true,
      stats: { count: 5, lastUpdate: now - 1000 },
    },
    { now },
  );
  assert.equal(current.state, 'current');
  assert.equal(current.source, 'USGS');
  assert.equal(current.count, 5);
  const missingKey = describeLayer({
    id: 'local-firms',
    name: 'FIRMS',
    enabled: true,
    requiresKeyId: 'firms',
    stats: { status: 'unavailable', error: 'FIRMS_MAP_KEY not set' },
  });
  assert.equal(missingKey.state, 'unavailable');
  assert.equal(missingKey.requiresKeyId, 'firms');
  assert.equal(missingKey.error, 'FIRMS_MAP_KEY not set');
});

test('row controls are reduced to serializable descriptors', () => {
  assert.equal(describeRowControls(null), null);
  assert.equal(describeRowControls({ chips: [] }), null);
  const onClick = () => {};
  const described = describeRowControls({
    chips: [
      { id: 'all', label: 'All', active: true, onClick },
      { id: 'mil', label: 'Military', params: { mode: 'mil' }, disabled: true },
      { label: 'no id' },
    ],
    legend: [{ label: 'M5+', color: '#e5544b', count: 2 }],
    info: 'Coverage varies',
    list: { items: [{ id: 's1', label: 'Turn left' }] },
  });
  assert.equal(described.chips.length, 2);
  assert.deepEqual(described.chips[0], {
    id: 'all',
    label: 'All',
    active: true,
    state: 'active',
    title: null,
    disabled: false,
  });
  assert.equal(described.chips[1].disabled, true);
  assert.equal('onClick' in described.chips[0], false);
  assert.equal('params' in described.chips[1], false);
  assert.deepEqual(described.legend, [
    { label: 'M5+', color: '#e5544b', count: 2 },
  ]);
  assert.equal(described.info, 'Coverage varies');
  assert.equal(described.items[0].label, 'Turn left');
  JSON.stringify(described);
});

test('event records carry provenance, observation and retrieval times', () => {
  const ref = eventRef(
    'earthquakes',
    {
      id: 'us6000abcd',
      magnitude: 4.8,
      depthKm: 10,
      lat: -16,
      lon: -177,
      timeMs: 1_760_000_000_000,
      place: 'Near Alo',
    },
    { source: 'USGS', retrievedAt: 1_760_000_100_000 },
  );
  assert.equal(ref.kind, 'earthquake');
  assert.equal(ref.label, 'M4.8 Near Alo');
  assert.equal(ref.provenance, 'provider');
  assert.match(ref.sourceUrl, /eventpage\/us6000abcd$/);
  assert.equal(ref.observedAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(ref.retrievedAt, new Date(1_760_000_100_000).toISOString());
  assert.deepEqual(ref.position, { lat: -16, lon: -177 });
  assert.deepEqual(ref.fields, { magnitude: 4.8, depthKm: 10 });
  assert.equal(
    eventRef('earthquakes', { id: 'QUAKE-0001', lat: 0, lon: 0 }).sourceUrl,
    null,
  );
  assert.equal(eventRef('flights', { id: 'x' }), null);
});

test('selections become references with only plain fields', () => {
  assert.equal(selectionRef(null), null);
  const ref = selectionRef(
    {
      id: 'ais-123',
      layerId: 'ais-live-vessels',
      label: 'EVER GIVEN',
      latitude: 30,
      longitude: 32,
      properties: { mmsi: '123', nested: { a: 1 }, speedKt: 12, bad: NaN },
      updatedAt: 1_760_000_000_000,
    },
    { source: 'AISStream', lastUpdate: 1 },
  );
  assert.equal(ref.kind, 'vessel');
  assert.equal(ref.source, 'AISStream');
  assert.deepEqual(ref.fields, { mmsi: '123', speedKt: 12 });
  assert.deepEqual(ref.position, { lat: 30, lon: 32 });
  assert.deepEqual(scalarFields({ a: 'x'.repeat(600) }).a.length, 500);
});

test('base paths are plain absolute paths or refused', () => {
  assert.equal(normalizeBasePath(undefined), '/');
  assert.equal(normalizeBasePath('/'), '/');
  assert.equal(normalizeBasePath('engine'), '/engine/');
  assert.equal(normalizeBasePath('/engine/'), '/engine/');
  // A protocol-relative value collapses to a local path, never another origin.
  assert.equal(normalizeBasePath('//cdn.example/'), '/cdn.example/');
  for (const bad of [
    'https://cdn.example/',
    '/../x/',
    '/a b/',
    'C:/Program Files/Git/engine/',
  ])
    assert.throws(() => normalizeBasePath(bad), /Invalid GEV_BASE_PATH/);
  assert.equal(createBrowserViteConfig({}).base, undefined);
  assert.equal(createBrowserViteConfig({ base: '/engine/' }).base, '/engine/');
  const names = (config) => config.plugins.map((plugin) => plugin.name);
  assert.equal(names(createBrowserViteConfig({})).includes('cesium-base-path'), false);
  assert.equal(
    names(createBrowserViteConfig({ base: '/engine/' })).at(-1),
    'cesium-base-path',
  );
});

test('host-mode documents are framable only as documents', () => {
  const base = '/engine/';
  assert.equal(isEmbedDocumentRequest('/engine/?host=oryn', { base }), true);
  assert.equal(isEmbedDocumentRequest('/engine/index.html?host=oryn'), true);
  assert.equal(isEmbedDocumentRequest('/?host=oryn'), true);
  assert.equal(isEmbedDocumentRequest('/engine/?host=evil', { base }), false);
  assert.equal(isEmbedDocumentRequest('/engine/', { base }), false);
  assert.equal(
    isEmbedDocumentRequest('/engine/api/cctv?host=oryn', { base }),
    false,
  );
  assert.equal(isEmbedDocumentRequest('/engine/?embed=1', { base }), true);
});

test('Cesium assets move to where a sub-path page requests them', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cesium-base-'));
  try {
    const nested = path.join(root, 'dist', 'engine', 'cesium', 'Workers');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'w.js'), '//');
    const plugin = cesiumBasePathPlugin('/engine/');
    plugin.configResolved({ root, build: { outDir: 'dist' } });
    await plugin.closeBundle.handler();
    assert.equal(
      existsSync(path.join(root, 'dist', 'cesium', 'Workers', 'w.js')),
      true,
    );
    assert.equal(existsSync(path.join(root, 'dist', 'engine')), false);
    // A root base leaves the output alone.
    const rootPlugin = cesiumBasePathPlugin('/');
    rootPlugin.configResolved({ root, build: { outDir: 'dist' } });
    await rootPlugin.closeBundle.handler();
    assert.equal(existsSync(path.join(root, 'dist', 'cesium')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
