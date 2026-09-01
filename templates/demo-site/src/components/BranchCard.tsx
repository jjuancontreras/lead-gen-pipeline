import { telHref, type Branch } from "@/lib/content";
import { btnPrimary } from "@/lib/styles";

export default function BranchCard({ branch }: { branch: Branch }) {
  const mapSrc = `https://www.google.com/maps?q=${encodeURIComponent(branch.mapQuery)}&output=embed`;

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-surface/60">
      <div className="aspect-[16/9] w-full shrink-0">
        <iframe
          title={`Map to ${branch.shortName}`}
          src={mapSrc}
          className="h-full w-full border-0 grayscale invert-[0.92] contrast-[1.1]"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-display text-2xl tracking-wide text-text">{branch.shortName}</h3>
        <p className="mt-2 text-sm text-text-dim">{branch.address}</p>
        <p className="mt-3 text-sm text-text">{branch.hours}</p>
        {!branch.hoursVerified && (
          <p className="mt-1 text-xs text-accent/80">Hours may vary — call to confirm</p>
        )}
        <div className="mt-auto flex flex-wrap gap-3 pt-4">
          <a
            href={telHref(branch.phone)}
            className={btnPrimary("px-5 py-2")}
          >
            Call {branch.phoneDisplay}
          </a>
          <a
            href={`https://www.google.com/maps?q=${encodeURIComponent(branch.mapQuery)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-text/30 px-5 py-2 text-sm font-semibold uppercase tracking-wider text-text transition-colors hover:border-brand hover:text-brand"
          >
            Get Directions
          </a>
        </div>
      </div>
    </div>
  );
}
