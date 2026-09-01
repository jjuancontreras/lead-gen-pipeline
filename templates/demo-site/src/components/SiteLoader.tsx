"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { brand } from "@/lib/content";

const LOAD_DURATION_MS = 1600;
const HOLD_AT_FULL_MS = 250;
const REDUCED_MOTION_DURATION_MS = 300;

export default function SiteLoader() {
  const [progress, setProgress] = useState(0);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const duration = prefersReducedMotion
      ? REDUCED_MOTION_DURATION_MS
      : LOAD_DURATION_MS;

    let raf: number;
    const start = performance.now();

    const tick = (now: number) => {
      const ratio = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - ratio, 3); // ease-out cubic
      setProgress(Math.round(eased * 100));

      if (ratio < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setTimeout(() => setIsVisible(false), HOLD_AT_FULL_MS);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Lock scroll while the splash is covering the page.
  useEffect(() => {
    document.body.style.overflow = isVisible ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isVisible]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          role="status"
          aria-live="polite"
          aria-label={`Loading ${brand.name}, ${progress}%`}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 bg-bg"
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
        >
          <p className="text-display brush-underline text-3xl tracking-wide text-text sm:text-4xl">
            {brand.name}
          </p>

          <div className="flex w-48 flex-col items-center gap-3 sm:w-56">
            <div
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised"
            >
              <div
                className="h-full rounded-full bg-brand transition-[width] duration-150 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs font-semibold uppercase tracking-[0.3em] text-text-dim">
              {progress}%
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
