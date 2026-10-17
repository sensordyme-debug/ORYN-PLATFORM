"use client";

import Image from "next/image";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef } from "react";
import type { MediaImage } from "@/content/media";
import { cn } from "@/lib/cn";

/** Image that drifts gently against the scroll direction. */
export function ParallaxImage({
  image,
  className,
  sizes = "100vw",
  strength = 8,
  priority,
  imgClassName,
}: {
  image: MediaImage;
  className?: string;
  sizes?: string;
  strength?: number;
  priority?: boolean;
  imgClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [`-${strength}%`, `${strength}%`]);

  return (
    <div ref={ref} className={cn("relative overflow-hidden", className)}>
      <motion.div className="absolute inset-[-10%_0]" style={reduce ? undefined : { y }}>
        <Image
          src={image.src}
          alt={image.alt}
          fill
          sizes={sizes}
          placeholder="blur"
          priority={priority}
          className={cn("object-cover", imgClassName)}
          style={{ objectPosition: image.focal }}
        />
      </motion.div>
    </div>
  );
}
