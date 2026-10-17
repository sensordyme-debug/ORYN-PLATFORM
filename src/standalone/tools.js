import { createAssetDirectorySource } from '../director/packs/source.js';
import { createApplicationTools } from '../app/tools.js';
import { startStandaloneChrome } from './startupChrome.js';
import { loadToolCatalog } from './toolCatalog.js';
export function createStandaloneTools({
  providerSettings = true,
  ...options
} = {}) {
  return createApplicationTools({
    // A host application owns provider configuration; it turns this off.
    startChrome: providerSettings
      ? startStandaloneChrome
      : (chrome) =>
          startStandaloneChrome({ ...chrome, initializeSettings: null }),
    sceneDataPacks: {
      sources: {
        assets: createAssetDirectorySource({
          // A panel names the app's address; see src/tools/globePanel.js.
          baseUrl: new URL(
            '/scene-assets/',
            globalThis.GEV_APP_BASE_URL ?? document.baseURI,
          ).href,
        }),
      },
    },
    ...options,
    voice: { toolCatalog: loadToolCatalog, ...options?.voice },
  });
}
