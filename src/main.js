import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';
import { applyHostDocument, resolveHost } from './ui/host/hostMode.js';
import { installHostBridge } from './ui/host/hostBridge.js';

// A host application (ORYN) runs this engine as its analytics workspace with
// `?host=oryn`; see src/ui/host/. Without it the standalone app is unchanged.
const host = resolveHost();
applyHostDocument(host);

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
  // The host sets its own starting view through the bridge.
  startupFlight: !host,
});

if (host) installHostBridge({ application, host });

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = t('Error: {message}', {
    message: describeError(error),
  });
  loaderStatus.style.color = '#ff4444';
});

export { application };
