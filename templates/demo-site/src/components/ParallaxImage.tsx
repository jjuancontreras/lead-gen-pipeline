"use client";

import Image from "next/image";
import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";

export default function ParallaxImage({
  src,
  alt,
  strength = 0.15,
  className,
  preload,
}: {
  src: string;
  alt: string;
  /** fraction of the (oversized) layer's height it drifts by; keep <= ~0.15 to avoid edge gaps */
  strength?: number;
  className?: string;
  preload?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [`-${strength * 100}%`, `${strength * 100}%`]);

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      <motion.div style={{ y }} className="absolute inset-x-0 -top-[30%] -bottom-[30%]">
        <Image
          src={src}
          alt={alt}
          fill
          preload={preload}
          sizes="100vw"
          className={className ?? "object-cover"}
        />
      </motion.div>
    </div>
  );
}
