"""Renders the COMBAT LOG task bar icon.

The frame is deliberately the same hexagon in the same gold as the CraftQueue
and RaidReviewOverlay buttons, so the three read as one family in the bar.
Only the motif inside differs: a hit marker, four ticks angled at the centre.
That keeps it distinct from the work list CraftQueue uses and the rising bars
RaidReviewOverlay uses, and it says "recorded hits" without a word of text.

The constraints below were learned in the game rather than in a preview, and
each is a number here:

1. Hexagon, not circle. The bar draws an icon at roughly 24 px, and a curve
   that size is all antialiasing; flat edges land on pixel boundaries.
2. The colour is baked in. The button's animator writes Image.color every
   frame, so a white glyph tinted from code loses and shows up plain white.
3. Small beats large. The sprite is drawn near its real size instead of being
   downsampled from 128 px, and the loader builds a mip chain on top.
4. The ticks are drawn as polygons, not as lines with a width. A wide
   ImageDraw line puts a square cap on each end, which at this angle reads as
   a notch; explicit quads give square ends perpendicular to the tick.

Run:  python tools/build-icon.py
Out:  assets/task-bar-icon.png  (64x64 RGBA, in the bar's own gold)
"""

import math
import os
from PIL import Image, ImageDraw

SIZE = 64            # close to the ~24-40 px the bar actually shows
SUPERSAMPLE = 16     # drawn 16x and downscaled: antialiasing without a vector library
GOLD = (194, 174, 110, 255)   # the muted gold the other mod buttons use

W = SIZE * SUPERSAMPLE
STROKE = 0.085 * W   # hexagon wall, ~8.5% of the width; thinner vanishes at 24 px
INSET = 0.04         # gap between canvas edge and the hexagon's outer points

# The hit marker: four ticks on the diagonals, with the centre left open.
# Kept inside roughly the same radius the other two motifs occupy, so the
# three buttons carry the same visual weight. Reaching further looked cramped
# against the hexagon wall at 24 px; thicker or shorter ticks merged into
# blobs at that size.
TICK_INNER = 0.09    # gap from the centre, as a fraction of the canvas
TICK_OUTER = 0.22    # where the tick ends
TICK_HALF_WIDTH = 0.035


def hexagon(radius, flat_top=False):
    """Six points around the centre. Pointy-top by default, like the game's."""
    centre = W / 2.0
    start = 0 if flat_top else -math.pi / 2
    return [
        (centre + radius * math.cos(start + i * math.pi / 3),
         centre + radius * math.sin(start + i * math.pi / 3))
        for i in range(6)
    ]


def draw_hexagon_outline(draw, flat_top=False):
    """Filled hexagon with a smaller one punched out of it.

    Drawing the outline as a closed line instead leaves a visible nib where the
    stroke starts and ends, and thickened joins overshoot the points. Punching
    the middle out gives exact corners: ImageDraw writes RGBA values straight
    into the buffer, so filling with a transparent colour clears those pixels
    rather than blending onto them.
    """
    outer = (0.5 - INSET) * W
    # Uniform wall thickness is measured edge to edge, not point to point: the
    # distance from the centre to an edge is radius * cos(30 deg).
    inner = outer - STROKE / math.cos(math.pi / 6)
    draw.polygon(hexagon(outer, flat_top), fill=GOLD)
    draw.polygon(hexagon(inner, flat_top), fill=(0, 0, 0, 0))


def draw_hit_marker(draw):
    """Four ticks pointing at a centre they never reach.

    Each tick is a quad rather than a wide line, so both ends are cut square
    across the tick instead of being capped past its length.
    """
    centre = W / 2.0
    half = TICK_HALF_WIDTH * W
    for step in range(4):
        angle = math.pi / 4 + step * math.pi / 2
        along = (math.cos(angle), math.sin(angle))
        across = (-along[1] * half, along[0] * half)
        near = (centre + along[0] * TICK_INNER * W, centre + along[1] * TICK_INNER * W)
        far = (centre + along[0] * TICK_OUTER * W, centre + along[1] * TICK_OUTER * W)
        draw.polygon([
            (near[0] + across[0], near[1] + across[1]),
            (far[0] + across[0], far[1] + across[1]),
            (far[0] - across[0], far[1] - across[1]),
            (near[0] - across[0], near[1] - across[1]),
        ], fill=GOLD)


def render(flat_top=False):
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw_hexagon_outline(draw, flat_top)
    draw_hit_marker(draw)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    icon = render()

    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(here, "..", "assets", "task-bar-icon.png")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    icon.save(target, "PNG", optimize=True)

    print("wrote %s (%dx%d, %d bytes)" % (
        os.path.normpath(target), icon.width, icon.height, os.path.getsize(target)))


if __name__ == "__main__":
    main()
