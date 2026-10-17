import { MAP_STACKS, PUBLIC_IMAGERY_STACK } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirementEnvVars } from '../keySetupCore.mjs';
import { t } from '../i18n/index.js';
import {
  createOsmImagery,
  createEsriImagery,
  createIonImagery,
  createPublicImagery,
  ESRI_ATTRIBUTION_HTML,
} from './imagery.js';
import {
  createEllipsoidTerrain,
  createWorldTerrain,
  createKeylessTerrain,
} from './terrain.js';

/** Select sources and setup guidance without putting provider branches in the controller. */
/**
 * `allowedStackIds` restricts a deployment to the listed stacks (the first is
 * the default): a commercial host may only show imagery whose terms it has
 * verified. Every other stack stays listed but unavailable, with the reason.
 */
export function createDefaultMapSources({
  googleTileset = null,
  cesiumToken = '',
  googleApiKey = '',
  allowedStackIds = null,
  // 'ellipsoid': no terrain service (a deployment that has not verified the
  // keyless terrain service's terms shows the smooth globe instead).
  terrain: terrainMode = 'auto',
} = {}) {
  const allowed =
    Array.isArray(allowedStackIds) && allowedStackIds.length
      ? new Set(allowedStackIds)
      : null;
  const ionToken = String(cesiumToken || '').trim();
  const hasIon = Boolean(ionToken);
  const hasGoogle = Boolean(String(googleApiKey || '').trim());
  const terrain =
    terrainMode === 'ellipsoid'
      ? { id: 'ellipsoid', create: createEllipsoidTerrain }
      : {
          id: hasIon ? 'world' : 'keyless',
          create: hasIon
            ? (request) => createWorldTerrain(ionToken, request)
            : createKeylessTerrain,
        };
  return {
    defaultId: allowed
      ? allowedStackIds[0]
      : googleTileset
        ? 'photoreal'
        : 'esri-imagery',
    unknownId: 'photoreal',
    recoveryId: googleTileset ? 'photoreal' : null,
    state: { hasCesiumIonToken: hasIon },
    sources: [
      ...MAP_STACKS,
      ...(allowed?.has(PUBLIC_IMAGERY_STACK.id) ? [PUBLIC_IMAGERY_STACK] : []),
    ].map((descriptor) => {
      if (allowed && !allowed.has(descriptor.id))
        return {
          descriptor,
          available: false,
          unavailableReason: t('Not offered in this deployment'),
          imagery: () => {
            throw new Error('Map stack not offered in this deployment');
          },
          terrain,
        };
      const common = {
        descriptor,
        available: !descriptor.requiresIon || hasIon,
        unavailableReason: descriptor.requiresIon
          ? t('Needs {envVars} — add it in Provider Settings', {
              envVars: keySetupRequirementEnvVars('cesium-ion'),
            })
          : null,
      };
      if (descriptor.kind === 'photoreal')
        return {
          ...common,
          available: Boolean(googleTileset),
          unavailableReason: photorealUnavailableReason(hasIon || hasGoogle),
          tileset: googleTileset,
        };
      const imagery =
        descriptor.kind === 'ion'
          ? () => createIonImagery(descriptor.style, ionToken)
          : descriptor.id === 'osm'
            ? createOsmImagery
            : descriptor.kind === 'public-imagery'
              ? createPublicImagery
              : createEsriImagery;
      return {
        ...common,
        imagery,
        terrain,
        ...(descriptor.id === 'esri-imagery'
          ? {
              credit: ESRI_ATTRIBUTION_HTML,
              constructionFallback: {
                id: 'osm',
                message: 'Esri Satellite is unavailable; using OSM',
              },
              tileFailureFallback: {
                id: 'osm',
                threshold: 2,
                message: 'Esri Satellite tile requests failed; using OSM',
              },
            }
          : {}),
      };
    }),
  };
}
