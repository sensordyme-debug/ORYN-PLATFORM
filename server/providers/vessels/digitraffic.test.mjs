import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDigitrafficFeed,
  digitrafficFallbackEnabled,
  digitrafficPositions,
  DIGITRAFFIC_LOCATIONS_URL,
  DIGITRAFFIC_VESSELS_URL,
} from './digitraffic.js';
import { aisStreamRows } from './ais-store.js';

const LOCATIONS = {
  type: 'FeatureCollection',
  features: [
    {
      mmsi: 230000001,
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [24.95, 60.16] },
      properties: {
        mmsi: 230000001,
        sog: 12.4,
        cog: 81.2,
        heading: 80,
        timestampExternal: 1792342198146,
      },
    },
    // Heading 511, SOG 102.3 and COG 360 are AIS "not available" codes.
    {
      mmsi: 230000002,
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [22.27, 60.45] },
      properties: {
        mmsi: 230000002,
        sog: 102.3,
        cog: 360,
        heading: 511,
        timestampExternal: 1792342100000,
      },
    },
    // No position: skipped.
    {
      mmsi: 230000003,
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [] },
      properties: { timestampExternal: 1792342100000 },
    },
  ],
};
const VESSELS = [
  {
    mmsi: 230000001,
    name: ' BALTIC STAR ',
    shipType: 70,
    destination: 'FIHEL',
    imo: 9194098,
  },
];

test('the fallback is opt-in', () => {
  assert.equal(digitrafficFallbackEnabled({}), false);
  assert.equal(
    digitrafficFallbackEnabled({ AIS_FALLBACK: 'digitraffic' }),
    true,
  );
  assert.equal(digitrafficFallbackEnabled({ AIS_FALLBACK: 'other' }), false);
});

test('positions join vessel metadata and skip records without a position', () => {
  const rows = digitrafficPositions(
    LOCATIONS,
    new Map(VESSELS.map((v) => [v.mmsi, v])),
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    mmsi: '230000001',
    lat: 60.16,
    lon: 24.95,
    name: 'BALTIC STAR',
    imo: '9194098',
    type: '70',
    destination: 'FIHEL',
    speed: 12.4,
    course: 81.2,
    heading: 80,
    epochMs: 1792342198146,
  });
  assert.equal(rows[1].name, '');
});

test('a refresh fills the shared AIS cache, drops "not available" codes, and reads live', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => (url === DIGITRAFFIC_VESSELS_URL ? VESSELS : LOCATIONS),
    };
  };
  let t = 1_792_342_200_000;
  const feed = createDigitrafficFeed({ fetchImpl, now: () => t });
  assert.equal(feed.snapshot().status, 'down');
  await feed.refresh();
  assert.deepEqual(calls, [DIGITRAFFIC_VESSELS_URL, DIGITRAFFIC_LOCATIONS_URL]);
  assert.equal(feed.snapshot().status, 'live');
  const rows = aisStreamRows(100).filter((r) => r.mmsi.startsWith('23000000'));
  const star = rows.find((r) => r.mmsi === '230000001');
  assert.equal(star.name, 'BALTIC STAR');
  assert.equal(star.last_position_UTC, new Date(1792342198146).toISOString());
  const unknown = rows.find((r) => r.mmsi === '230000002');
  assert.equal(unknown.name, 'MMSI 230000002');
  assert.equal(unknown.speed, null);
  assert.equal(unknown.course, null);
  assert.equal(unknown.heading, null);
  // Within a minute nothing is fetched again; names are kept for 30 minutes.
  t += 30_000;
  await feed.refresh();
  assert.equal(calls.length, 2);
  t += 40_000;
  await feed.refresh();
  assert.deepEqual(calls.slice(2), [DIGITRAFFIC_LOCATIONS_URL]);
});

test('a failed request is reported, not hidden', async () => {
  const feed = createDigitrafficFeed({
    fetchImpl: async () => ({ ok: false, status: 503 }),
    now: () => 1,
  });
  await feed.refresh();
  const s = feed.snapshot();
  assert.equal(s.status, 'down');
  assert.match(s.error, /HTTP 503/);
});
