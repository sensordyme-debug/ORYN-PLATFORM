// Typed bridge between a host application and the running engine.
//
// The host (ORYN) frames this document same-origin with `?host=oryn` and calls
// `window.__gevHost` from its own panels. Every operation goes through APIs the
// engine already uses itself: the layer lifecycle for toggles and status, the
// layer modules' row controls, the engine's place search and camera helpers,
// and the engine's selection events. Nothing here creates a viewer or a layer,
// fetches a feed, or invents data. Host-supplied overlays (ORYN areas of
// interest and findings from ORYN's own API) are drawn as separate Cesium data
// sources and are labelled with the host as their source.

import * as Cesium from 'cesium';
import { layerSnapshot } from '../../data/layerSnapshot.js';
import { getSelectedEntityContext } from '../../data/contextStore.js';
import { flyToGlobeView, flyToLandmark } from '../../locations.js';
import { hostLayerLicence } from './hostLicences.js';

export const HOST_BRIDGE_VERSION = 1;
export const HOST_READY_MESSAGE = 'gev:host-ready';
export const HOST_STATUS_MESSAGE = 'gev:host-status';

/** Engine feed state mapped onto the host's status vocabulary. */
export function hostFeedState(engineState) {
  switch (engineState) {
    case 'nominal':
      return 'current';
    case 'fallback':
      return 'fallback';
    case 'loading':
      return 'loading';
    case 'stale':
      return 'stale';
    case 'partial':
    case 'degraded':
      return 'partial';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'off';
  }
}

/** Layers whose records are dated public events a host may list. */
export const EVENT_LAYERS = Object.freeze({
  earthquakes: Object.freeze({
    kind: 'earthquake',
    label: (r) => `M${r.magnitude ?? '?'} ${r.place ?? ''}`.trim(),
    observedAt: (r) => r.timeMs,
    sourceUrl: (r) =>
      r.id && !/^QUAKE-/.test(r.id)
        ? `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(r.id)}`
        : null,
    fields: (r) => ({ magnitude: r.magnitude, depthKm: r.depthKm }),
  }),
  'local-firms': Object.freeze({
    kind: 'fire-detection',
    // i18n-ignore: record data handed to the host, which localizes its own UI.
    label: (r) => r.label || `FRP ${r.frp ?? r.frpMw ?? '?'} MW`,
    // The analyst record (firms/model.js) carries the satellite acquisition
    // time as acqTime (epoch ms) and an id derived from its position in the
    // current fetch; a host needs an id that survives a refresh.
    id: (r) => {
      const { lat, lon, acqTime: at } = r;
      if (
        ![lat, lon, at].every(
          (v) => typeof v === 'number' && Number.isFinite(v),
        ) ||
        at <= 0
      )
        return r.id;
      return `${r.satellite || r.sensor || 'fire'}:${at}:${lat.toFixed(4)},${lon.toFixed(4)}`;
    },
    observedAt: (r) =>
      typeof r.acqTime === 'number' &&
      Number.isFinite(r.acqTime) &&
      r.acqTime > 0
        ? r.acqTime
        : null,
    sourceUrl: () => 'https://firms.modaps.eosdis.nasa.gov/',
    fields: (r) => ({
      frp: r.frp ?? r.frpMw ?? null,
      confidence: r.confidence ?? r.confidencePct ?? null,
      sensor: r.sensor ?? r.instrument ?? null,
    }),
  }),
  'fire-perimeters': Object.freeze({
    kind: 'fire-perimeter',
    label: (r) => r.name || r.id,
    observedAt: (r) => r.updatedTime ?? r.discoveredTime ?? null,
    sourceUrl: () => null,
    fields: (r) => ({
      acres: r.acres ?? null,
      containedPct: r.containedPct ?? null,
      state: r.state ?? null,
    }),
  }),
  'weather-cyclones': Object.freeze({
    kind: 'cyclone',
    label: (r) => r.name || r.id,
    id: (r) => r.stormId || r.id,
    // The storm position's valid time; the advisory issue time otherwise.
    observedAt: (r) => r.positionAt ?? r.issuedAt ?? null,
    sourceUrl: () => null,
    fields: (r) => ({
      classification: r.classification ?? null,
      windKt: r.windKt ?? null,
      pressureHpa: r.pressureHpa ?? null,
      advisoryIssuedAt: r.issuedAt ?? null,
    }),
  }),
});

