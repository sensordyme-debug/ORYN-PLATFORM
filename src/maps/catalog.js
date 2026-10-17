import * as Cesium from 'cesium';
export const MAP_STACKS = [
  {
    id: 'photoreal',
    label: 'Google 3D', // i18n-ignore: imagery product name
    shortLabel: '3D',
    kind: 'photoreal',
    requiresIon: false,
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial', // i18n-ignore: imagery product name
    shortLabel: 'Aerial',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL,
    requiresIon: true,
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels', // i18n-ignore: imagery product name
    shortLabel: 'Labels',
    kind: 'ion',
    style: Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS,
    requiresIon: true,
  },
  {
    id: 'esri-imagery',
    label: 'Esri Satellite', // i18n-ignore: imagery product name
    shortLabel: 'SAT',
    kind: 'esri-imagery',
    requiresIon: false,
  },
  {
    id: 'osm',
    label: 'OSM', // i18n-ignore: imagery product name
    shortLabel: 'OSM',
    kind: 'osm',
    requiresIon: false,
  },
];

/**
 * U.S. public-domain imagery only: NASA GIBS Blue Marble worldwide, and USDA
 * NAIP orthoimagery from USGS The National Map at close range over the
 * United States. Offered only to a host that allows it (createDefaultMapSources
 * `allowedStackIds`), where commercial terms rule out the stacks above; the
 * standalone catalog, voice tools and share links are unchanged.
 */
export const PUBLIC_IMAGERY_STACK = Object.freeze({
  id: 'public-imagery',
  label: 'NASA · USGS', // i18n-ignore: imagery product names
  shortLabel: 'PUB',
  kind: 'public-imagery',
  requiresIon: false,
});
