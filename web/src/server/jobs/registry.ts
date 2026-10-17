/**
 * The single registry of job handlers run by the worker and the cron
 * endpoint. A job whose type is not registered fails visibly (never silently
 * dropped).
 */
import { ALERT_HANDLERS } from "@/server/alerts/handlers";
import { EXPORT_HANDLERS } from "@/server/exports/handlers";
import { JOB } from "@/server/jobs/types";
import type { HandlerRegistry, JobHandler } from "@/server/jobs/worker";
import { changeDetectionHandler } from "@/server/pipeline/change";
import { contextSyncHandler } from "@/server/pipeline/context";
import { providerHealthHandler } from "@/server/pipeline/health";
import { processAssetHandler } from "@/server/pipeline/process";
import { referenceImportHandler } from "@/server/pipeline/reference";
import { aoiCatalogSyncHandler, providerCatalogSyncHandler } from "@/server/pipeline/sync";
import { REPORT_HANDLERS } from "@/server/reports/handlers";
import { retentionPurgeHandler } from "@/server/retention";

const PIPELINE: JobHandler[] = [
  { type: JOB.aoiCatalogSync, describe: "Search imagery catalogs for an area", run: aoiCatalogSyncHandler },
  { type: JOB.providerCatalogSync, describe: "Poll a provider catalog for a cluster of areas", run: providerCatalogSyncHandler },
  { type: JOB.aoiProcessAsset, describe: "Analyze one image for one area", run: processAssetHandler },
  { type: JOB.aoiChangeDetection, describe: "Compare an observation with its baseline", run: changeDetectionHandler },
  { type: JOB.aoiContextSync, describe: "Refresh weather, warnings, and news for an area", run: contextSyncHandler },
  { type: JOB.referenceImport, describe: "Import a reference layer", run: referenceImportHandler },
  { type: JOB.providerHealth, describe: "Probe provider endpoints", run: providerHealthHandler },
];

export function buildRegistry(): HandlerRegistry {
  const all = [...PIPELINE, ...ALERT_HANDLERS, ...REPORT_HANDLERS, ...EXPORT_HANDLERS, retentionPurgeHandler];
  const map = new Map<string, JobHandler>();
  for (const h of all) {
    if (map.has(h.type)) throw new Error(`Duplicate job handler for ${h.type}`);
    map.set(h.type, h);
  }
  for (const type of Object.values(JOB)) {
    if (!map.has(type)) throw new Error(`No handler registered for job type ${type}`);
  }
  return map;
}
