"""
Stream function — the only model boundary in the core.

`StreamFn` is a function the loop is handed. Tokens arrive through it in order
and the loop never learns what is on the other side. The figure is that
channel: a band of sine curves sharing one axis, travelling left to right
between two marks that stand for the boundary.

Every lane is the same wave offset in phase, so the band shears rather than
wobbles — which is what makes it read as one flow instead of seven lines. Each
lane is drawn a full wavelength wider than the frame and translated by exactly
one wavelength, so the motion has no seam and nothing ever visibly restarts.
"""

from __future__ import annotations

import math

from _canvas import CYAN, INK, Canvas, emit, fmt

LEFT = 30.0
RIGHT = 290.0
CENTRE_Y = 90.0
LANES = 7

# Two crests inside the frame, so the band has a shape rather than a slope.
WAVELENGTH = (RIGHT - LEFT) / 2
AMPLITUDE = 26.0
PERIOD = 7.0


def wave(phase: float, amplitude: float) -> str:
    """One lane, drawn a wavelength past each edge so the loop cannot show."""
    start = LEFT - WAVELENGTH
    end = RIGHT + WAVELENGTH
    steps = 120
    points: list[str] = []
    for index in range(steps + 1):
        x = start + (end - start) * index / steps
        y = CENTRE_Y + amplitude * math.sin((x - LEFT) / WAVELENGTH * math.tau + phase)
        points.append(f"{'M' if index == 0 else 'L'}{fmt(x)},{fmt(y)}")
    return "".join(points)


def build() -> Canvas:
    canvas = Canvas("stream")

    for lane in range(LANES):
        # Lanes are symmetric about the centre line, so the band has an axis.
        offset = lane - (LANES - 1) / 2
        centre_lane = abs(offset) < 0.5
        cls = f"w{lane}"

        canvas.path(
            wave(offset * 0.5, AMPLITUDE - abs(offset) * 2.6),
            stroke=CYAN if centre_lane else INK,
            width=1.2 if centre_lane else 1.0,
            opacity=0.7 if centre_lane else 0.18,
            cls=cls,
        )
        canvas.css(
            f".{cls}{{animation:drift {fmt(PERIOD)}s linear infinite}}"
        )

    canvas.css(
        f"@keyframes drift{{from{{transform:translateX(0)}}"
        f"to{{transform:translateX({fmt(WAVELENGTH)}px)}}}}"
    )

    # The boundary itself: the loop's only reach past its own edge.
    for x in (LEFT, RIGHT):
        canvas.path(
            f"M{fmt(x)},{fmt(CENTRE_Y - 44)}L{fmt(x)},{fmt(CENTRE_Y + 44)}",
            stroke=INK,
            opacity=0.3,
        )

    return canvas


if __name__ == "__main__":
    emit(build())
