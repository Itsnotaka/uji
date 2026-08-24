"""
Architecture — one direction, four shells.

Client, harness, loop, provider. Each shell holds a body that travels one way
around it, and the shells never exchange bodies: a client talks to a harness,
the harness drives the loop, the loop reaches a provider through a function it
was handed, and nothing calls back up.

The inner shells run faster, as they would under a real central force: the
period goes as the radius to the three-halves, so the ratios in the figure are
Kepler's rather than picked.
"""

from __future__ import annotations

import math

from _canvas import ACCENT, CX, CY, CYAN, INK, VIOLET, Canvas, emit, fmt

SHELLS = [
    {"r": 22.0, "colour": ACCENT, "label": "provider"},
    {"r": 40.0, "colour": CYAN, "label": "loop"},
    {"r": 58.0, "colour": VIOLET, "label": "harness"},
    {"r": 76.0, "colour": INK, "label": "client"},
]

# Foreshortening: the page is flat, the system is not.
SQUASH = 0.46
BASE_PERIOD = 5.0


def ellipse_d(rx: float, ry: float) -> str:
    return (
        f"M{fmt(CX - rx)},{fmt(CY)}"
        f"a{fmt(rx)},{fmt(ry)} 0 1,0 {fmt(rx * 2)},0"
        f"a{fmt(rx)},{fmt(ry)} 0 1,0 {fmt(-rx * 2)},0"
    )


def build() -> Canvas:
    canvas = Canvas("orbits")

    for index, shell in enumerate(SHELLS):
        radius = float(shell["r"])
        colour = str(shell["colour"])
        outermost = index == len(SHELLS) - 1

        canvas.path(
            ellipse_d(radius, radius * SQUASH),
            stroke=colour,
            opacity=0.3 if not outermost else 0.22,
            # The client shell is dashed: it is the one seam Uji names but has
            # not written a wire for yet.
            dash="3 4" if outermost else None,
        )

        period = BASE_PERIOD * (radius / SHELLS[0]["r"]) ** 1.5
        cls = f"o{index}"
        # The body is a tick across its own shell rather than a dot: the
        # figure is made of lines, and a line can show which shell it is on.
        tick = 11.0
        canvas.group(
            f'<path d="M{fmt(CX + radius - tick / 2)},{fmt(CY)}'
            f'L{fmt(CX + radius + tick / 2)},{fmt(CY)}" fill="none" '
            f'stroke="{colour}" stroke-width="{fmt(1.6 if not outermost else 1.2)}" '
            f'stroke-opacity="{fmt(0.9 if not outermost else 0.55)}"/>',
            cls=cls,
        )
        # The squash is applied around the travelling body, not to it, so the
        # dot keeps its size while its path stays an ellipse.
        canvas.css(
            f".{cls}{{transform-origin:{fmt(CX)}px {fmt(CY)}px;"
            f"transform:scaleY({SQUASH});"
            f"animation:{cls}-orbit {fmt(period)}s linear infinite}}"
            f"@keyframes {cls}-orbit{{to{{transform:scaleY({SQUASH}) rotate(360deg)}}}}"
        )

    # The centre, as a crosshair.
    canvas.path(
        f"M{fmt(CX - 5)},{fmt(CY)}L{fmt(CX + 5)},{fmt(CY)}"
        f"M{fmt(CX)},{fmt(CY - 5)}L{fmt(CX)},{fmt(CY + 5)}",
        stroke=ACCENT,
        opacity=0.8,
    )
    return canvas


if __name__ == "__main__":
    emit(build())
