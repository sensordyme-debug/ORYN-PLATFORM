import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  if (
    style === Cesium.IonWorldImageryStyle.AERIAL ||
    style === Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS
  ) {
    return createBingIonImagery(style, accessToken);
  }
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}

async function createBingIonImagery(style, accessToken) {
  const endpoint = await new Cesium.Resource({
    url: `https://api.cesium.com/v1/assets/${style}/endpoint`,
    queryParameters: { access_token: accessToken },
  }).fetchJson();
  if (
    endpoint?.type !== 'IMAGERY' ||
    endpoint.externalType !== 'BING' ||
    typeof endpoint.options?.url !== 'string'
  ) {
    throw new Error('Ion world imagery did not return a Bing imagery endpoint');
  }
  // Bing otherwise follows the page's HTTP scheme on localhost. Resolve its
  // ion-issued credentials through public APIs so tiles use HTTPS without
  // weakening CSP, changing SDK defaults or touching provider internals.
  const { url, ...options } = endpoint.options;
  const provider = await Cesium.BingMapsImageryProvider.fromUrl(url, {
    ...options,
    tileProtocol: 'https',
  });
  const ionCredits = (endpoint.attributions ?? []).map(
    ({ html, collapsible }) => new Cesium.Credit(html, collapsible === false),
  );
  const getTileCredits = provider.getTileCredits.bind(provider);
  provider.getTileCredits = (x, y, level) => [
    ...ionCredits,
    ...(getTileCredits(x, y, level) ?? []),
  ];
  return provider;
}

// ── Public-domain imagery (NASA GIBS + USGS The National Map) ─────────────

export const PUBLIC_IMAGERY_CREDIT =
  'Imagery: NASA GIBS Blue Marble (NASA Earth Observatory); USDA NAIP via USGS The National Map';

const GIBS_BLUE_MARBLE_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
const GIBS_MAX_LEVEL = 8;
const USGS_IMAGERY_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
/** USGS orthoimagery is used from this level down; GIBS above it. */
export const PUBLIC_IMAGERY_DETAIL_LEVEL = 8;
const PUBLIC_IMAGERY_MAX_LEVEL = 17;

/**
 * Where USGS The National Map publishes orthoimagery (degrees: west, south,
 * east, north): the conterminous United States, Alaska, Hawaii, and Puerto
 * Rico with the U.S. Virgin Islands. Elsewhere it answers 404.
 */
export const USGS_IMAGERY_COVERAGE = Object.freeze([
  [-125.0, 24.3, -66.8, 49.5],
  [-179.2, 51.1, -129.9, 71.5],
  [-160.4, 18.8, -154.7, 22.3],
  [-67.4, 17.5, -64.4, 18.6],
]);

/** True when a tile's rectangle (radians) touches USGS imagery coverage. */
export function tileTouchesUsgsCoverage(rectangle) {
  const toDeg = Cesium.Math.toDegrees;
  const [w, s, e, n] = [
    toDeg(rectangle.west),
    toDeg(rectangle.south),
    toDeg(rectangle.east),
    toDeg(rectangle.north),
  ];
  return USGS_IMAGERY_COVERAGE.some(
    ([cw, cs, ce, cn]) => w < ce && e > cw && s < cn && n > cs,
  );
}

/**
 * The GIBS ancestor tile and the part of it that covers tile (x, y, level),
 * for levels beyond GIBS's last one.
 */
export function gibsAncestor(x, y, level, tileSize = 256) {
  const ancestorLevel = Math.min(level, GIBS_MAX_LEVEL);
  const factor = 2 ** (level - ancestorLevel);
  const size = tileSize / factor;
  return {
    x: Math.floor(x / factor),
    y: Math.floor(y / factor),
    level: ancestorLevel,
    sx: (x % factor) * size,
    sy: (y % factor) * size,
    size,
  };
}

/**
 * One imagery provider over two U.S. public-domain services: NASA GIBS Blue
 * Marble everywhere (to level 8, enlarged beyond it) and USDA NAIP
 * orthoimagery from USGS The National Map at close range inside its U.S.
 * coverage, falling back to GIBS where USGS has no tile.
 */
export function createPublicImagery() {
  const tilingScheme = new Cesium.WebMercatorTilingScheme();
  const credit = new Cesium.Credit(PUBLIC_IMAGERY_CREDIT);
  const gibs = new Cesium.UrlTemplateImageryProvider({
    url: GIBS_BLUE_MARBLE_URL,
    tilingScheme,
    maximumLevel: GIBS_MAX_LEVEL,
    credit,
  });
  const usgs = new Cesium.UrlTemplateImageryProvider({
    url: USGS_IMAGERY_URL,
    tilingScheme,
    maximumLevel: PUBLIC_IMAGERY_MAX_LEVEL,
    credit,
  });
  const ancestors = new Map();
  const enlargedGibs = async (x, y, level) => {
    const a = gibsAncestor(x, y, level);
    const key = `${a.level}/${a.x}/${a.y}`;
    if (!ancestors.has(key)) {
      ancestors.set(
        key,
        Promise.resolve(gibs.requestImage(a.x, a.y, a.level)).catch((error) => {
          ancestors.delete(key);
          throw error;
        }),
      );
      if (ancestors.size > 64) ancestors.delete(ancestors.keys().next().value);
    }
    const image = await ancestors.get(key);
    if (a.level === level) return image;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.drawImage(image, a.sx, a.sy, a.size, a.size, 0, 0, 256, 256);
    return canvas;
  };
  const errorEvent = new Cesium.Event();
  return {
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    tileWidth: 256,
    tileHeight: 256,
    minimumLevel: 0,
    maximumLevel: PUBLIC_IMAGERY_MAX_LEVEL,
    tileDiscardPolicy: undefined,
    errorEvent,
    credit,
    proxy: undefined,
    hasAlphaChannel: false,
    getTileCredits: () => [],
    pickFeatures: () => undefined,
    requestImage(x, y, level, request) {
      if (level <= GIBS_MAX_LEVEL && level < PUBLIC_IMAGERY_DETAIL_LEVEL)
        return gibs.requestImage(x, y, level, request);
      const rectangle = tilingScheme.tileXYToRectangle(x, y, level);
      if (!tileTouchesUsgsCoverage(rectangle)) return enlargedGibs(x, y, level);
      const pending = usgs.requestImage(x, y, level, request);
      // Throttled: Cesium asks again later.
      if (!pending) return pending;
      return Promise.resolve(pending).catch(() => enlargedGibs(x, y, level));
    },
  };
}
