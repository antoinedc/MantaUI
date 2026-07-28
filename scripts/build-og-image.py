#!/usr/bin/env python3
"""scripts/build-og-image.py — regenerate website/og.png (1200x630).

The OG image is the single social-share thumbnail the homepage, every page's
<meta property="og:image">, and every Twitter Card point at. One file, used
everywhere.

Idempotent: re-running with the same inputs produces a byte-identical PNG.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = ROOT / "website" / "og.png"

WIDTH = 1200
HEIGHT = 630


def pick_font(size: int) -> ImageFont.FreeTypeFont:
    """Best-effort font lookup — try a few common families."""
    for name in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ):
        if os.path.isfile(name):
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def main() -> int:
    bg = hex_to_rgb("#0B1020")
    panel = hex_to_rgb("#111A36")
    border = hex_to_rgb("#243059")
    text_primary = hex_to_rgb("#F8FAFC")
    text_secondary = hex_to_rgb("#A8B3CF")
    accent_a = hex_to_rgb("#2E6BFF")
    accent_b = hex_to_rgb("#49D7F5")

    img = Image.new("RGB", (WIDTH, HEIGHT), bg)
    draw = ImageDraw.Draw(img)

    # Top-left brand mark.
    brand = pick_font(34)
    draw.text((64, 56), "Manta", fill=text_primary, font=brand)
    brand_box = draw.textbbox((0, 0), "Manta", font=brand)
    brand_w = brand_box[2] - brand_box[0]
    draw.text((64 + brand_w + 6, 56), "UI", fill=accent_b, font=brand)

    # Hero title — two lines.
    title_font = pick_font(76)
    line1 = "Your agents keep working"
    line2 = "after you close the laptop."
    line1_box = draw.textbbox((0, 0), line1, font=title_font)
    line2_box = draw.textbbox((0, 0), line2, font=title_font)
    line1_w = line1_box[2] - line1_box[0]
    line2_w = line2_box[2] - line2_box[0]
    title_x = (WIDTH - max(line1_w, line2_w)) // 2
    draw.text((title_x, 200), line1, fill=text_primary, font=title_font)
    draw.text((title_x, 200 + 90), line2, fill=text_primary, font=title_font)

    # Subtitle.
    sub_font = pick_font(30)
    sub = "Self-hosted Claude Code and opencode on your own box."
    sub_box = draw.textbbox((0, 0), sub, font=sub_font)
    sub_w = sub_box[2] - sub_box[0]
    draw.text(
        ((WIDTH - sub_w) // 2, 410),
        sub,
        fill=text_secondary,
        font=sub_font,
    )

    # Bottom card.
    card_y = 500
    card_h = 80
    card_margin = 64
    card_w = WIDTH - 2 * card_margin
    draw.rounded_rectangle(
        [card_margin, card_y, card_margin + card_w, card_y + card_h],
        radius=14,
        fill=panel,
        outline=border,
        width=1,
    )
    cmd_font = pick_font(28)
    draw.text(
        (card_margin + 28, card_y + (card_h - 30) // 2),
        "$",
        fill=accent_b,
        font=cmd_font,
    )
    prompt_w = draw.textbbox((0, 0), "$", font=cmd_font)
    draw.text(
        (card_margin + 28 + (prompt_w[2] - prompt_w[0]) + 12, card_y + (card_h - 30) // 2),
        "curl -fsSL mantaui.com/install.sh | bash",
        fill=text_primary,
        font=cmd_font,
    )

    img.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
