/**
 * What a host may show, by licence.
 *
 * ORYN is a commercial product. In ORYN host mode an engine layer is OFFERED
 * only when every source it draws on permits commercial display — checked
 * against the provider's own terms (the review, with quotes and URLs, is in
 * ORYN_LICENCE_REVIEW.md at the repository root). Everything else is
 * WITHHELD with its reason: the layer cannot be enabled by any path (panel,
 * share state, keyboard, voice) because installHostLicenceGuard blocks it in
 * the layer lifecycle itself. The standalone engine is unaffected.
 *
 * `nature` says what kind of data a layer shows, so the host never labels a
 * model, a computation, an estimate, or a bundled snapshot as an observation:
 *   observed   provider-reported observations (sensor or agency records)
 *   forecast   model forecast (not an observation)
 *   computed   derived by a stated calculation from observed inputs
 *   estimated  observed records plus estimated geometry (stated per layer)
 *   reference  bundled or mapped reference data, dated where known
 */

/** The review the entries below rest on. */
export const LICENCE_REVIEW_DATE = '2026-10-17';

const offered = (nature, sources, note = null) =>
  Object.freeze({
    status: 'offered',
    nature,
    sources: Object.freeze(sources.map((s) => Object.freeze({ ...s }))),
    note,
    reason: null,
  });
const withheld = (reason) =>
  Object.freeze({
    status: 'withheld',
    nature: null,
    sources: Object.freeze([]),
    note: null,
    reason,
  });

const USGS = {
  name: 'USGS Earthquake Hazards Program',
  licence: 'U.S. public domain',
  attribution: 'U.S. Geological Survey',
  terms:
    'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
};
const NOAA = (name) => ({
  name,
  licence: 'U.S. public domain (NOAA/NWS)',
  attribution: name,
  terms: 'https://www.weather.gov/disclaimer',
});
const OSM = {
  name: 'OpenStreetMap contributors',
  licence: 'ODbL 1.0 (map display: attribution)',
  attribution: '© OpenStreetMap contributors',
  terms: 'https://www.openstreetmap.org/copyright',
};
const ADSB_LOL = {
  name: 'adsb.lol',
  licence: 'ODbL 1.0',
  attribution: 'adsb.lol contributors (ODbL)',
  terms: 'https://github.com/adsblol/api',
};

