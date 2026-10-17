import { describe, expect, it } from "vitest";
import { assertPublicHttpsUrl } from "@/server/net";

describe("outbound URL guard", () => {
  it("accepts public https hosts", () => {
    expect(assertPublicHttpsUrl("https://sentinel-cogs.s3.us-west-2.amazonaws.com/a/B04.tif").hostname).toContain("amazonaws.com");
  });
  it.each([
    "http://example.com/a.tif",
    "https://localhost/a.tif",
    "https://127.0.0.1/a.tif",
    "https://10.0.0.5/a.tif",
    "https://172.20.1.1/a.tif",
    "https://192.168.1.1/a.tif",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a.tif",
    "https://metadata.google.internal/x",
    "https://user:pass@example.com/a.tif",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertPublicHttpsUrl(url)).toThrow();
  });
});
