"use client";

import { useActionState } from "react";
import { updateAoiSettingsAction } from "@/app/(platform)/app/[org]/areas/actions";
import { Button, Field, inputClass, Notice } from "@/components/platform/ui";
import { ANALYTIC_OPTIONS, AOI_KIND_LABEL, AOI_KINDS, DATA_SOURCES } from "@/lib/aoi-config";

export type SourceAvailability = Record<string, { state: string; reason?: string }>;

export function AoiSettingsForm({
  slug,
  aoi,
  availability,
}: {
  slug: string;
  aoi: { id: string; name: string; description: string; kind: string; monitoringEnabled: boolean; monitoringIntervalHours: number; maxCloudCover: number; dataSources: string[]; enabledAnalytics: string[]; newsTerms: string[]; tags: string[] };
  availability: SourceAvailability;
}) {
  const [state, action, pending] = useActionState(updateAoiSettingsAction.bind(null, slug, aoi.id), null);
  return (
    <form action={action} className="grid gap-4 md:grid-cols-2">
      {state ? <Notice tone={state.ok ? "success" : "error"} className="md:col-span-2">{state.ok ? "Saved. Changes to sources or monitoring queue a fresh imagery search." : state.error}</Notice> : null}
      <Field label="Name" htmlFor="a-name"><input id="a-name" name="name" defaultValue={aoi.name} required className={inputClass} /></Field>
      <Field label="Type" htmlFor="a-kind">
        <select id="a-kind" name="kind" defaultValue={aoi.kind} className={inputClass}>{AOI_KINDS.map((k) => <option key={k} value={k}>{AOI_KIND_LABEL[k]}</option>)}</select>
      </Field>
      <Field label="Description" htmlFor="a-desc" className="md:col-span-2"><textarea id="a-desc" name="description" rows={2} defaultValue={aoi.description} className={inputClass} /></Field>
      <label className="flex items-center gap-2 text-[0.8125rem]"><input type="checkbox" name="monitoringEnabled" defaultChecked={aoi.monitoringEnabled} /> Monitor automatically</label>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Check every (hours)" htmlFor="a-int"><input id="a-int" name="monitoringIntervalHours" type="number" min={1} max={8760} defaultValue={aoi.monitoringIntervalHours} className={inputClass} /></Field>
        <Field label="Max scene cloud (%)" htmlFor="a-cloud"><input id="a-cloud" name="maxCloudCover" type="number" min={0} max={100} defaultValue={aoi.maxCloudCover} className={inputClass} /></Field>
      </div>
      <fieldset className="md:col-span-2">
        <legend className="mb-1.5 text-[0.8125rem] text-bone-50/75">Data sources</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {Object.entries(DATA_SOURCES).map(([id, s]) => {
            const providerId = id.includes(":") ? id.split(":")[0]! : id;
            const av = availability[providerId];
            const unavailable = av && av.state !== "available";
            return (
              <label key={id} className="flex items-start gap-2 text-[0.8125rem]">
                <input type="checkbox" name="dataSources" value={id} defaultChecked={aoi.dataSources.includes(id)} className="mt-0.5" />
                <span>
                  {s.label}
                  {unavailable ? <span className="block text-[0.6875rem] text-data-amber">{av.state}: {av.reason}</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="md:col-span-2">
        <legend className="mb-1.5 text-[0.8125rem] text-bone-50/75">Analytics</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {Object.entries(ANALYTIC_OPTIONS).map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-[0.8125rem]"><input type="checkbox" name="enabledAnalytics" value={id} defaultChecked={aoi.enabledAnalytics.includes(id)} /> {label}</label>
          ))}
        </div>
      </fieldset>
      <Field label="News search terms" htmlFor="a-news" hint="Comma-separated place names to look for in news reports, e.g. “Tarboro, Edgecombe County”. Empty disables news matching.">
        <input id="a-news" name="newsTerms" defaultValue={aoi.newsTerms.join(", ")} className={inputClass} />
      </Field>
      <Field label="Tags" htmlFor="a-tags" hint="Comma-separated."><input id="a-tags" name="tags" defaultValue={aoi.tags.join(", ")} className={inputClass} /></Field>
      <div className="md:col-span-2"><Button type="submit" variant="primary" disabled={pending}>{pending ? "Saving…" : "Save configuration"}</Button></div>
    </form>
  );
}
