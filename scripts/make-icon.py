"""Draw the dsh-ego-browser icon as a 512x512 PNG with PIL.

icon.svg is the canonical small-size artwork; this script redraws the same
geometry at tile size, because the plugin index only accepts raster icons
(png/jpg/webp) and the storefront card draws them at about 96px.
"""
from PIL import Image, ImageDraw

S = 512
SS = 4                     # supersample factor for smooth edges
W = S * SS
BLUE = (76, 141, 255)
PURPLE = (123, 97, 255)
WHITE = (255, 255, 255)

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# The SVG uses a 36x36 box; keep the same proportions.
scale = W / 36.0


def px(v):
    return v * scale


def stroke(v):
    return max(1, int(round(px(v))))


# Browser window: rect x4 y6 w21 h16.5 r3.6
d.rounded_rectangle(
    [px(4), px(6), px(25), px(22.5)],
    radius=px(3.6), outline=BLUE, width=stroke(2.3),
)

# Title-bar divider at y=11.9
d.line([px(4.6), px(11.9), px(24.4), px(11.9)], fill=BLUE, width=stroke(2.3))

# Two traffic dots
for cx in (8.6, 12.6):
    r = px(1.15)
    d.ellipse([px(cx) - r, px(8.9) - r, px(cx) + r, px(8.9) + r], fill=BLUE)

# Pointer stem
d.line([px(23.6), px(23.6), px(30.2), px(30.2)], fill=PURPLE, width=stroke(2.4))

# Arrowhead as an L (two strokes, round caps and joins)
d.line([px(31.4), px(26.4), px(31.4), px(31.4)], fill=PURPLE, width=stroke(2.4))
d.line([px(31.4), px(31.4), px(26.4), px(31.4)], fill=PURPLE, width=stroke(2.4))

tile = Image.new("RGBA", (W, W), WHITE + (255,))
tile.alpha_composite(img)
tile.resize((S, S), Image.LANCZOS).save("assets/icon-180.png")
print("wrote assets/icon-180.png")
