import { openItems } from "@/lib/content";

/**
 * Honest-handoff note, rendered on the page.
 *
 * Every demo is built from real sourced content, but some details cannot be
 * confirmed without the owner. Those are listed here rather than invented and
 * presented as fact. Delete each line from content.json as it gets verified;
 * when the list is empty this renders nothing.
 */
export default function OpenItemsNote() {
  if (openItems.length === 0) return null;

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
      <div className="rounded-2xl border border-text/15 bg-surface/50 p-6">
        <p className="text-display text-lg font-bold text-text">
          Before this goes live for real
        </p>
        <p className="mt-1 text-sm text-text-dim">
          Everything on this page is real, sourced content. These specific
          points still need your confirmation.
        </p>
        <ul className="mt-4 space-y-2">
          {openItems.map((item) => (
            <li
              key={item}
              className="block rounded-lg border border-dashed border-brand/40 px-3 py-2 text-sm text-text-dim"
            >
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
