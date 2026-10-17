"use client";

import { ProductExplorer } from "@/components/explorer/product-explorer";
import { EdgeBlueprint, type EdgePart } from "@/components/viz/edge-blueprint";
import { edgeSystems } from "@/content/sensordyme";

const loadStage = async () => {
  const [model, stage] = await Promise.all([import("@/components/edge/edge-model"), import("@/components/explorer/product-stage")]);
  return { createStage: model.createStage, webglAvailable: stage.webglAvailable };
};

const drawingPart: Record<string, EdgePart | null> = {
  exterior: null,
  enclosure: "enclosure",
  camera: "camera",
  night: "night",
  compute: "compute",
  accelerator: "accelerator",
  alerts: "alerts",
  power: "power",
  intelligence: "camera",
};

/** SensorDyme Edge — interactive blueprint explorer of the prototype's architecture. */
export function EdgeExplorer({ idPrefix = "edge" }: { idPrefix?: string }) {
  return (
    <ProductExplorer
      systems={edgeSystems}
      idPrefix={idPrefix}
      loadStage={loadStage}
      tag="SensorDyme Edge · blueprint model"
      listLabel="Device components"
      description="A rotatable 3D blueprint model of SensorDyme Edge: a rectangular enclosure with the camera on its front face, and the camera module, infrared illuminator, Raspberry Pi 5, AI HAT+ accelerator, buzzer, status light, and USB-C power inside."
      note="Blueprint model of the SensorDyme Edge prototype's internal architecture. Proportions are illustrative and are not published dimensions; the current prototype enclosure appears in the renders below."
      drawing={(id, withCallouts) => <EdgeBlueprint className="!h-full !w-full max-w-[720px]" active={drawingPart[id] ?? null} showTitleBlock={withCallouts} showCallouts={withCallouts} />}
    />
  );
}
