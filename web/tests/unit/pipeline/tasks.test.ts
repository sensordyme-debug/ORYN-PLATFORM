import { describe, expect, it } from "vitest";
import { tasksFor } from "@/server/pipeline/process";

describe("which analyses an image produces", () => {
  it("adds EVI and SAVI for Sentinel-2 and Landsat only when the area enables them", () => {
    expect(tasksFor("sentinel-2-l2a", ["ndvi"]).map((t) => t.model)).toEqual(["ndvi"]);
    expect(tasksFor("sentinel-2-l2a", ["ndvi", "evi", "savi", "ndmi"]).map((t) => t.model)).toEqual(["ndvi", "evi", "savi", "ndmi"]);
    expect(tasksFor("landsat-c2-l2", ["evi", "savi"]).map((t) => t.model)).toEqual(["evi", "savi"]);
  });

  it("never asks a radar or land-cover product for an optical index", () => {
    expect(tasksFor("sentinel-1-rtc", ["evi", "savi", "s1-water"]).map((t) => t.model)).toEqual(["s1-water"]);
    expect(tasksFor("esa-worldcover", ["evi", "savi"])).toEqual([]);
  });
});
