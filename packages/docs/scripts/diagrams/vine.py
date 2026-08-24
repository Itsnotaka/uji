"""
Recipes — a vine.

Every recipe on that page is lifted from code that already runs in the repo, so
none of them starts from nothing: each one branches off a stem that was already
there. An L-system says exactly that. One axiom, one production rule, applied
four times, and the whole plant is implied by the rule rather than drawn.

Branch angle and the length ratio between a parent and its children are the
only free parameters; everything else is the rule unfolding.
"""

from __future__ import annotations

import math

from _canvas import AMBER, CX, GREEN, Canvas, emit, fmt

DEPTH = 6
BRANCH_ANGLE = math.radians(23)
# Slightly under 1/golden: children stay clear of their parent's siblings.
RATIO = 0.74
ROOT_LENGTH = 40.0
BASE = (CX, 168.0)


def grow(
    canvas: Canvas,
    origin: tuple[float, float],
    angle: float,
    length: float,
    depth: int,
    index: list[int],
) -> None:
    if depth == 0 or length < 1.6:
        return

    end = (origin[0] + length * math.cos(angle), origin[1] + length * math.sin(angle))
    order = DEPTH - depth  # 0 at the trunk
    cls = f"b{index[0]}"
    index[0] += 1

    canvas.path(
        f"M{fmt(origin[0])},{fmt(origin[1])}L{fmt(end[0])},{fmt(end[1])}",
        stroke=GREEN,
        width=max(0.5, 1.9 - order * 0.22),
        opacity=0.28 + 0.06 * order,
        cls=cls,
    )
    # A segment is drawn only after its parent finished, so the plant grows
    # outward from the root rather than appearing all at once.
    canvas.draw_on(cls, length=length + 1, seconds=11, delay=order * 0.42)

    # The trunk keeps a little of its own direction; branches take the rest.
    # Alternating the bias is what gives the plant its sway.
    sway = math.sin(order * 1.7) * math.radians(6)
    grow(canvas, end, angle - BRANCH_ANGLE + sway, length * RATIO, depth - 1, index)
    grow(canvas, end, angle + BRANCH_ANGLE + sway, length * RATIO * 0.92, depth - 1, index)



def build() -> Canvas:
    canvas = Canvas("vine")

    canvas.path(
        f"M{fmt(CX - 66)},{fmt(BASE[1])}L{fmt(CX + 66)},{fmt(BASE[1])}",
        stroke=AMBER,
        opacity=0.26,
        dash="1 4",
    )

    grow(canvas, BASE, -math.pi / 2, ROOT_LENGTH, DEPTH, [0])
    return canvas


if __name__ == "__main__":
    emit(build())