/** Per host: layer id → policy. Layers not listed are withheld. */
export const HOST_LAYER_LICENCES = Object.freeze({
  oryn: Object.freeze({
    earthquakes: offered('observed', [USGS]),
    'local-firms': offered(
      'observed',
      [
        {
          name: 'NASA FIRMS',
          licence: 'NASA open data (no restriction on use)',
          attribution: 'NASA FIRMS',
          terms: 'https://www.earthdata.nasa.gov/data/tools/firms/faq',
        },
      ],
      'Needs a free NASA FIRMS MAP_KEY on the engine server. NASA ends Suomi NPP deliveries on 2 November 2026.',
    ),
    'weather-cyclones': offered(
      'forecast',
      [NOAA('NOAA/NWS National Hurricane Center')],
      'Positions are advisory positions; tracks and cones are official forecasts, shown unmodified.',
    ),
    'weather-radar': offered('observed', [NOAA('NOAA nowCOAST (MRMS radar)')]),
    'weather-satellite': offered('observed', [
      NOAA('NOAA nowCOAST (GOES infrared)'),
    ]),
    'weather-lightning': offered('computed', [
      NOAA('NOAA nowCOAST lightning density (derived Level 5 product)'),
    ]),
    wind: offered('forecast', [
      {
        name: 'NOAA GFS',
        licence: 'NOAA open data (NODD): use as desired',
        attribution: 'NOAA Global Forecast System (GFS)',
        terms: 'https://registry.opendata.aws/noaa-gfs-bdp-pds/',
      },
      {
        name: 'ECMWF Open Data',
        licence: 'CC BY 4.0 with the ECMWF terms of use',
        attribution:
          'This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)',
        terms: 'https://apps.ecmwf.int/datasets/licences/general/',
      },
    ]),
    'recent-imagery': offered('observed', [
      {
        name: 'NASA GIBS / CMR (HLS, VIIRS)',
        licence: 'NASA open data (no restriction on use)',
        attribution:
          "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's ESDIS",
        terms:
          'https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance',
      },
      {
        name: 'Copernicus Sentinel-2 (in HLS S30)',
        licence: 'Copernicus Sentinel data terms',
        attribution: 'Contains modified Copernicus Sentinel data',
        terms:
          'https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice',
      },
    ]),
    'air-quality': offered('observed', [
      {
        name: 'Environment and Climate Change Canada (AQHI)',
        licence: 'ECCC Data Server End-use Licence (commercial use permitted)',
        attribution:
          'Contains information licenced under the Data Server End-use Licence of Environment and Climate Change Canada.',
        terms: 'https://eccc-msc.github.io/open-data/licence/readme_en/',
      },
    ]),
    'local-dams': offered(
      'reference',
      [OSM],
      'Bundled OpenStreetMap / Open Infrastructure Map extract (first committed 2026-08-24; extraction date not recorded); not a regulatory inventory.',
    ),
    'local-datacenters': offered(
      'reference',
      [OSM],
      'Bundled OpenStreetMap extract (first committed 2026-08-24; extraction date and query not recorded).',
    ),
    'military-installations': offered(
      'reference',
      [
        OSM,
        {
          name: 'OpenFreeMap',
          licence: 'Free public instance, commercial use permitted (no SLA)',
          attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
          terms: 'https://openfreemap.org/tos/',
        },
        {
          name: 'Overture Maps Foundation (base/land_use)',
          licence: 'ODbL 1.0',
          attribution: '© OpenStreetMap contributors, Overture Maps Foundation',
          terms: 'https://docs.overturemaps.org/attribution/',
        },
      ],
      'Mapped areas and names; says nothing about current activity.',
    ),
    flights: offered(
      'observed',
      [ADSB_LOL],
      'adsb.lol regional snapshot (about 250 nm around the view); OpenSky (non-commercial) is not used. Positions are interpolated between reports. adsb.lol offers no SLA and may require a feeder key in future.',
    ),
    military: offered(
      'observed',
      [ADSB_LOL],
      'Aircraft flagged military by adsb.lol.',
    ),
    cctv: offered(
      'estimated',
      [
        {
          name: 'Fintraffic Digitraffic (Finland)',
          licence: 'CC BY 4.0',
          attribution: 'Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
          terms: 'https://www.digitraffic.fi/en/terms-of-service/',
        },
        {
          name: 'Statens vegvesen (Norway)',
          licence: 'NLOD 2.0',
          attribution:
            'Contains data under the Norwegian licence for Open Government data (NLOD) distributed by Statens vegvesen',
          terms: 'https://data.norge.no/nlod/en/2.0',
        },
        {
          name: 'DriveBC ministry cameras (British Columbia)',
          licence: 'Open Government Licence – British Columbia',
          attribution:
            'Contains information licensed under the Open Government Licence – British Columbia.',
          terms:
            'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-licence-bc',
        },
        {
          name: 'City of Calgary',
          licence: 'Open Government Licence – City of Calgary',
          attribution:
            'Contains information licensed under the Open Government Licence – City of Calgary.',
          terms:
            'https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa',
        },
      ],
      "Images are the operators'; camera headings and fields of view are estimates. Only operators whose open licence covers the images are loaded.",
    ),
    // Withheld — non-commercial, unverified, simulated, or unvalidated.
    'fire-perimeters': withheld(
      'NIFC publishes no licence or public-domain statement for the WFIGS perimeters (only a disclaimer), and state agencies contribute; withheld until NIFC confirms reuse terms.',
    ),
    satellites: withheld(
      'CelesTrak publishes no terms for reusing its orbital elements, which originate from Space-Track.',
    ),
    'rocket-launches': withheld(
      'Its orbit context comes from CelesTrak, whose reuse terms are not published.',
    ),
    'street-level': withheld(
      'KartaView and Panoramax publish no API terms for this use (images are share-alike, licensed per picture); Mapillary and Google need keys, and Google is paid.',
    ),
    'telegeography-submarine-cables': withheld(
      'TeleGeography data is licensed CC BY-NC-SA (non-commercial); not included in this build.',
    ),
    'bhote-koshi-2026': withheld(
      'Event pack licensed CC BY-NC 4.0 (non-commercial); not included in this build.',
    ),
    'bhote-koshi-locator': withheld(
      'Derived coordinates licensed CC BY-NC 4.0 (non-commercial); not included in this build.',
    ),
    traffic: withheld(
      'Vehicles are simulated on OpenStreetMap roads (live speeds need a paid TomTom key); ORYN does not present simulations as data.',
    ),
    'ais-live-vessels': withheld(
      'AISStream publishes no terms of service (free beta) and needs a key.',
    ),
    'alpr-cameras': withheld(
      'Served from a community tile host whose terms are not published.',
    ),
    bikeshare: withheld(
      'Several operator feeds publish no licence; not verified feed by feed.',
    ),
    transit: withheld(
      'Operator feeds have differing, partly revocable terms; not verified feed by feed.',
    ),
    directions: withheld(
      'The public FOSSGIS routing service restricts heavy use, and its commercial-use terms could not be verified.',
    ),
    radio: withheld(
      "Broadcast streams carry their broadcasters' terms, which are not verified.",
    ),
    'gnss-integrity': withheld(
      'An unvalidated classifier; ORYN does not present unvalidated conclusions.',
    ),
    'military-awareness': withheld(
      'Derived proximity view over layers not all offered in ORYN.',
    ),
    'local-adsb': withheld("Needs the user's own radio receiver."),
  }),
});

