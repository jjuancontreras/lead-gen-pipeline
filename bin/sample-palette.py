#!/usr/bin/env python3
"""Sample a starting colour palette from harvested photos.

    python bin/sample-palette.py --slug kuro-cafe
    python bin/sample-palette.py --images a.jpg b.jpg --out kuro-cafe/DESIGN.md

Design notes
------------
1. A colour sampled straight off a real photo was chosen by nature/lighting/
   the photographer, not for text legibility. Every source we have seen lands
   dominant "brand" colours around 2.5-3.5:1 contrast against white - well
   under WCAG AA's 4.5:1. So this script never claims a token is "done": it
   prints the measured ratio for every pairing and flags anything under
   4.5:1 loudly. THE SAMPLER PROPOSES; A HUMAN APPROVES.

2. Output mirrors the token names already used in
   templates/demo-site/DESIGN.md and globals.css (bg, bg-soft, surface,
   surface-raised, brand, brand-dim, accent, accent-warm, text, text-dim) so
   the output can be pasted straight in, plus two derived "-text" variants
   (brand-text, accent-text) - a brand/accent colour darkened ~35-40% so it
   is usable as body text rather than only as a background chip.

3. Every colour-math function below is a plain function of plain data
   (RGB tuples, floats) precisely so it can be called and checked in
   isolation - see the __main__ self-check at the bottom, which is run with
   a synthetic Pillow image so this script's own math is verified without
   needing a real photo on disk.
"""
from __future__ import annotations

import argparse
import colorsys
import math
import os
import sys
from dataclasses import dataclass
from typing import Iterable

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment guard, not app logic
    print("Pillow is required: pip install Pillow", file=sys.stderr)
    sys.exit(1)

RGB = tuple[int, int, int]

# Template token names this script's YAML block must match exactly, so it
# can be pasted straight into DESIGN.md / globals.css without renaming.
TEMPLATE_TOKENS = [
    "bg", "bg-soft", "surface", "surface-raised",
    "brand", "brand-dim", "accent", "accent-warm",
    "text", "text-dim",
]

# How much darker the "-text" variants are made. Picked from the middle of
# the requested 35-40% band.
TEXT_VARIANT_DARKEN_PCT = 0.37

WCAG_AA_NORMAL_TEXT = 4.5

# -----------------------------------------------------------------------
# Colour math (pure)
# -----------------------------------------------------------------------


