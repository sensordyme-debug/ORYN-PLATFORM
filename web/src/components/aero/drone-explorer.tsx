"use client";

import { ProductExplorer } from "@/components/explorer/product-explorer";
import { DroneBlueprint } from "@/components/viz/drone-blueprint";
import { aeroSystems } from "@/content/aero";

const loadStage = async () => {
  const [model, stage] = await Promise.all([import("@/components/aero/drone-model"), import("@/components/explorer/product-stage")]);
  return { createStage: model.createStage, webglAvailable: stage.webglAvailable };
};

/** SensorDyme Aero — interactive engineering explorer (concept model). */
export function DroneExplorer({ idPrefix = "aero" }: { idPrefix?: string }) {
  return (
    <ProductExplorer
      systems={aeroSystems}
      idPrefix={idPrefix}
      loadStage={loadStage}
      tag="SensorDyme Aero · A1 concept model"
      listLabel="Aircraft systems"
      description="A rotatable 3D concept model of the SensorDyme Aero development platform, a four-rotor aircraft with a central fuselage shaped like the ORYN mark."
      note="Concept visualization of the SensorDyme Aero development platform. Final hardware architecture, dimensions, payload, and performance specifications remain under development and subject to testing."
      drawing={(id, withCallouts) => (
        <DroneBlueprint
          className="!h-full !w-full max-w-[640px]"
          active={aeroSystems.find((s) => s.id === id)?.blueprint ?? null}
          showTitleBlock={false}
          showCallouts={withCallouts}
        />
      )}
    />
  );
}
