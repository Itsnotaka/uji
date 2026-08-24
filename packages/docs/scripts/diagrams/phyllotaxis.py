"""
Tools — a seed head.

`@uji-ai/core` has no tool registry. Tools are plain objects in an array, and the
array is handed to the loop at the composition site. A sunflower head packs its
seeds the same way: no seed is told where to go, and the arrangement falls out
of one rule applied to every seed in turn.

The rule is Vogel's: the nth seed sits at radius c*sqrt(n) and angle n*137.507
degrees, the golden angle. Seven seeds are marked — the seven built-in coding
tools — and they are marked by index, so which ones light up is a consequence
of the packing rather than a choice about where to put a highlight.
"""

from __future__ import annotations

import math

from _canvas import ACCENT, CX, CY, INK, Canvas, emit, point

GOLDEN_ANGLE = math.radians(137.507764)
SEEDS = 420
SCALE = 4.1
# The seven built-ins. Consecutive indices sit a golden angle apart, so
# stepping by an odd stride spreads them over the head instead of stacking
# them along one parastichy.
MARKED = tuple(24 + index * 57 for index in range(7))


def build() -> Canvas:
    canvas = Canvas("phyllotaxis")

    body: list[str] = []
    for n in range(1, SEEDS + 1):
        radius = SCALE * math.sqrt(n)
        angle = n * GOLDEN_ANGLE
        x = CX + radius * math.cos(angle)
        y = CY + radius * math.sin(angle) * 0.92

        # Each seed is a stroke laid along its own radius, growing with the
        # square root the packing already uses. Dots would say "point"; these
        # say "scale", which is the thing the golden angle is arranging.
        length = 2.2 + 5.6 * (n / SEEDS)
        marked = n in MARKED
        half = length / 2
        cos, sin = math.cos(angle), math.sin(angle) * 0.92
        body.append(
            f'<path d="M{point(x - half * cos, y - half * sin)}'
            f'L{point(x + half * cos, y + half * sin)}" '
            f'stroke="{ACCENT if marked else INK}" stroke-width="{1.8 if marked else 1}" '
            f'stroke-opacity="{0.95 if marked else 0.16 + 0.26 * (n / SEEDS)}"/>'
        )

    canvas.group("".join(body), cls="head")
    # A slow turn: the packing is the point, not the motion.
    canvas.spin("head", seconds=120, cx=CX, cy=CY)

    return canvas


if __name__ == "__main__":
    emit(build())
