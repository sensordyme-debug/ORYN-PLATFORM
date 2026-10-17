// Host mode: a host application (ORYN) runs this engine as its analytics
// workspace by loading the document with `?host=oryn`. The engine keeps all of
// its own layers, providers and controls; host mode only changes presentation
// (the host's design tokens and fonts, no engine branding or launcher) and
// installs a typed bridge the host's panels call (see hostBridge.js).

/** Hosts this build recognizes. Anything else runs the standalone app. */
export const HOST_NAMES = Object.freeze(['oryn']);

/**
 * Fonts the ORYN host uses (Geist and Geist Mono, the families ORYN loads
 * through next/font/google). Served from Google Fonts, which the engine's CSP
 * already allows for stylesheets and font files.
 */
export const HOST_FONT_STYLESHEETS = Object.freeze({
  oryn: 'https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400..600&display=swap',
});

/** The host named by the page URL, or null for the standalone app. */
export function resolveHost(location = globalThis.location) {
  let value = null;
  try {
    value = new URLSearchParams(location?.search || '').get('host');
  } catch {
    return null;
  }
  return HOST_NAMES.includes(value) ? value : null;
}

/**
 * Mark the document for the host's stylesheet and load the host's fonts.
 * Runs before the application starts so the first painted frame is styled.
 */
export function applyHostDocument(host, documentRef = globalThis.document) {
  if (!host || !HOST_NAMES.includes(host) || !documentRef?.documentElement)
    return false;
  documentRef.documentElement.dataset.host = host;
  const href = HOST_FONT_STYLESHEETS[host];
  if (href && !documentRef.querySelector?.(`link[data-host-fonts="${host}"]`)) {
    const link = documentRef.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.hostFonts = host;
    documentRef.head?.appendChild(link);
  }
  return true;
}
