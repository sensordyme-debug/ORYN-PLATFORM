"use client";

/**
 * A public camera: its still image (labelled as a still, with the capture
 * time read from the image's Last-Modified header) and, when the operator
 * publishes one, live HLS video played directly from the operator's server.
 * Nothing is relayed, recorded, or analysed by ORYN.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, ApiError, orgApi } from "@/components/map/api";
import { Badge, Button } from "@/components/platform/ui";
import { formatDateTime, relativeTime } from "@/lib/format";
import { CAMERA_PROVIDERS, NO_CAMERA_ANALYTICS, type CameraRecord, type StreamHealth } from "@/lib/intel/cameras";

type StreamState =
  | { s: "idle" }
  | { s: "connecting" }
  | { s: "live"; latencySec: number | null; height: number | null }
  | { s: "failed"; message: string }
  | { s: "unsupported" };

function LiveVideo({ url }: { url: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<StreamState>({ s: "connecting" });

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let destroyed = false;
    let hls: import("hls.js").default | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const onPlaying = () => !destroyed && setState((s) => (s.s === "live" ? s : { s: "live", latencySec: null, height: el.videoHeight || null }));
    el.addEventListener("playing", onPlaying);
    void (async () => {
      const { default: Hls } = await import("hls.js");
      if (destroyed) return;
      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, maxBufferLength: 20 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal || destroyed) return;
          setState({ s: "failed", message: data.type === Hls.ErrorTypes.NETWORK_ERROR ? "The stream did not respond (network error)." : `The stream could not be played (${data.details}).` });
          hls?.destroy();
        });
        hls.loadSource(url);
        hls.attachMedia(el);
        hls.on(Hls.Events.MANIFEST_PARSED, () => void el.play().catch(() => undefined));
        timer = setInterval(() => {
          if (!hls || destroyed) return;
          setState((s) => (s.s === "live" ? { ...s, latencySec: Number.isFinite(hls!.latency) ? Math.round(hls!.latency) : null, height: el.videoHeight || s.height } : s));
        }, 2000);
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        el.src = url;
        void el.play().catch(() => undefined);
      } else {
        setState({ s: "unsupported" });
      }
    })().catch(() => !destroyed && setState({ s: "failed", message: "The video player could not start." }));
    return () => {
      destroyed = true;
      if (timer) clearInterval(timer);
      el.removeEventListener("playing", onPlaying);
      hls?.destroy();
      el.removeAttribute("src");
      el.load();
    };
  }, [url]);

  return (
    <div className="flex flex-col gap-1.5">
      <video ref={video} muted playsInline controls className="aspect-video w-full rounded-[3px] bg-black" aria-label="Live camera video" />
      <p className="text-[0.6875rem]" role="status">
        {state.s === "connecting" ? <span className="text-bone-50/55">Connecting to the stream…</span> : null}
        {state.s === "live" ? (
          <span className="text-data-veg">
            Live video playing{state.height ? ` · ${state.height}p` : ""}{state.latencySec !== null ? ` · about ${state.latencySec} s behind the live edge` : ""}
          </span>
        ) : null}
        {state.s === "failed" ? <span className="text-data-amber">{state.message}</span> : null}
        {state.s === "unsupported" ? <span className="text-data-amber">This browser cannot play HLS video.</span> : null}
      </p>
    </div>
  );
}

function StillImage({ url, refreshMinutes, timeZone }: { url: string; refreshMinutes: number | null; timeZone: string }) {
  const [tick, setTick] = useState(0);
  const [captured, setCaptured] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ms = Math.max(1, refreshMinutes ?? 2) * 60_000;
    const t = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [refreshMinutes]);
  useEffect(() => {
    let cancelled = false;
    fetch(url, { method: "HEAD", cache: "no-store" })
      .then((r) => !cancelled && setCaptured(r.ok ? r.headers.get("last-modified") : null))
      .catch(() => !cancelled && setCaptured(null));
    return () => {
      cancelled = true;
    };
  }, [url, tick]);
  const src = `${url}?oryn=${tick}`;
  return (
    <figure className="flex flex-col gap-1.5">
      {failed ? (
        <p className="rounded-[3px] border border-bone-50/10 p-3 text-[0.75rem] text-data-amber">The still image could not be loaded.</p>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- external, frequently refreshed camera image
        <img src={src} alt="Camera still image" className="w-full rounded-[3px] bg-black" onError={() => setFailed(true)} onLoad={() => setFailed(false)} />
      )}
      <figcaption className="text-[0.6875rem] text-bone-50/55">
        Still image —{" "}
        {captured ? `captured ${formatDateTime(captured, timeZone)} (${relativeTime(captured)})` : captured === null ? "capture time not provided" : "reading capture time…"}
        {refreshMinutes ? ` · the operator refreshes it about every ${refreshMinutes} min` : ""}
      </figcaption>
    </figure>
  );
}

export function CameraCard({ slug, cam, timeZone, onClose }: { slug: string; cam: CameraRecord; timeZone: string; onClose: () => void }) {
  const provider = CAMERA_PROVIDERS[cam.provider];
  const [playing, setPlaying] = useState(false);
  const [health, setHealth] = useState<StreamHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    if (!cam.video) return;
    let cancelled = false;
    api<StreamHealth>(`${orgApi(slug)}/intel/cameras/${encodeURIComponent(cam.id)}/health`)
      .then((h) => {
        if (cancelled) return;
        setHealth(h);
        setHealthError(null);
      })
      .catch((e: unknown) => !cancelled && setHealthError(e instanceof ApiError ? e.message : "The stream check failed."));
    return () => {
      cancelled = true;
    };
  }, [slug, cam.id, cam.video, checks]);
  const offline = health?.status === "offline";
  return (
    <div className="flex flex-col gap-3 p-4 text-[0.8125rem]" aria-label="Camera details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="t-eyebrow text-bone-50/45">{provider.name} · public camera</p>
          <h2 className="mt-1 text-[0.9375rem] font-medium">{cam.name}</h2>
        </div>
        <button aria-label="Close" onClick={onClose} className="p-1 text-bone-50/50 hover:text-bone-50"><X className="size-4" /></button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {cam.video ? <Badge tone="info">Live video available</Badge> : <Badge tone="muted">Still images only</Badge>}
        <Badge tone="muted">No computer vision</Badge>
      </div>
      {cam.video && playing ? <LiveVideo url={cam.video.hls} /> : cam.still ? <StillImage url={cam.still.url} refreshMinutes={cam.still.refreshMinutes} timeZone={timeZone} /> : null}
      {cam.video ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[0.6875rem]" aria-label="Stream status">
            {health ? (
              <span className={health.status === "online" ? "text-data-veg" : health.status === "offline" ? "text-data-amber" : "text-bone-50/60"}>
                Stream {health.status === "online" ? "online" : health.status === "offline" ? "offline" : "status unknown"} — {health.message} <span className="text-bone-50/40">(checked {relativeTime(health.checkedAt)})</span>
              </span>
            ) : healthError ? (
              <span className="text-data-amber">{healthError}</span>
            ) : (
              <span className="text-bone-50/50">Checking the live stream…</span>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={playing ? "secondary" : "primary"} disabled={offline && !playing} onClick={() => setPlaying((p) => !p)}>
              {playing ? "Stop video and show the still" : "Play live video"}
            </Button>
            {offline ? <Button size="sm" variant="ghost" onClick={() => setChecks((c) => c + 1)}>Check again</Button> : null}
          </div>
        </div>
      ) : null}
      <dl className="text-[0.75rem]">
        {[
          ["Route", [cam.route, cam.direction].filter(Boolean).join(" ")],
          ["Near", cam.nearby],
          ["District", cam.district],
          ["Coordinates", `${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`],
          ["Operator", provider.operator],
        ].map(([k, v]) =>
          v ? (
            <div key={k} className="flex justify-between gap-3 border-b border-bone-50/[0.05] py-1">
              <dt className="text-bone-50/50">{k}</dt>
              <dd className="text-right text-bone-50/85">{v}</dd>
            </div>
          ) : null,
        )}
      </dl>
      <p className="text-[0.75rem] text-bone-50/60">{NO_CAMERA_ANALYTICS.note}</p>
      <section aria-label="Limitations" className="text-[0.6875rem] text-bone-50/50">
        <p className="t-eyebrow mb-1 text-bone-50/45">Terms and limitations</p>
        <ul className="list-disc pl-4">{provider.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="mt-1">
          {provider.attribution}{" "}
          <a className="underline" href={provider.sourceUrl} target="_blank" rel="noopener noreferrer">Source and terms</a>
        </p>
      </section>
    </div>
  );
}
