"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import MenuItemCard from "@/components/MenuItemCard";
import type { MenuCategory } from "@/lib/content";

export default function MenuBrowser({ categories }: { categories: MenuCategory[] }) {
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return categories
      .filter((cat) => activeCategory === "all" || cat.id === activeCategory)
      .map((cat) => ({
        ...cat,
        items: cat.items.filter((item) => !q || item.name.toLowerCase().includes(q)),
      }))
      .filter((cat) => cat.items.length > 0);
  }, [categories, activeCategory, query]);

  return (
    <div>
      <div className="sticky top-[64px] z-30 -mx-4 border-b border-white/10 bg-bg/95 px-4 py-4 backdrop-blur sm:top-[72px] sm:-mx-6 sm:px-6">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the menu…"
          className="w-full rounded-full border border-white/15 bg-surface/70 px-5 py-2.5 text-sm text-text placeholder:text-text-dim/60 focus:border-brand focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => setActiveCategory("all")}
            className={clsx(
              "shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors",
              activeCategory === "all"
                ? "bg-brand text-text"
                : "bg-white/5 text-text-dim hover:bg-white/10"
            )}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={clsx(
                "shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors",
                activeCategory === cat.id
                  ? "bg-brand text-text"
                  : "bg-white/5 text-text-dim hover:bg-white/10"
              )}
            >
              {cat.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-12">
        {filtered.length === 0 && (
          <p className="text-center text-text-dim">No dishes match your search.</p>
        )}
        {filtered.map((cat) => (
          <div key={cat.id} id={cat.id}>
            <h2 className="text-display text-3xl tracking-wide text-text">{cat.name}</h2>
            {cat.note && <p className="mt-1 text-sm text-text-dim">{cat.note}</p>}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {cat.items.map((item) => (
                <MenuItemCard key={item.name} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
