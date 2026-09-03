"use client";

import Image from "next/image";
import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import { btnPrimary } from "@/lib/styles";
import { brand, assets } from "@/lib/content";

const embers = [
  { left: "12%", size: 6, delay: 0 },
  { left: "24%", size: 4, delay: 0.8 },
  { left: "38%", size: 5, delay: 1.6 },
  { left: "55%", size: 3, delay: 0.4 },
  { left: "68%", size: 6, delay: 2 },
  { left: "80%", size: 4, delay: 1.2 },
  { left: "90%", size: 5, delay: 2.4 },
];

export default function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], ["0%", "40%"]);
  const opacity = useTransform(scrollYProgress, [0, 0.8], [1, 0]);

  return (
    <div ref={ref} className="relative flex h-[92vh] min-h-[560px] items-end overflow-hidden">
      <motion.div style={{ y }} className="absolute inset-0">
        {assets.hero ? (
          <Image
            src={assets.hero}
            alt={brand.name}
            fill
            preload
            sizes="100vw"
            className="object-cover"
          />
        ) : (
          // No hero asset harvested yet - a flat wash, not a broken request.
          <div className="absolute inset-0 bg-surface" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/50 to-bg/40" />
        <div className="absolute inset-0 bg-gradient-to-r from-bg/60 via-transparent to-bg/60" />
      </motion.div>

      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {embers.map((e, i) => (
          <span
            key={i}
            className="animate-ember absolute bottom-24 rounded-full bg-accent/80 blur-[1px]"
            style={{
              left: e.left,
              width: e.size,
              height: e.size,
              animationDelay: `${e.delay}s`,
            }}
          />
        ))}
      </div>

      <motion.div
        style={{ opacity }}
        className="relative z-10 mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6 sm:pb-24"
      >
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-sm font-semibold uppercase tracking-[0.3em] text-brand"
        >
          {brand.tagline}
        </motion.p>
        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="text-display mt-3 text-5xl leading-[0.95] text-text sm:text-7xl md:text-8xl"
        >
          {brand.name}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.35 }}
          className="mt-5 max-w-xl text-base text-text-dim sm:text-lg"
        >
          {brand.description}
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="mt-8 flex flex-wrap gap-4"
        >
          <a
            href="#menu"
            className={`${btnPrimary("px-7 py-3")} hover:bg-brand/90`}
          >
            View Menu
          </a>
          <a
            href="#branches"
            className="rounded-full border border-text/30 px-7 py-3 text-sm font-semibold uppercase tracking-wider text-text transition-colors hover:border-brand hover:text-brand"
          >
            Find a Branch
          </a>
        </motion.div>
      </motion.div>
    </div>
  );
}