/** Entity kind by the layer that published a selection. */
export const ENTITY_KINDS = Object.freeze({
  flights: 'aircraft',
  military: 'aircraft',
  'local-adsb': 'aircraft',
  'ais-live-vessels': 'vessel',
  satellites: 'satellite',
  cctv: 'camera',
  'alpr-cameras': 'camera',
  'local-firms': 'fire-detection',
  'fire-perimeters': 'fire-perimeter',
  'military-installations': 'installation',
  'local-dams': 'infrastructure',
  'local-datacenters': 'infrastructure',
});

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const millis = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function finite(value) {
  // Number(null) and Number('') are 0: a missing value is not a coordinate.
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Plain scalar fields only; nested objects and empty values are dropped. */
export function scalarFields(input = {}, limit = 40) {
  const fields = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (Object.keys(fields).length >= limit) break;
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
    fields[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return fields;
}

/** A layer record from an event layer as a host reference with provenance. */
export function eventRef(layerId, record, { source, retrievedAt } = {}) {
  const spec = EVENT_LAYERS[layerId];
  if (!spec || !record) return null;
  const lat = finite(record.lat);
  const lon = finite(record.lon);
  return {
    kind: spec.kind,
    id: `${layerId}:${spec.id ? spec.id(record) : record.id}`,
    label: String(spec.label(record) || record.id),
    layerId,
    position: lat !== null && lon !== null ? { lat, lon } : null,
    source: source || null,
    sourceUrl: spec.sourceUrl(record) || null,
    observedAt: toIso(spec.observedAt(record)),
    retrievedAt: toIso(retrievedAt),
    provenance: 'provider',
    fields: scalarFields(spec.fields(record)),
  };
}

/** The engine's selected-entity record as a host reference with provenance. */
export function selectionRef(record, feed = null) {
  if (!record) return null;
  const layerId = record.layerId || null;
  const properties = record.properties || {};
  const lat = finite(record.latitude ?? record.lat);
  const lon = finite(record.longitude ?? record.lon);
  const height = finite(record.altitudeM);
  return {
    kind: ENTITY_KINDS[layerId] || record.kind || 'entity',
    id: String(record.id ?? record.label ?? 'selection'),
    label: String(record.label || record.id || ''),
    layerId,
    position:
      lat !== null && lon !== null
        ? { lat, lon, ...(height !== null ? { height } : {}) }
        : null,
    source: record.source || record.dataSource || feed?.source || null,
    sourceUrl: null,
    observedAt: toIso(
      properties.observedAt ??
        properties.lastPositionEpoch ??
        properties.lastContactAtMs ??
        properties.timeMs ??
        null,
    ),
    retrievedAt: toIso(record.updatedAt ?? feed?.lastUpdate ?? null),
    provenance: 'provider',
    fields: scalarFields(properties),
  };
}

/** A layer row's controls, reduced to serializable descriptors. */
export function describeRowControls(controls) {
  if (!controls || typeof controls !== 'object') return null;
  const chips = (Array.isArray(controls.chips) ? controls.chips : [])
    .filter((chip) => chip && chip.id)
    .map((chip) => ({
      id: String(chip.id),
      label: String(chip.label ?? chip.id),
      active: Boolean(chip.active),
      state: chip.state || (chip.active ? 'active' : 'idle'),
      title: chip.title ? String(chip.title) : null,
      disabled: Boolean(chip.disabled),
    }));
  const legend = (Array.isArray(controls.legend) ? controls.legend : []).map(
    (item) => ({
      label: String(item?.label ?? ''),
      color: item?.color ? String(item.color) : null,
      count: finite(item?.count),
    }),
  );
  const items = Array.isArray(controls.list?.items)
    ? controls.list.items
        .filter((item) => item && item.id)
        .map((item) => ({
          id: String(item.id),
          label: String(item.label ?? item.text ?? item.id),
          detail: item.detail ? String(item.detail) : null,
          active: Boolean(item.active),
        }))
    : [];
  const info = controls.info ? String(controls.info) : null;
  if (!chips.length && !legend.length && !items.length && !info) return null;
  return { chips, legend, items, info };
}

/** One layer row for the host: identity, status and controls. */
export function describeLayer(
  row,
  { now = Date.now(), controls = null, licence = null } = {},
) {
  const snapshot = layerSnapshot(row, { now });
  return {
    id: snapshot.id,
    name: snapshot.name,
    icon: row?.icon || null,
    source: snapshot.source,
    enabled: snapshot.enabled,
    lifecycleState: row?.lifecycleState || null,
    state: hostFeedState(snapshot.feedState),
    count: snapshot.count,
    lastUpdate: snapshot.lastUpdate,
    ageLabel: snapshot.ageLabel,
    error: snapshot.error ? String(snapshot.error) : null,
    requiresKeyId: row?.requiresKeyId || null,
    showInTogglePanel: row?.showInTogglePanel !== false,
    controls: describeRowControls(controls),
    licence: licence
      ? {
          offered: licence.status === 'offered',
          nature: licence.nature,
          reason: licence.reason,
          note: licence.note,
          sources: licence.sources.map((source) => ({ ...source })),
        }
      : null,
  };
}

const OVERLAY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Install `window.__gevHost` once the application is ready.
 * @param {{application:{subscribe:Function,getComponents:Function,getState:Function}}, host:string, windowRef?:Window}} options
 */
export function installHostBridge({ application, host, windowRef = window }) {
  const listeners = new Set();
  const overlays = new Map();
  let status = { state: 'starting', error: null };
  let components = null;
  let selection = null;
  let clickHandler = null;
  let activityFrame = null;
  let unsubscribeActivity = null;

  const emit = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[host] listener failed', error);
      }
    }
  };
  const postToHost = (type, detail) => {
    try {
      if (windowRef.parent && windowRef.parent !== windowRef)
        windowRef.parent.postMessage(
          { type, ...detail },
          windowRef.location.origin,
        );
    } catch {
      // A host on another origin receives nothing; it must use same-origin.
    }
  };
  const setStatus = (next) => {
    status = Object.freeze({ ...next });
    emit({ type: 'status', status });
    postToHost(HOST_STATUS_MESSAGE, { status });
  };

  const engineParts = () => {
    if (!components) throw new Error('The engine is still starting');
    return components;
  };
  const feedsById = () => {
    const { dataManager } = engineParts();
    const now = Date.now();
    return new Map(
      dataManager
        .getAll()
        .map((row) => [
          row.id,
          describeLayer(row, { now, licence: hostLayerLicence(host, row.id) }),
        ]),
    );
  };
  const rowControls = (id) => {
    const module = components?.dataManager.layers.get(id)?.module;
    try {
      return module?.getRowControls?.() || null;
    } catch (error) {
      console.warn(`[host] ${id} row controls`, error);
      return null;
    }
  };
  const publishSelection = (ref) => {
    selection = ref;
    emit({ type: 'selection', ref });
  };

  const onSelected = () => {
    const record = getSelectedEntityContext({
      dataManager: components?.dataManager,
    });
    publishSelection(
      selectionRef(record, feedsById().get(record?.layerId) || null),
    );
  };
  const onAwareness = (event) => {
    const detail = event?.detail || {};
    const record = getSelectedEntityContext({
      dataManager: components?.dataManager,
    }) || {
      id: detail.id,
      label: detail.label,
      layerId: detail.layerId,
      latitude: detail.position?.lat ?? detail.position?.latitude,
      longitude: detail.position?.lon ?? detail.position?.longitude,
    };
    publishSelection(
      selectionRef(record, feedsById().get(record?.layerId) || null),
    );
  };
  const onCleared = () => publishSelection(null);

  function attach(ready) {
    components = ready;
    const { viewer, dataManager, styleManager } = ready;
    windowRef.addEventListener('gev:entity-selected', onSelected);
    windowRef.addEventListener('gev:awareness-subject-selected', onAwareness);
    windowRef.addEventListener('gev:entity-selection-cleared', onCleared);
    windowRef.addEventListener('gev:awareness-subject-cleared', onCleared);
    unsubscribeActivity = dataManager.subscribeActivity(() => {
      if (activityFrame) return;
      activityFrame = windowRef.requestAnimationFrame(() => {
        activityFrame = null;
        emit({ type: 'layers' });
      });
    });
    // Host overlays answer their own clicks; engine layers keep theirs.
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((movement) => {
      const picked = viewer.scene.pick(movement.position);
      const entity = picked?.id;
      if (!(entity instanceof Cesium.Entity)) return;
      for (const [overlayId, overlay] of overlays) {
        if (entity.entityCollection?.owner !== overlay.dataSource) continue;
        const properties = entity.properties?.getValue?.(
          viewer.clock.currentTime,
        );
        const center = overlay.centers.get(entity.id) || null;
        publishSelection({
          kind: overlay.kind,
          id: String(properties?.id ?? entity.id),
          label: String(properties?.name ?? properties?.label ?? entity.id),
          layerId: `host:${overlayId}`,
          position: center,
          source: overlay.source,
          sourceUrl: null,
          observedAt: toIso(properties?.observedAt ?? null),
          retrievedAt: overlay.loadedAt,
          provenance: 'host',
          fields: scalarFields(properties),
        });
        return;
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // The host is an operations console: the engine's cinematic intel HUD
    // and scope vignette start off unless a share link restored them. Both
    // stay available in the engine's DISPLAY panel.
    if (!styleManager.hasShareState)
      Promise.resolve(styleManager.initialRestorePromise)
        .then(() =>
          styleManager.applyVisualState({
            hud: { visible: false },
            scope: { enabled: false },
          }),
        )
        .catch((error) => console.warn('[host] visual defaults', error));
    setStatus({ state: 'ready', error: null });
    postToHost(HOST_READY_MESSAGE, { version: HOST_BRIDGE_VERSION, host });
  }

  function overlayCenter(entity, time) {
    const hierarchy = entity.polygon?.hierarchy?.getValue?.(time);
    const positions = hierarchy?.positions || [];
    const point = entity.position?.getValue?.(time);
    const sphere = positions.length
      ? Cesium.BoundingSphere.fromPoints(positions)
      : null;
    const cartesian = sphere?.center || point;
    if (!cartesian) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  const api = Object.freeze({
    version: HOST_BRIDGE_VERSION,
    host,
    status: () => status,
    listLayers() {
      if (!components) return [];
      const now = Date.now();
      return components.dataManager.getAll().map((row) =>
        describeLayer(row, {
          now,
          controls: rowControls(row.id),
          licence: hostLayerLicence(host, row.id),
        }),
      );
    },
    async setLayerEnabled(id, enabled) {
      const { dataManager } = engineParts();
      if (!dataManager.layers.has(id)) throw new Error(`Unknown layer: ${id}`);
      // The lifecycle guard (hostLicences.js) refuses too; this says why.
      const policy = hostLayerLicence(host, id);
      if (enabled && policy && policy.status !== 'offered')
        throw new Error(`Not available in this deployment: ${policy.reason}`);
      return dataManager.setEnabled(id, Boolean(enabled), { origin: 'user' });
    },
    async clearLayers() {
      const { dataManager } = engineParts();
      return dataManager.clearSelectedLayers({ origin: 'user' });
    },
    /** Apply a row chip exactly as the engine's own layer panel does. */
    applyRowControl(layerId, chipId) {
      const { dataManager } = engineParts();
      if (!dataManager.isEnabled(layerId)) return false;
      const chip = rowControls(layerId)?.chips?.find(
        (entry) => entry.id === chipId,
      );
      if (!chip || chip.disabled) return false;
      if (typeof chip.onClick === 'function') chip.onClick();
      else if (chip.params)
        dataManager.setLayerParams(layerId, chip.params, { origin: 'user' });
      else return false;
      return true;
    },
    applyListItem(layerId, itemId) {
      const { dataManager } = engineParts();
      const item = rowControls(layerId)?.list?.items?.find(
        (entry) => entry.id === itemId,
      );
      if (!item?.params) return false;
      dataManager.setLayerParams(layerId, item.params, { origin: 'user' });
      return true;
    },
    flyTo({ lat, lon, range = 2500, pitch = -35, duration = 2.2 } = {}) {
      const { viewer } = engineParts();
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
      flyToLandmark(viewer, lat, lon, { range, pitch, duration });
      return true;
    },
    resetView() {
      flyToGlobeView(engineParts().viewer);
      return true;
    },
    /**
     * Place the camera without a flight: the host's starting view (ORYN's
     * intel page takes `?at=lon,lat,heightM`). Pitch and heading in degrees.
     */
    setView({ lat, lon, height, heading = 0, pitch = -90, duration = 0 } = {}) {
      const { viewer } = engineParts();
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        !Number.isFinite(height) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180 ||
        height <= 0
      )
        return false;
      const destination = Cesium.Cartesian3.fromDegrees(lon, lat, height);
      const orientation = {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0,
      };
      viewer.camera.cancelFlight();
      if (duration > 0)
        viewer.camera.flyTo({ destination, orientation, duration });
      else viewer.camera.setView({ destination, orientation });
      viewer.scene.requestRender();
      return true;
    },
    getCamera() {
      return engineParts().styleManager.getCameraState();
    },
    /** The engine's own place search: coordinates, bundled places, geocoders. */
    async search(query) {
      const { viewer, styleManager, operations } = engineParts();
      const text = String(query || '').trim();
      if (!text) return { found: false };
      const result = await operations.searchAndFlyTo(viewer, text, {
        placeSearch: styleManager.placeSearch,
      });
      if (!result) return { found: false };
      return {
        found: true,
        label: result.name || result.label || text,
        lat: finite(result.lat),
        lon: finite(result.lng ?? result.lon),
      };
    },
    /** Loaded engine records whose label matches, across enabled layers. */
    searchEntities(query, { limit = 12 } = {}) {
      if (!components) return [];
      const needle = String(query || '')
        .trim()
        .toLowerCase();
      if (needle.length < 2) return [];
      const feeds = feedsById();
      const matches = [];
      for (const [layerId, entry] of components.dataManager.layers) {
        const module = entry?.module;
        if (!entry?.enabled || typeof module?.getAnalystRecords !== 'function')
          continue;
        let records = [];
        try {
          records = module.getAnalystRecords(2000) || [];
        } catch {
          continue;
        }
        for (const record of records) {
          const label =
            record.label ||
            record.name ||
            record.callsign ||
            record.place ||
            String(record.id ?? '');
          const haystack = [
            label,
            record.registration,
            record.id,
            record.mmsi,
            record.icao24,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(needle)) continue;
          // A dated public event carries the same label, observation time,
          // source link and measurements the event list shows.
          const event = EVENT_LAYERS[layerId]
            ? eventRef(layerId, record, {
                source: feeds.get(layerId)?.source,
                retrievedAt: feeds.get(layerId)?.lastUpdate,
              })
            : null;
          if (event) {
            matches.push(event);
            if (matches.length >= limit) return matches;
            continue;
          }
          const lat = finite(record.lat ?? record.latitude);
          const lon = finite(record.lon ?? record.longitude);
          matches.push({
            kind:
              ENTITY_KINDS[layerId] || EVENT_LAYERS[layerId]?.kind || 'entity',
            id: `${layerId}:${record.id ?? matches.length}`,
            label: String(label),
            layerId,
            position: lat !== null && lon !== null ? { lat, lon } : null,
            source: feeds.get(layerId)?.source || null,
            sourceUrl: null,
            observedAt: null,
            retrievedAt: toIso(feeds.get(layerId)?.lastUpdate),
            provenance: 'provider',
            fields: {},
          });
          if (matches.length >= limit) return matches;
        }
      }
      return matches;
    },
    /** Dated records from enabled public-event layers, newest first. */
    collectEvents({ limit = 300 } = {}) {
      if (!components) return [];
      const feeds = feedsById();
      const result = [];
      for (const layerId of Object.keys(EVENT_LAYERS)) {
        const entry = components.dataManager.layers.get(layerId);
        if (!entry?.enabled) continue;
        let records = [];
        try {
          records = entry.module?.getAnalystRecords?.(limit) || [];
        } catch {
          records = [];
        }
        const feed = feeds.get(layerId);
        for (const record of records) {
          const ref = eventRef(layerId, record, {
            source: feed?.source,
            retrievedAt: feed?.lastUpdate,
          });
          if (ref) result.push(ref);
        }
      }
      return result.sort(
        (a, b) =>
          (b.observedAt ? Date.parse(b.observedAt) : 0) -
          (a.observedAt ? Date.parse(a.observedAt) : 0),
      );
    },
    getSelection: () => selection,
    /**
     * Draw host data (a GeoJSON FeatureCollection from the host's own API)
     * as a separate data source. Replaces any overlay with the same id.
     */
    async setOverlay(
      id,
      featureCollection,
      {
        kind = 'feature',
        source = host,
        stroke = '#f2f1ed',
        fill = 'rgba(242,241,237,0.08)',
        strokeWidth = 2,
        show = true,
      } = {},
    ) {
      const { viewer } = engineParts();
      if (!OVERLAY_ID.test(String(id)))
        throw new Error(`Invalid overlay id: ${id}`);
      if (
        featureCollection?.type !== 'FeatureCollection' ||
        !Array.isArray(featureCollection.features)
      )
        throw new Error('A GeoJSON FeatureCollection is required');
      const dataSource = await Cesium.GeoJsonDataSource.load(
        featureCollection,
        {
          stroke: Cesium.Color.fromCssColorString(stroke),
          fill: Cesium.Color.fromCssColorString(fill),
          strokeWidth,
          clampToGround: true,
        },
      );
      dataSource.name = `host:${id}`;
      const previous = overlays.get(id);
      if (previous) viewer.dataSources.remove(previous.dataSource, true);
      await viewer.dataSources.add(dataSource);
      dataSource.show = Boolean(show);
      const time = viewer.clock.currentTime;
      const centers = new Map();
      for (const entity of dataSource.entities.values) {
        const center = overlayCenter(entity, time);
        if (center) centers.set(entity.id, center);
      }
      overlays.set(id, {
        dataSource,
        kind,
        source,
        centers,
        loadedAt: new Date().toISOString(),
      });
      viewer.scene.requestRender();
      emit({ type: 'overlays' });
      return { count: dataSource.entities.values.length };
    },
    setOverlayVisible(id, visible) {
      const overlay = overlays.get(id);
      if (!overlay) return false;
      overlay.dataSource.show = Boolean(visible);
      components?.viewer.scene.requestRender();
      emit({ type: 'overlays' });
      return true;
    },
    listOverlays() {
      return [...overlays].map(([id, overlay]) => ({
        id,
        kind: overlay.kind,
        source: overlay.source,
        count: overlay.dataSource.entities.values.length,
        visible: overlay.dataSource.show,
        loadedAt: overlay.loadedAt,
      }));
    },
    flyToOverlay(id) {
      const overlay = overlays.get(id);
      if (!overlay || !components) return false;
      components.viewer.flyTo(overlay.dataSource, { duration: 2 });
      return true;
    },
    /** The host renders its own layer panel; hide the engine's data panel. */
    setExternalLayerPanel(external) {
      const root = windowRef.document.documentElement;
      if (external) root.dataset.hostLayers = 'external';
      else delete root.dataset.hostLayers;
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  windowRef.__gevHost = api;
  application.subscribe((state) => {
    if (state.status === 'ready' && !components) {
      try {
        const { scene, controls, data } = application.getComponents();
        attach({
          viewer: scene.viewer,
          operations: scene.operations,
          dataManager: data.dataManager,
          styleManager: controls.styleManager,
        });
      } catch (error) {
        setStatus({
          state: 'failed',
          error: error?.message || String(error),
        });
      }
    } else if (state.status === 'failed') {
      setStatus({ state: 'failed', error: 'The engine failed to start' });
    }
  });

  return () => {
    clickHandler?.destroy();
    unsubscribeActivity?.();
    windowRef.removeEventListener('gev:entity-selected', onSelected);
    windowRef.removeEventListener(
      'gev:awareness-subject-selected',
      onAwareness,
    );
    windowRef.removeEventListener('gev:entity-selection-cleared', onCleared);
    windowRef.removeEventListener('gev:awareness-subject-cleared', onCleared);
    listeners.clear();
    if (windowRef.__gevHost === api) delete windowRef.__gevHost;
  };
}
