import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cctvPackAllowed } from './cctv/catalog.js';
import {
  flightsSourceIsAdsbLolOnly,
  openSkyProxy,
} from './aircraft/opensky.js';

test('CCTV packs: no allowlist keeps every pack; an allowlist admits only its names', () => {
  assert.equal(cctvPackAllowed('austin', undefined), true);
  assert.equal(cctvPackAllowed('austin', ''), true);
  assert.equal(cctvPackAllowed('nsw', 'nsw, fintraffic'), true);
  assert.equal(cctvPackAllowed('fintraffic', 'NSW,Fintraffic'), true);
  assert.equal(cctvPackAllowed('austin', 'nsw,fintraffic'), false);
  assert.equal(cctvPackAllowed('deldot', 'nsw'), false);
});

test('flights source switch is explicit', () => {
  assert.equal(flightsSourceIsAdsbLolOnly(undefined), false);
  assert.equal(flightsSourceIsAdsbLolOnly(''), false);
  assert.equal(flightsSourceIsAdsbLolOnly('opensky'), false);
  assert.equal(flightsSourceIsAdsbLolOnly('adsb-lol'), true);
  assert.equal(flightsSourceIsAdsbLolOnly(' ADSB-LOL '), true);
});

test('an adsb.lol-only deployment never contacts OpenSky', async (t) => {
  const handlers = new Map();
  openSkyProxy().configureServer({
    middlewares: { use: (path, fn) => handlers.set(path, fn) },
  });
  const requested = [];
  const realFetch = globalThis.fetch;
  const previous = process.env.GEV_FLIGHTS_SOURCE;
  process.env.GEV_FLIGHTS_SOURCE = 'adsb-lol';
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ ac: [], now: Date.now(), total: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.GEV_FLIGHTS_SOURCE;
    else process.env.GEV_FLIGHTS_SOURCE = previous;
  });

  const headers = {};
  let status = null;
  const res = {
    setHeader: (k, v) => (headers[k.toLowerCase()] = v),
    writeHead: (code, h = {}) => {
      status = code;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    },
    end: () => {},
  };
  await handlers.get('/api/flights')(
    { url: '/?lat=35.9&lon=-77.6', method: 'GET', headers: {} },
    res,
    () => assert.fail('the flights route must answer'),
  );
  assert.equal(status, 200);
  assert.equal(headers['x-flight-source'], 'adsb.lol');
  assert.ok(requested.length > 0);
  for (const url of requested) {
    assert.match(url, /^https:\/\/api\.adsb\.lol\//);
    assert.doesNotMatch(url, /opensky/i);
  }
});
