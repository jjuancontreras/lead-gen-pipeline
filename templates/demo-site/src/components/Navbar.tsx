"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { brand, brandNameParts } from "@/lib/content";

const links = [
  { href: "/", label: "Home" },
  { href: "/menu", label: "Menu" },
  { href: "/locations", label: "Locations" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2" onClick={() => setOpen(false)}>
          {brand.logo ? (
            <Image
              src={brand.logo}
              alt={brand.name}
              width={48}
              height={48}
              className="h-10 w-10 rounded-sm object-cover sm:h-12 sm:w-12"
              preload
            />
          ) : null}
          <span className="text-display text-lg leading-none tracking-wide text-text sm:text-xl">
            {brandNameParts().lead} <span className="text-brand">{brandNameParts().rest}</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {links.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={clsx(
                  "text-sm font-medium uppercase tracking-wider transition-colors hover:text-brand",
                  active ? "text-brand" : "text-text-dim"
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={open}
          aria-controls="mobile-nav"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-white/15 text-text md:hidden"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="relative block h-3 w-5">
            <span
              className={clsx(
                "absolute left-0 top-0 block h-0.5 w-5 bg-text transition-transform",
                open && "translate-y-[5px] rotate-45"
              )}
            />
            <span
              className={clsx(
                "absolute left-0 bottom-0 block h-0.5 w-5 bg-text transition-transform",
                open && "-translate-y-[5px] -rotate-45"
              )}
            />
          </span>
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.nav
            id="mobile-nav"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden border-t border-white/10 md:hidden"
          >
            <div className="flex flex-col gap-1 px-4 py-3 sm:px-6">
              {links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className={clsx(
                    "rounded-md px-3 py-2 text-sm font-medium uppercase tracking-wider",
                    pathname === link.href
                      ? "bg-brand/10 text-brand"
                      : "text-text-dim hover:bg-white/5 hover:text-text"
                  )}
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </motion.nav>
        )}
      </AnimatePresence>
    </header>
  );
}