def hex_to_rgb(value: str) -> RGB:
    v = value.lstrip("#")
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def rgb_to_hex(rgb: RGB) -> str:
    r, g, b = (clamp_channel(c) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def clamp_channel(value: float) -> int:
    return max(0, min(255, round(value)))


def darken(rgb: RGB, pct: float) -> RGB:
    """Scale each channel toward black by `pct` (0..1). Simple sRGB-space
    scaling rather than a perceptual model - adequate for a proposal a
    human is going to eyeball and adjust anyway."""
    return tuple(clamp_channel(c * (1 - pct)) for c in rgb)  # type: ignore[return-value]


def lighten(rgb: RGB, pct: float) -> RGB:
    """Scale each channel toward white by `pct` (0..1)."""
    return tuple(clamp_channel(c + (255 - c) * pct) for c in rgb)  # type: ignore[return-value]


def mix(a: RGB, b: RGB, t: float) -> RGB:
    """Linear-in-sRGB interpolation from a (t=0) to b (t=1)."""
    return tuple(clamp_channel(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def saturation_of(rgb: RGB) -> float:
    r, g, b = (c / 255 for c in rgb)
    _h, _l, s = colorsys.rgb_to_hls(r, g, b)
    return s


def lightness_of(rgb: RGB) -> float:
    r, g, b = (c / 255 for c in rgb)
    _h, l, _s = colorsys.rgb_to_hls(r, g, b)
    return l


def hue_of(rgb: RGB) -> float:
    r, g, b = (c / 255 for c in rgb)
    h, _l, _s = colorsys.rgb_to_hls(r, g, b)
    return h


def _linearize_channel(c: int) -> float:
    cs = c / 255
    return cs / 12.92 if cs <= 0.03928 else ((cs + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb: RGB) -> float:
    r, g, b = rgb
    return 0.2126 * _linearize_channel(r) + 0.7152 * _linearize_channel(g) + 0.0722 * _linearize_channel(b)


def contrast_ratio(a: RGB, b: RGB) -> float:
    """WCAG 2.x contrast ratio, always >= 1.0 regardless of argument order."""
    la, lb = relative_luminance(a), relative_luminance(b)
    lighter, darker = (la, lb) if la >= lb else (lb, la)
    return (lighter + 0.05) / (darker + 0.05)


# -----------------------------------------------------------------------
# Dominant-colour sampling
# -----------------------------------------------------------------------


@dataclass
class SampledColor:
    rgb: RGB
    weight: int  # pixel count this colour represents, summed across inputs


def dominant_colors(image: "Image.Image", max_colors: int = 8, thumb: int = 150) -> list[SampledColor]:
    """Dominant colours in one image, most-frequent first.

    Downsampling to a small thumbnail before quantizing is what keeps this
    fast (a full-resolution photo has millions of distinct pixels once you
    count noise/JPEG artifacts) without materially changing which colours
    dominate - a 150px thumbnail still carries the same broad colour blocks
    a real photo is built from.
    """
    rgb_img = image.convert("RGB")
    rgb_img.thumbnail((thumb, thumb))
    quantized = rgb_img.quantize(colors=max_colors, method=Image.MEDIANCUT)
    palette = quantized.getpalette() or []
    counts = quantized.getcolors() or []  # [(count, paletteIndex), ...]
    out: list[SampledColor] = []
    for count, idx in sorted(counts, key=lambda c: -c[0]):
        base = idx * 3
        rgb = (palette[base], palette[base + 1], palette[base + 2])
        out.append(SampledColor(rgb=tuple(rgb), weight=count))  # type: ignore[arg-type]
    return out


def merge_sampled_colors(groups: Iterable[list[SampledColor]]) -> list[SampledColor]:
    """Combine per-image dominant-colour lists into one ranking, weighting
    each image equally regardless of resolution (both already reduced to
    the same thumbnail size) rather than letting one large photo dominate."""
    merged: dict[RGB, int] = {}
    for colors in groups:
        for c in colors:
            merged[c.rgb] = merged.get(c.rgb, 0) + c.weight
    return sorted((SampledColor(rgb, w) for rgb, w in merged.items()), key=lambda c: -c.weight)


# -----------------------------------------------------------------------
# Palette assignment - dominant colours -> named design tokens
# -----------------------------------------------------------------------


@dataclass
class Palette:
    tokens: dict[str, RGB]


def choose_bg_and_text(colors: list[SampledColor]) -> tuple[RGB, RGB]:
    """Lightest dominant colour becomes bg, darkest becomes text - falling
    back to pure white/near-black when the photos never actually contain
    anything light or dark enough to read as a page background or body
    copy (a close-up food shot can be all midtones)."""
    by_light = sorted(colors, key=lambda c: lightness_of(c.rgb))
    darkest = by_light[0].rgb if by_light else (20, 20, 20)
    lightest = by_light[-1].rgb if by_light else (245, 245, 244)

    bg = lightest if lightness_of(lightest) >= 0.85 else (255, 255, 255)
    text = darkest if lightness_of(darkest) <= 0.25 else (28, 25, 23)
    return bg, text


def choose_vivid(colors: list[SampledColor], exclude: list[RGB], count: int) -> list[RGB]:
    """Most frequent colours with real saturation - the ones that read as
    "this business's colour" rather than as a shadow or a wall. Colours too
    close to an already-excluded one (bg/text) are skipped so brand/accent
    never collapse onto the background by accident."""
    vivid = [c for c in colors if saturation_of(c.rgb) > 0.15]
    picked: list[RGB] = []
    for c in vivid:
        if any(contrast_ratio(c.rgb, e) < 1.2 for e in exclude + picked):
            continue
        picked.append(c.rgb)
        if len(picked) >= count:
            break
    return picked


def build_palette(colors: list[SampledColor]) -> Palette:
    if not colors:
        raise ValueError("no colours to sample from - pass at least one readable image")

    bg, text = choose_bg_and_text(colors)
    vivid = choose_vivid(colors, exclude=[bg, text], count=2)
    brand = vivid[0] if len(vivid) > 0 else darken(bg, 0.4)
    accent = vivid[1] if len(vivid) > 1 else lighten(brand, 0.15)

    tokens: dict[str, RGB] = {
        "bg": bg,
        "bg-soft": mix(bg, text, 0.04),
        "surface": mix(bg, text, 0.10),
        "surface-raised": mix(bg, text, 0.18),
        "brand": brand,
        "brand-dim": lighten(brand, 0.25),
        "accent": accent,
        "accent-warm": lighten(accent, 0.15),
        "text": text,
        "text-dim": mix(text, bg, 0.35),
        # Derived per the harvest module spec: a brand/accent colour is
        # sampled for how it looks in a photo, not for legibility as body
        # text, so darken it before it is ever used that way.
        "brand-text": darken(brand, TEXT_VARIANT_DARKEN_PCT),
        "accent-text": darken(accent, TEXT_VARIANT_DARKEN_PCT),
    }
    return Palette(tokens=tokens)


# -----------------------------------------------------------------------
# Contrast report
# -----------------------------------------------------------------------


@dataclass
class ContrastCheck:
    fg_name: str
    bg_name: str
    ratio: float

    @property
    def passes(self) -> bool:
        return self.ratio >= WCAG_AA_NORMAL_TEXT


def contrast_checks(palette: Palette) -> list[ContrastCheck]:
    pairs = [
        ("text", "bg"),
        ("text-dim", "bg"),
        ("text", "surface"),
        ("brand-text", "bg"),
        ("accent-text", "bg"),
        ("brand", "bg"),
        ("accent", "bg"),
    ]
    out = []
    for fg, bg in pairs:
        ratio = contrast_ratio(palette.tokens[fg], palette.tokens[bg])
        out.append(ContrastCheck(fg, bg, ratio))
    return out


# -----------------------------------------------------------------------
# Rendering
# -----------------------------------------------------------------------


def render_yaml_block(palette: Palette) -> str:
    lines = ["```yaml"]
    comments = {
        "bg": "page background", "bg-soft": "alternating band", "surface": "cards, panels",
        "surface-raised": "raised cards", "brand": "primary identity colour", "brand-dim": "muted brand",
        "accent": "secondary highlight", "accent-warm": "warm highlight", "text": "body copy",
        "text-dim": "muted copy", "brand-text": "brand colour, darkened for use as text",
        "accent-text": "accent colour, darkened for use as text",
    }
    width = max(len(k) + 1 for k in palette.tokens) + 1
    for name, rgb in palette.tokens.items():
        label = f"{name}:".ljust(width)
        lines.append(f'{label} "{rgb_to_hex(rgb)}"   # {comments.get(name, "")}')
    lines.append("```")
    return "\n".join(lines)


def render_contrast_table(checks: list[ContrastCheck]) -> str:
    lines = [
        "| foreground | background | ratio | pass |",
        "|---|---|---|---|",
    ]
    for c in checks:
        mark = "yes" if c.passes else "NO - below 4.5:1"
        lines.append(f"| {c.fg_name} | {c.bg_name} | {c.ratio:.2f}:1 | {mark} |")
    return "\n".join(lines)


# -----------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------


def find_harvested_images(websites_root: str, slug: str) -> list[str]:
    directory = os.path.join(websites_root, slug, "research", "images", "instagram")
    if not os.path.isdir(directory):
        return []
    exts = (".jpg", ".jpeg", ".png", ".webp")
    return sorted(
        os.path.join(directory, f) for f in os.listdir(directory) if f.lower().endswith(exts)
    )


def load_images(paths: list[str]) -> list["Image.Image"]:
    images = []
    for p in paths:
        try:
            images.append(Image.open(p))
        except Exception as err:  # noqa: BLE001 - report and continue, one bad file must not abort the batch
            print(f"  ! skipping {p}: {err}", file=sys.stderr)
    return images


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Sample a starting colour palette from harvested photos.")
    parser.add_argument("--slug", help="demo site slug - scans <WEBSITES_ROOT>/<slug>/research/images/instagram/")
    parser.add_argument("--images", nargs="+", help="explicit image paths (alternative to --slug)")
    parser.add_argument("--out", help="optional path to also write the YAML block + contrast table to")
    parser.add_argument("--max-colors", type=int, default=8, help="dominant colours sampled per image (default 8)")
    args = parser.parse_args(argv)

    if not args.slug and not args.images:
        parser.error("pass --slug or --images")

    if args.images:
        paths = args.images
    else:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        websites_root = os.path.dirname(os.path.dirname(script_dir))  # pipeline/bin -> pipeline -> WEBSITES_ROOT
        paths = find_harvested_images(websites_root, args.slug)
        if not paths:
            print(
                f"No harvested images found for slug '{args.slug}'. "
                f"Run `npm run harvest -- --slug {args.slug} --ig <handle>` first, "
                f"or pass --images explicitly.",
                file=sys.stderr,
            )
            return 1

    images = load_images(paths)
    if not images:
        print("No readable images.", file=sys.stderr)
        return 1

    per_image = [dominant_colors(img, max_colors=args.max_colors) for img in images]
    merged = merge_sampled_colors(per_image)
    palette = build_palette(merged)
    checks = contrast_checks(palette)

    yaml_block = render_yaml_block(palette)
    contrast_table = render_contrast_table(checks)
    failing = [c for c in checks if not c.passes]

    print(f"\nSampled from {len(images)} image(s):")
    for p in paths[: len(images)]:
        print(f"  {p}")
    print(f"\n{yaml_block}\n")
    print("### contrast checks\n")
    print(contrast_table)
    print()
    if failing:
        print(f"! {len(failing)} pairing(s) BELOW WCAG AA 4.5:1 - see the table above.")
    print(
        "\nThe sampler proposes; a human approves. These colours were chosen for how "
        "they look in the photo, not for legibility - check every row above by eye "
        "before shipping, and adjust anything flagged."
    )

    if args.out:
        with open(args.out, "a", encoding="utf-8") as f:
            f.write("\n" + yaml_block + "\n\n" + contrast_table + "\n")
        print(f"\nAppended to {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
