"use client";

import { getImageProps, type StaticImageData } from "next/image";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

type Props = {
  poster: StaticImageData;
  posterMobile?: StaticImageData;
  alt: string;
  video?: { desktop: string; mobile?: string };
  className?: string;
};

/**
 * Full-bleed hero media. The poster is server-rendered (fast LCP); the video
 * fades in over it once playing. Video is skipped when the visitor prefers
 * reduced motion or has Save-Data enabled, and pauses when off-screen.
 */
export function HeroMedia({ poster, posterMobile, alt, video, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [enabled, setEnabled] = useState(false);

  const common = { alt, sizes: "100vw", priority: true, quality: 80 } as const;
  const {
    props: { srcSet: desktopSrcSet, ...desktopProps },
  } = getImageProps({ ...common, src: poster, placeholder: "empty" });
  const mobile = posterMobile ? getImageProps({ ...common, src: posterMobile }).props : null;

  useEffect(() => {
    if (!video) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    if (reduce || saveData) return;
    const t = window.setTimeout(() => setEnabled(true), 0);
    return () => window.clearTimeout(t);
  }, [video]);

  useEffect(() => {
    const v = videoRef.current;
    if (!enabled || !v) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting && !userPaused) v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.05 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [enabled, userPaused]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      setUserPaused(false);
      v.play().catch(() => {});
    } else {
      setUserPaused(true);
      v.pause();
    }
  };

  return (
    <div className={cn("absolute inset-0 overflow-hidden", className)}>
      <picture>
        {mobile ? <source media="(max-width: 767px)" srcSet={mobile.srcSet} sizes="100vw" /> : null}
        <source media="(min-width: 768px)" srcSet={desktopSrcSet} sizes="100vw" />
        {/* eslint-disable-next-line jsx-a11y/alt-text -- alt supplied via props spread */}
        <img
          {...desktopProps}
          className={cn(
            "absolute inset-0 size-full object-cover",
            video
              ? "animate-[hero-settle_2.4s_var(--ease-out-expo)_both]"
              : "animate-[hero-settle_2.4s_var(--ease-out-expo)_both,hero-drift_40s_ease-in-out_2.4s_infinite_alternate]",
          )}
          style={{ objectPosition: "50% 50%" }}
        />
      </picture>

      {enabled && video ? (
        <video
          ref={videoRef}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-[1600ms] ease-out",
            playing ? "opacity-100" : "opacity-0",
          )}
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden="true"
          onPlaying={() => setPlaying(true)}
          onError={() => setPlaying(false)}
        >
          {video.mobile ? <source src={video.mobile} type="video/mp4" media="(max-width: 767px)" /> : null}
          <source src={video.desktop} type="video/mp4" />
        </video>
      ) : null}

      {enabled && video ? (
        <button
          type="button"
          onClick={toggle}
          className="absolute right-[var(--gutter)] top-[calc(var(--header-h)+0.75rem)] z-20 hidden h-9 items-center gap-2 rounded-full border border-bone-50/20 bg-ink-950/30 px-3 text-[0.75rem] text-bone-50/80 backdrop-blur-md transition-colors hover:border-bone-50/50 hover:text-bone-50 md:flex"
          aria-label={userPaused ? "Play background video" : "Pause background video"}
        >
          {userPaused ? (
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
              <path d="M3 2l7 4-7 4z" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
              <path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" />
            </svg>
          )}
          {userPaused ? "Play" : "Pause"}
        </button>
      ) : null}
    </div>
  );
}
