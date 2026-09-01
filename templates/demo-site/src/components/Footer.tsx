import Link from "next/link";
import { brand, branches, telHref, brandNameParts } from "@/lib/content";

const socialLinks = [
  { label: "Instagram", href: brand.social.instagram },
  { label: "TikTok", href: brand.social.tiktok },
  { label: "Facebook", href: brand.social.facebook },
];

export default function Footer() {
  return (
    <footer className="border-t border-white/10 bg-bg-soft">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-3">
        <div>
          <p className="text-display text-xl tracking-wide">
            {brandNameParts().lead} <span className="text-brand">{brandNameParts().rest}</span>
          </p>
          <p className="mt-3 max-w-xs text-sm text-text-dim">
            {brand.description || brand.tagline}
          </p>
          <div className="mt-4 flex gap-4">
            {socialLinks.map((s) => (
              <a
                key={s.label}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-text-dim transition-colors hover:text-brand"
              >
                {s.label}
              </a>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-text">Branches</p>
          <ul className="mt-3 space-y-2 text-sm text-text-dim">
            {branches.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-4">
                <span>{b.shortName}</span>
                <a href={telHref(b.phone)} className="hover:text-brand">
                  {b.phoneDisplay}
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-text">Explore</p>
          <ul className="mt-3 space-y-2 text-sm text-text-dim">
            <li>
              <Link href="/menu" className="hover:text-brand">
                Menu
              </Link>
            </li>
            <li>
              <Link href="/locations" className="hover:text-brand">
                Locations
              </Link>
            </li>
            <li>
              <Link href="/about" className="hover:text-brand">
                About
              </Link>
            </li>
            <li>
              <a href={`mailto:${brand.email}`} className="hover:text-brand">
                {brand.email}
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10 py-4 text-center text-xs text-text-dim/70">
        © {new Date().getFullYear()} {brand.name}. All rights reserved.
      </div>
    </footer>
  );
}
