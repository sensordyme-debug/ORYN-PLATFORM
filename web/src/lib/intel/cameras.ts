/**
 * Public camera registry: camera locations, what each camera actually offers
 * (a periodically refreshed still image and/or live video), and the
 * provider's terms. Pure data and types; safe for client components.
 *
 * Honesty rules the UI follows:
 *  - A still image is labelled as a still with its capture time (the image
 *    file's Last-Modified), never as live video.
 *  - Live video is HLS played directly from the operator's server; ORYN does
 *    not relay, record, or archive it (Caltrans neither retains nor archives
 *    footage either).
 *  - No computer vision runs on any camera. `analytics.status` says so until
 *    a real detector exists.
 */

export const CAMERA_PROVIDER_IDS = ["caltrans-cctv"] as const;
export type CameraProviderId = (typeof CAMERA_PROVIDER_IDS)[number];

export type CameraProvider = {
  id: CameraProviderId;
  name: string;
  operator: string;
  coverage: string;
  license: string;
  attribution: string;
  sourceUrl: string;
  termsUrl: string;
  /** Hosts the browser loads stills and video from (allowed by the CSP). */
  mediaHosts: string[];
  limitations: string[];
};

export const CAMERA_PROVIDERS: Record<CameraProviderId, CameraProvider> = {
  "caltrans-cctv": {
    id: "caltrans-cctv",
    name: "Caltrans traffic cameras",
    operator: "California Department of Transportation (Caltrans), CWWP2",
    coverage: "California state highways",
    license:
      "Caltrans CWWP2: “These files are available for integration into your application … There is no charge for the use of this data.” Caltrans website information is generally public domain.",
    attribution: "Traffic cameras: California Department of Transportation (Caltrans), CWWP2. Not endorsed by Caltrans.",
    sourceUrl: "https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm",
    termsUrl: "https://dot.ca.gov/conditions-of-use",
    mediaHosts: ["https://cwwp2.dot.ca.gov", "https://wzmedia.dot.ca.gov"],
    limitations: [
      "Camera views are for general travel information; Caltrans may point a camera elsewhere or take it offline at any time.",
      "Live video is typically some seconds behind real time; still images refresh every few minutes.",
      "Neither Caltrans nor ORYN records or archives camera footage, so there is no playback of past video.",
    ],
  },
};

export type CameraAnalyticsStatus = { status: "not_enabled"; note: string };
export const NO_CAMERA_ANALYTICS: CameraAnalyticsStatus = {
  status: "not_enabled",
  note: "No computer vision runs on this camera: there are no automated detections, counts, or classifications.",
};

export type CameraRecord = {
  /** Stable id: provider:district:index. */
  id: string;
  provider: CameraProviderId;
  name: string;
  lon: number;
  lat: number;
  route: string | null;
  direction: string | null;
  nearby: string | null;
  district: string | null;
  /** A still JPEG the operator refreshes every `refreshMinutes`. */
  still: { url: string; refreshMinutes: number | null } | null;
  /** Live HLS stream (.m3u8), when the operator publishes one. */
  video: { hls: string } | null;
};

/** Server-side check of a camera's live stream (a HEAD request to its registered playlist). */
export type StreamHealth = {
  cameraId: string;
  status: "online" | "offline" | "no_video" | "unknown";
  /** HTTP status from the operator's stream server, when it answered. */
  httpStatus: number | null;
  checkedAt: string;
  message: string;
};

export type CamerasResponse = {
  provider: CameraProvider;
  feed: { state: "nominal" | "partial" | "stale" | "unavailable" | "disabled"; retrievedAt: string | null; message: string | null };
  analytics: CameraAnalyticsStatus;
  /** Matching cameras before the response limit was applied. */
  total: number;
  cameras: CameraRecord[];
};
