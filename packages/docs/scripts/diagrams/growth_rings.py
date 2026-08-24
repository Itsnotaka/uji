"""
Session storage — growth rings.

A session log is append-only: nothing already written is revised, and the shape
of what came before is still legible in what is there now. A trunk keeps its
record the same way, so the figure is a cross-section. Each ring is a closed
curve whose radius is a small sum of sines, which is enough to make rings that
vary the way real ones do without any of them repeating.

One radial line crosses every ring: the `seq` that orders the whole log.
"""

from __future__ import annotations

import math
import random

from _canvas import ACCENT, AMBER, CX, CY, INK, Canvas, emit, fmt, polyline_d

RING_COUNT = 15
PITH_R = 5.0
OUTER_R = 74.0


def ring(radius: float, spacing: float, rng: random.Random) -> list[tuple[float, float]]:
    """A closed curve: the mean radius plus three low harmonics.

    Amplitude is bounded by the gap to the next ring rather than by the radius.
    Rings that cross would say the log was rewritten, which is the one thing a
    session log never does.
    """
    limit = spacing * 0.34
    harmonics = [
        (1, limit * 0.55, rng.uniform(0, math.tau)),
        (2, limit * 0.28, rng.uniform(0, math.tau)),
        (5, limit * 0.17, rng.uniform(0, math.tau)),
    ]
    points: list[tuple[float, float]] = []
    steps = 120
    for index in range(steps):
        theta = math.tau * index / steps
        offset = sum(amp * math.sin(freq * theta + phase) for freq, amp, phase in harmonics)
        r = radius + offset
        points.append((CX + r * math.cos(theta), CY + r * math.sin(theta) * 0.9))
    return points


def build() -> Canvas:
    canvas = Canvas("growth-rings")
    rng = random.Random(0x4A554E45)  # "UJI"

    # Rings crowd toward the bark: growth slows as the trunk widens, so the
    # spacing follows a square root rather than a constant step.
    def radius_at(step: int) -> float:
        # Growth slows as the trunk widens, so the rings crowd toward the bark.
        return PITH_R + (OUTER_R - PITH_R) * math.sqrt(step / RING_COUNT)

    for index in range(RING_COUNT):
        t = (index + 1) / RING_COUNT
        radius = radius_at(index + 1)
        spacing = radius - radius_at(index)
        latest = index == RING_COUNT - 1
        cls = f"r{index}"

        canvas.path(
            polyline_d(ring(radius, spacing, rng), close=True),
            stroke=ACCENT if latest else INK,
            width=1.1 if latest else 1.0,
            opacity=0.85 if latest else 0.14 + 0.22 * t,
            cls=cls,
        )
        # Each ring arrives after the one inside it and stays. The cycle is long
        # enough that the figure reads as still until you look twice.
        canvas.css(
            f".{cls}{{animation:ring-in 18s var(--ease-uji, ease-out) {fmt(index * 0.18)}s infinite}}"
        )

    canvas.css(
        "@keyframes ring-in{0%{opacity:0;transform:scale(.94)}"
        "14%,92%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.02)}}"
        ", ".join(f".r{index}" for index in range(RING_COUNT))
        + f"{{transform-origin:{fmt(CX)}px {fmt(CY)}px}}"
    )

    # The pith, and the one radial that orders every ring it crosses.
    canvas.path(
        f"M{fmt(CX - 4)},{fmt(CY)}L{fmt(CX + 4)},{fmt(CY)}"
        f"M{fmt(CX)},{fmt(CY - 4)}L{fmt(CX)},{fmt(CY + 4)}",
        stroke=AMBER,
        opacity=0.75,
    )
    canvas.path(
        f"M{fmt(CX)},{fmt(CY)}L{fmt(CX + OUTER_R * 0.99)},{fmt(CY - OUTER_R * 0.34)}",
        stroke=AMBER,
        opacity=0.45,
        dash="2 3",
    )

    return canvas


if __name__ == "__main__":
    emit(build())
