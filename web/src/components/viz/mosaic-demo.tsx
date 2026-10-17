"use client";

import Image from "next/image";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import baseImg from "@/assets/usgs/system-base.jpg";
import { MAP } from "@/content/missions";

// The composition crop, in Command basemap pixels (zoom 14).
const CROP = { x0: 1480, y0: 450, x1: 2200, y1: 1030 };
const COLS = 6;
const ROWS = 5;

const toMerc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
function latLon(x: number, y: number) {
  const n = toMerc(MAP.bounds.north);
  const s = toMerc(MAP.bounds.south);
  const lon = MAP.bounds.west + (x / MAP.width) * (MAP.bounds.east - MAP.bounds.west);
  const m = n - (y / MAP.height) * (n - s);
  return { lat: (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * (180 / Math.PI), lon };
}

/** Image tiles "stitch" into a georeferenced mosaic with a coordinate graticule. */
export function MosaicDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -20% 0px" });
  const reduce = useReducedMotion();
  const show = inView || !!reduce;
  const nw = latLon(CROP.x0, CROP.y0);
  const se = latLon(CROP.x1, CROP.y1);
  const widthKm = ((CROP.x1 - CROP.x0) * MAP.metersPerPixel) / 1000;
  const heightKm = ((CROP.y1 - CROP.y0) * MAP.metersPerPixel) / 1000;
  const lons = Array.from({ length: 4 }, (_, i) => nw.lon + ((se.lon - nw.lon) * (i + 0.5)) / 4);
  const lats = Array.from({ length: 3 }, (_, i) => nw.lat + ((se.lat - nw.lat) * (i + 0.5)) / 3);

  return (
    <div ref={ref}>
      <div className="relative aspect-[1440/1160] overflow-hidden rounded-[3px] bg-ink-850">
        {Array.from({ length: COLS * ROWS }, (_, i) => {
          const c = i % COLS;
          const r = Math.floor(i / COLS);
          const order = (c + r * 1.3) / (COLS + ROWS * 1.3);
          return (
            <motion.div
              key={i}
              className="absolute overflow-hidden"
              style={{ left: `${(c / COLS) * 100}%`, top: `${(r / ROWS) * 100}%`, width: `${100 / COLS}%`, height: `${100 / ROWS}%` }}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={show ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.7, delay: 0.2 + order * 1.6, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="absolute" style={{ width: `${COLS * 100}%`, height: `${ROWS * 100}%`, left: `${-c * 100}%`, top: `${-r * 100}%` }}>
                <Image src={baseImg} alt="" fill sizes="(min-width: 1024px) 60vw, 100vw" className="object-cover" />
              </div>
              <div className="absolute inset-0 border border-bone-50/25" />
            </motion.div>
          );
        })}

        {/* Graticule */}
        <motion.svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full"
          initial={{ opacity: 0 }}
          animate={show ? { opacity: 1 } : {}}
          transition={{ duration: 1, delay: 2.2 }}
          aria-hidden="true"
        >
          {lons.map((_, i) => (
            <line key={`v${i}`} x1={((i + 0.5) / 4) * 100} x2={((i + 0.5) / 4) * 100} y1="0" y2="100" stroke="#f2f1ed" strokeOpacity="0.6" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          ))}
          {lats.map((_, i) => (
            <line key={`h${i}`} y1={((i + 0.5) / 3) * 100} y2={((i + 0.5) / 3) * 100} x1="0" x2="100" stroke="#f2f1ed" strokeOpacity="0.6" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
          ))}
        </motion.svg>
        <motion.div className="pointer-events-none absolute inset-0" initial={{ opacity: 0 }} animate={show ? { opacity: 1 } : {}} transition={{ duration: 1, delay: 2.4 }}>
          {lons.map((lon, i) => (
            <span key={i} className="t-mono absolute top-2 -translate-x-1/2 bg-ink-950/75 px-1 text-[0.5625rem] text-bone-50/85" style={{ left: `${((i + 0.5) / 4) * 100}%` }}>
              {Math.abs(lon).toFixed(3)}°W
            </span>
          ))}
          {lats.map((lat, i) => (
            <span key={i} className="t-mono absolute left-2 -translate-y-1/2 bg-ink-950/75 px-1 text-[0.5625rem] text-bone-50/85" style={{ top: `${((i + 0.5) / 3) * 100}%` }}>
              {lat.toFixed(3)}°N
            </span>
          ))}
          <div className="absolute bottom-3 right-3 rounded-[2px] bg-ink-950/80 p-2.5 backdrop-blur">
            <div className="t-mono text-[0.625rem] text-bone-50/50">Mosaic extent</div>
            <div className="t-mono text-[0.6875rem] text-bone-50/90">
              {widthKm.toFixed(1)} × {heightKm.toFixed(1)} km · {COLS * ROWS} tiles
            </div>
          </div>
        </motion.div>
      </div>
      <p className="t-mono mt-3 text-[0.6875rem] text-bone-50/60">
        Illustration · USGS orthoimagery (public domain), Grant County, Washington. Coordinates computed from the source tiles.
      </p>
    </div>
  );
}
