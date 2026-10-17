# Third-party notices

ORYN's npm dependencies carry their own licences (see each package in `node_modules`). This file records source code adapted into ORYN from other projects, third-party files ORYN serves directly, and the terms of the data sources the intelligence globe shows.

## Libraries served to the browser for the intelligence globe

| Library | Licence | Notes |
| --- | --- | --- |
| CesiumJS engine (`@cesium/engine` 26.3.0) | Apache-2.0 | Bundled into the globe page; its workers, decoders, and assets are served from `public/vendor/cesium-<version>/` together with its `LICENSE.md` (which includes Cesium's third-party notices). No Cesium ion service, token, or asset is used. |
| satellite.js 7.1.0 | MIT | Server-side SGP4 propagation only. |
| hls.js 1.7.3 | Apache-2.0 | Loaded only when a user plays a live camera stream. |

## Data shown on the intelligence globe

| Source | Terms as published | How ORYN uses it |
| --- | --- | --- |
| NASA EOSDIS GIBS (Blue Marble, NOAA-20 VIIRS daily) | NASA data: no restrictions on use; credit requested | Browser loads tiles directly; credited on screen |
| USGS The National Map orthoimagery | U.S. public domain; credit “USDA, USGS The National Map” | Already used by the 2D map; credited on screen |
| CelesTrak GP orbital elements | No formal licence published; open publication with a request to download at most once per 2-hour update | Server downloads at most every 2 h; browsers get computed positions only |
| Caltrans CWWP2 CCTV | “Available for integration into your application … no charge for the use of this data”; Caltrans site information generally public domain | Server lists cameras; browsers load stills and HLS video directly from Caltrans; nothing is recorded |
| USGS earthquakes, NIFC WFIGS perimeters | U.S. public domain | As in the 2D map |


## God's Eye View

ORYN's public-event layers, feed-state model, and event inspector adapt ideas and small portions of code from God's Eye View (https://github.com/bilawalsidhu/gods-eye-view, reviewed at commit `1df2a27`):

| ORYN file | Adapted from |
| --- | --- |
| `src/lib/public-events.ts` (`feedState`) | `src/data/feedState.js` (feed-state model) |
| `src/server/public-events/normalize.ts` (`normalizeEarthquakes`) | `src/layers/earthquakes/records.js` (all-or-nothing USGS validation) |
| `src/server/public-events/service.ts` | `server/providers/firePerimeters.js` (WFIGS query fields, paging, cache and serve-stale pattern) |
| `src/components/map/event-inspector.tsx` | `src/layers/perimeters/cards.js` (entity card fields) |

Only source code was adapted. No data, imagery, 3D models, fonts, or other assets from God's Eye View are included in ORYN.

The 3D intelligence globe (`src/components/intel/`, `src/server/intel/`) follows God's Eye View's *patterns* — a Cesium viewer with its widgets off, request-render pacing, a cached server proxy for CelesTrak with stale-on-failure, layer rows with honest feed states, a camera registry with pinned upstream URLs — but its code was written for ORYN; no God's Eye View files were copied for it.

God's Eye View's repository notes that its bundled datasets and models are **not** covered by its MIT licence (for example the TeleGeography cable data and the Bhote Koshi imagery are non-commercial); none of them are used here.

```
MIT License

Copyright (c) 2026 Bilawal Sidhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
