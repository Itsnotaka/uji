"""
Quickstart — germination.

The page takes a reader from a fresh clone to a streaming run, so the figure is
the shortest complete thing that grows: a seed, a stem, and the first pair of
leaves. It draws itself on and starts again, because that is what a quickstart
is for.

The stem is a cubic whose control points lean with height; each leaf is a lens
built from two arcs meeting at a point, sized from its position on the stem so
the lower pair is always the larger.
"""

from __future__ import annotations

import math

from _canvas import AMBER, CX, GREEN, Canvas, emit, fmt

BASE_Y = 156.0
TIP_Y = 30.0


def stem_point(t: float) -> tuple[float, float]:
    """Cubic Bezier, evaluated so leaves can be hung at a known t."""
    p0 = (CX - 2, BASE_Y)
    p1 = (CX - 20, BASE_Y - 44)
    p2 = (CX + 18, TIP_Y + 46)
    p3 = (CX + 2, TIP_Y)
    u = 1 - t
    return (
        u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1],
    )


def stem_tangent(t: float) -> float:
    ax, ay = stem_point(max(t - 0.01, 0))
    bx, by = stem_point(min(t + 0.01, 1))
    return math.atan2(by - ay, bx - ax)


def leaf(t: float, side: int, length: float) -> str:
    """A lens: two symmetric quadratic arcs from the stem out to a point."""
    ox, oy = stem_point(t)
    # Leaves stand off the stem's tangent, tilted up toward the light.
    angle = stem_tangent(t) + side * math.radians(66)
    tip = (ox + length * math.cos(angle), oy + length * math.sin(angle))
    normal = angle + math.pi / 2
    bulge = length * 0.4
    c1 = (
        (ox + tip[0]) / 2 + bulge * math.cos(normal),
        (oy + tip[1]) / 2 + bulge * math.sin(normal),
    )
    c2 = (
        (ox + tip[0]) / 2 - bulge * math.cos(normal),
        (oy + tip[1]) / 2 - bulge * math.sin(normal),
    )
    return (
        f"M{fmt(ox)},{fmt(oy)}Q{fmt(c1[0])},{fmt(c1[1])} {fmt(tip[0])},{fmt(tip[1])}"
        f"Q{fmt(c2[0])},{fmt(c2[1])} {fmt(ox)},{fmt(oy)}"
        # The midrib: one line from base to tip.
        f"M{fmt(ox)},{fmt(oy)}L{fmt(tip[0])},{fmt(tip[1])}"
    )


def build() -> Canvas:
    canvas = Canvas("sprout")

    # Soil line, and the seed still sitting on it.
    canvas.path(
        f"M{fmt(CX - 62)},{fmt(BASE_Y)}L{fmt(CX + 62)},{fmt(BASE_Y)}",
        stroke=AMBER,
        opacity=0.3,
        dash="1 4",
    )

    stem = "".join(
        f"{'M' if index == 0 else 'L'}{fmt(x)},{fmt(y)}"
        for index, (x, y) in enumerate(stem_point(i / 48) for i in range(49))
    )
    canvas.path(stem, stroke=GREEN, width=1.4, opacity=0.75, cls="stem")
    canvas.draw_on("stem", length=150, seconds=9)

    # Three pairs, largest at the bottom, each unfurling after the stem passes.
    for index, (t, length) in enumerate(((0.22, 38), (0.44, 32), (0.64, 25), (0.82, 17))):
        for side in (-1, 1):
            cls = f"lf{index}{'a' if side < 0 else 'b'}"
            canvas.path(leaf(t, side, length), stroke=GREEN, width=1, opacity=0.6, cls=cls)
            canvas.draw_on(cls, length=length * 3.2, seconds=9, delay=t * 3.4)

    return canvas


if __name__ == "__main__":
    emit(build())
