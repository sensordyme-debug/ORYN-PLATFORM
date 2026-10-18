import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';
import { applyHostDocument, resolveHost } from './ui/host/hostMode.js';
import { installHostBridge } from './ui/host/hostBridge.js';
import {
  HOST_MAP_STACKS,
  installHostLicenceGuard,
} from './ui/host/hostLicences.js';

// A host application (ORYN) runs this engine as its analytics workspace with
// `?host=oryn`; see src/ui/host/. Without it the standalone app is unchanged.
const host = resolveHost();
applyHostDocument(host);
// A development build for the host offers every layer, map and search
// service, marked as not cleared for commercial use (hostLicences.js).
const allLayers = Boolean(host) && import.meta.env.GEV_HOST_ALL_LAYERS === true;

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
  // The host sets its own starting view through the bridge.
  startupFlight: !host,
  // Provider keys are configured on the engine server, not from the host page.
  providerSettings: !host,
  // Without a Mapillary token, a development host build starts Street Level
  // on KartaView (keyless) instead of a provider that cannot load.
  streetLevelKeylessFirst: allLayers && !import.meta.env.MAPILLARY_CLIENT_TOKEN,
  // A host shows only layers and imagery whose licences it has verified
  // (src/ui/host/hostLicences.js), and never probes for Google 3D tokens.
  ...(host && !allLayers
    ? {
        mapOptions: {
          allowedStackIds: HOST_MAP_STACKS[host],
          terrain: 'ellipsoid',
        },
        googleTokenProbe: false,
        // Place search stays offline: coordinates and bundled names only.
        geospatial: { onlineGeocoding: false },
        onData: (dataManager) => installHostLicenceGuard(dataManager, host),
      }
    : {}),
});

if (host) installHostBridge({ application, host, allLayers });

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = t('Error: {message}', {
    message: describeError(error),
  });
  loaderStatus.style.color = '#ff4444';
});

export { application };
