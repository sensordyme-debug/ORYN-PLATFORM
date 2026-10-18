import { describe, expect, it } from "vitest";
import { aoiUpdateSchema } from "@/server/aois/service";

describe("area updates", () => {
  it("leave fields the request does not mention unchanged — metadata included", () => {
    // A partial update (e.g. enabling analytics, or editing the boundary) used to carry
    // metadata: {} through a schema default, wiping the area's metadata (crop, season, …).
    const parsed = aoiUpdateSchema.parse({ enabledAnalytics: ["ndvi", "evi"] });
    expect(parsed).toEqual({ enabledAnalytics: ["ndvi", "evi"] });
    expect("metadata" in parsed).toBe(false);
    expect(aoiUpdateSchema.parse({ metadata: { crop: "cotton" } }).metadata).toEqual({ crop: "cotton" });
  });
});
