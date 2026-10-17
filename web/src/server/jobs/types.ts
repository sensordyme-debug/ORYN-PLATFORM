/**
 * Canonical job type names. Handlers are registered in
 * src/server/jobs/registry.ts; producers enqueue by these names.
 */
export const JOB = {
  /** Search imagery catalogs for new assets over an AOI (backfill or scheduled poll). */
  aoiCatalogSync: "aoi.catalog_sync",
  /** Search catalogs once for a cluster of AOIs and fan out to intersecting AOIs. */
  providerCatalogSync: "provider.catalog_sync",
  /** Run the enabled analytics for one (AOI, source asset). */
  aoiProcessAsset: "aoi.process_asset",
  /** Compare an observation with its baseline and record candidate changes. */
  aoiChangeDetection: "aoi.change_detection",
  /** Refresh weather records, official warnings, and news matches for an AOI. */
  aoiContextSync: "aoi.context_sync",
  /** Import a reference layer (OSM, TIGER, upload) for an AOI. */
  referenceImport: "reference.import",
  /** Evaluate alert rules for an AOI after new results. */
  alertsEvaluate: "alerts.evaluate",
  /** Deliver notifications for an alert. */
  alertsDeliver: "alerts.deliver",
  /** Escalate unacknowledged alerts past their rule's escalation window. */
  alertsEscalate: "alerts.escalate",
  reportGenerate: "report.generate",
  exportGenerate: "export.generate",
  /** Apply the organization's retention policy. */
  retentionPurge: "retention.purge",
  /** Probe provider endpoints and record health. */
  providerHealth: "provider.health_check",
} as const;

export type JobType = (typeof JOB)[keyof typeof JOB];
