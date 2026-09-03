import Image from "next/image";
import Hero from "@/components/Hero";
import AnimatedSection from "@/components/AnimatedSection";
import BranchCard from "@/components/BranchCard";
import ParallaxImage from "@/components/ParallaxImage";
import OpenItemsNote from "@/components/OpenItemsNote";
import { branches, brand, featuredItems, formatPrice, assets } from "@/lib/content";
import { btnPrimary } from "@/lib/styles";


export default function Home() {
  // Driven by content.json so a menu change is a data edit, never a code edit.
  const featured = featuredItems(4);

  return (
    <>
      <Hero />

      <AnimatedSection id="menu" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand">
            Fan Favorites
          </p>
          <h2 className="text-display mt-2 text-4xl text-text sm:text-5xl">Featured Dishes</h2>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {featured.map((dish, i) => (
            <AnimatedSection
              key={dish.name}
              delay={i * 0.1}
              className="group overflow-hidden rounded-xl border border-white/10 bg-surface/60"
            >
              <div className="relative aspect-square overflow-hidden">
                {dish.image ? (
                  <Image
                    src={dish.image}
                    alt={dish.name}
                    fill
                    sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover transition-transform duration-500 group-hover:scale-110"
                  />
                ) : (
                  <div className="bg-surface" />
                )}
              </div>
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-text">{dish.name}</h3>
                  <span className="text-sm font-semibold text-brand">{formatPrice(dish)}</span>
                </div>
                <p className="mt-1 text-sm text-text-dim">{dish.description}</p>
              </div>
            </AnimatedSection>
          ))}
        </div>

        <div className="mt-10 text-center">
          <a
            href="#menu"
            className="inline-block rounded-full border border-text/30 px-7 py-3 text-sm font-semibold uppercase tracking-wider text-text transition-colors hover:border-brand hover:text-brand"
          >
            See Full Menu
          </a>
        </div>
      </AnimatedSection>

      <AnimatedSection id="branches" className="relative overflow-hidden py-20">
        {assets.texture ? (
          <ParallaxImage
            src={assets.texture}
            alt=""
            className="object-cover opacity-30"
          />
        ) : null}
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <div className="text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand">
              {branches.length > 1 ? `${branches.length} Branches` : "Visit Us"}
            </p>
            <h2 className="text-display mt-2 text-4xl text-text sm:text-5xl">Find Your Branch</h2>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {branches.map((branch, i) => (
              <AnimatedSection key={branch.id} delay={i * 0.1}>
                <BranchCard branch={branch} />
              </AnimatedSection>
            ))}
          </div>
        </div>
      </AnimatedSection>

      <AnimatedSection className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand">
          {brand.social.instagramHandle}
        </p>
        <h2 className="text-display mt-2 text-4xl text-text sm:text-5xl">Follow Along</h2>
        <p className="mx-auto mt-4 max-w-xl text-text-dim">
          See the latest from {brand.name} on socials.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-4">
          <a
            href={brand.social.instagram}
            target="_blank"
            rel="noopener noreferrer"
            className={btnPrimary()}
          >
            Instagram
          </a>
          <a
            href={brand.social.tiktok}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-text/30 px-6 py-3 text-sm font-semibold uppercase tracking-wider text-text transition-colors hover:border-brand hover:text-brand"
          >
            TikTok
          </a>
          <a
            href={brand.social.facebook}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-text/30 px-6 py-3 text-sm font-semibold uppercase tracking-wider text-text transition-colors hover:border-brand hover:text-brand"
          >
            Facebook
          </a>
        </div>
      </AnimatedSection>
      <OpenItemsNote />
    </>
  );
}