/** Map stacks a host may show (the first is the default). */
export const HOST_MAP_STACKS = Object.freeze({
  oryn: Object.freeze(['public-imagery']),
});

/**
 * CCTV live packs whose operators' open licences verifiably cover the camera
 * IMAGES for commercial display (review 2026-10-17). Not included: TfL
 * (terms unreadable), Catalonia (licence excludes individual images, no
 * sublicensing), Toronto (licence metadata contradicts itself), Ontario 511
 * (API key required), NSW (images not expressly covered; registration
 * required), Caltrans and the U.S. state and city packs (no explicit image
 * licence), NYC and Lithuania (agreements).
 */
export const HOST_CCTV_PACKS = Object.freeze({
  oryn: Object.freeze(['fintraffic', 'vegvesen', 'drivebc', 'calgary']),
});

const DEFAULT_WITHHELD = withheld('Licence not reviewed for commercial use.');

/** The policy for one layer in a host (null outside host mode). */
export function hostLayerLicence(host, layerId) {
  const table = HOST_LAYER_LICENCES[host];
  if (!table) return null;
  return table[layerId] ?? DEFAULT_WITHHELD;
}

export function hostLayerOffered(host, layerId) {
  const policy = hostLayerLicence(host, layerId);
  return policy === null || policy.status === 'offered';
}

/**
 * Block every attempt to enable a withheld layer, whatever its origin. The
 * guard runs inside the layer lifecycle (addVisibilityGuard), so no fetch is
 * ever made for a withheld layer.
 */
export function installHostLicenceGuard(dataManager, host) {
  if (!HOST_LAYER_LICENCES[host]) return () => {};
  return dataManager.addVisibilityGuard((change) => {
    if (!change?.enabled) return null;
    const policy = hostLayerLicence(host, change.layerId);
    return policy.status === 'offered'
      ? null
      : `Not available in this deployment: ${policy.reason}`;
  });
}
