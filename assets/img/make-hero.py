"""Generate the hero background: soft out-of-focus sky over a meadow.

Matches the palette already used by .hero--sky so the page keeps its colour
scheme. Everything is synthesised here, so the output is an original image with
no licensing attached to it.
"""
from PIL import Image, ImageChops, ImageFilter
import sys

W, H = 2400, 1500
HORIZON = 0.73  # sky occupies the top 73%, meadow the rest


def vgrad(size, stops):
    """Vertical gradient. stops = [(position 0-1, (r,g,b)), ...]"""
    w, h = size
    col = Image.new("RGB", (1, h))
    px = col.load()
    stops = sorted(stops)
    for y in range(h):
        t = y / (h - 1)
        for i in range(len(stops) - 1):
            p0, c0 = stops[i]
            p1, c1 = stops[i + 1]
            if p0 <= t <= p1:
                k = 0 if p1 == p0 else (t - p0) / (p1 - p0)
                k = k * k * (3 - 2 * k)  # smoothstep, avoids gradient banding
                px[0, y] = tuple(round(a + (b - a) * k) for a, b in zip(c0, c1))
                break
        else:
            px[0, y] = stops[-1][1] if t > stops[-1][0] else stops[0][1]
    return col.resize((w, h), Image.BILINEAR)


def noise(size, scale, blur, seed_shift=0):
    """Blurred value noise: coarse random field scaled up and smoothed."""
    w, h = size
    small = (max(2, w // scale), max(2, h // scale))
    n = Image.effect_noise(small, 48 + seed_shift)
    return n.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(blur))


def octaves(size, specs):
    """Weighted sum of noise octaves, returned as an L-mode image."""
    acc = Image.new("L", size, 0)
    for scale, blur, weight, shift in specs:
        layer = noise(size, scale, blur, shift)
        acc = ImageChops.add(acc, layer.point(lambda v, w=weight: int(v * w)))
    return acc


def curve(img, gamma, lo=0, hi=255):
    """Contrast curve — turns flat fog into shapes with edges."""
    return img.point(
        lambda v: max(0, min(255, int(lo + (hi - lo) * ((v / 255) ** gamma))))
    )


def ramp(size, a, b, v0=0, v1=255):
    """Vertical mask ramping v0 -> v1 between heights a and b (fractions)."""
    return vgrad(size, [(0.0, (v0,) * 3), (a, (v0,) * 3), (b, (v1,) * 3), (1.0, (v1,) * 3)]).convert("L")


# ---------------------------------------------------------------- the sky
sky = vgrad((W, H), [
    (0.00, (0x93, 0xB8, 0xE2)),
    (0.16, (0xAC, 0xC9, 0xE9)),
    (0.34, (0xC6, 0xDB, 0xEE)),
    (0.52, (0xDC, 0xE7, 0xF0)),
    (0.64, (0xE9, 0xEE, 0xEC)),
    (0.71, (0xF2, 0xF1, 0xE6)),
    (0.73, (0xF3, 0xF0, 0xE2)),
    (1.00, (0xEE, 0xEE, 0xDD)),
])

# Cloud banks: three octaves, contrast-curved into shapes, then kept to the
# upper sky and faded out well before the horizon.
clouds = octaves((W, H), [
    (260, 90, 0.62, 0),
    (120, 46, 0.26, 17),
    (56, 22, 0.12, 41),
])
clouds = curve(clouds, gamma=1.35, lo=0, hi=255)
clouds = clouds.filter(ImageFilter.GaussianBlur(30))

# Only in the sky, strongest around a third of the way down.
band = vgrad((W, H), [
    (0.00, (90,) * 3),
    (0.16, (215,) * 3),
    (0.36, (255,) * 3),
    (0.56, (170,) * 3),
    (0.68, (0,) * 3),
    (1.00, (0,) * 3),
]).convert("L")
clouds = ImageChops.multiply(clouds, band)

sky = Image.composite(Image.new("RGB", (W, H), (255, 255, 255)), sky, clouds)

# Warm haze sitting on the horizon line.
haze = vgrad((W, H), [
    (0.00, (0,) * 3),
    (0.56, (0,) * 3),
    (0.71, (210,) * 3),
    (0.74, (150,) * 3),
    (0.82, (0,) * 3),
    (1.00, (0,) * 3),
]).convert("L")
sky = Image.composite(Image.new("RGB", (W, H), (255, 252, 244)), sky, haze)

# -------------------------------------------------------------- the meadow
# Sunlit patches at a large scale, blade streaks at a small one; the two
# together drive the colour so the field has tone instead of being flat.
patches = octaves((W, H), [
    (300, 70, 0.70, 3),
    (110, 30, 0.30, 23),
])
patches = curve(patches, gamma=1.1, lo=0, hi=255)

streaks = noise((W, H), 4, 0, 7).resize((W // 4, H // 30), Image.BILINEAR)
streaks = streaks.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(16))

field = ImageChops.add(
    patches.point(lambda v: int(v * 0.68)),
    streaks.point(lambda v: int(v * 0.32)),
)
field = curve(field, gamma=1.0, lo=28, hi=232)

light = Image.new("RGB", (W, H), (0xB2, 0xC2, 0x70))   # sunlit blades
dark = Image.new("RGB", (W, H), (0x50, 0x69, 0x30))    # shaded depth
meadow = Image.composite(light, dark, field)

# Sit it under a vertical ramp so the far field stays paler than the near.
meadow = Image.composite(
    meadow,
    ImageChops.blend(meadow, Image.new("RGB", (W, H), (0xC6, 0xCE, 0x9C)), 0.55),
    ramp((W, H), HORIZON - 0.02, 0.98, 0, 255),
)
meadow = meadow.filter(ImageFilter.GaussianBlur(11))

# Feather the two together across the horizon.
blend = ramp((W, H), HORIZON - 0.10, HORIZON + 0.12)
img = Image.composite(meadow, sky, blend)

# ---------------------------------------------------------------- finishing
# Gentle corner falloff so the frame does not read as flat.
vig = Image.new("L", (W, H), 0)
vig.paste(255, (int(W * 0.06), int(H * 0.05), int(W * 0.94), int(H * 0.95)))
vig = vig.filter(ImageFilter.GaussianBlur(230))
img = Image.composite(img, ImageChops.multiply(img, Image.new("L", (W, H), 243).convert("L").convert("RGB")), vig)

# Fine grain — keeps large flat gradients from banding on cheap panels.
grain = Image.effect_noise((W, H), 7).filter(ImageFilter.GaussianBlur(0.4))
img = Image.blend(img, ImageChops.overlay(img, Image.merge("RGB", (grain,) * 3)), 0.05)

out = sys.argv[1] if len(sys.argv) > 1 else "hero.webp"
img.save(out, "WEBP", quality=80, method=6)
img.resize((1200, 750), Image.LANCZOS).save(
    out.replace(".webp", "-sm.webp"), "WEBP", quality=80, method=6
)
print("wrote", out)
