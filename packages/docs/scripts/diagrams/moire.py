"""
Principles — two lattices, one small angle.

The settled rules are not interesting one at a time; what they produce together
is. Two identical triangular lattices laid over each other at a few degrees
produce a pattern neither lattice contains — the moire is entirely a property
of the relationship, which is the claim the principles page makes about the
rules it lists.

Both lattices are the same generated points. Only the rotation differs.
"""

from __future__ import annotations

import math

from _canvas import ACCENT, CX, CY, INK, Canvas, emit, fmt

PITCH = 13.0
RADIUS = 86.0
# Just past the angle where the beat period leaves the canvas.
SKEW = math.radians(7.5)


def lattice(colour: str, opacity: float, length: float) -> str:
    """A triangular lattice: rows offset by half a pitch, spaced by pitch*√3/2."""
    row_height = PITCH * math.sqrt(3) / 2
    rows = int(RADIUS / row_height) + 1
    dots: list[str] = []

    for row in range(-rows, rows + 1):
        y = CY + row * row_height
        offset = (PITCH / 2) if row % 2 else 0.0
        columns = int(RADIUS / PITCH) + 2
        for column in range(-columns, columns + 1):
            x = CX + column * PITCH + offset
            if math.hypot(x - CX, y - CY) > RADIUS:
                continue
            # A stroke rather than a dot: the beat between two lattices is
            # far more legible when the elements have an axis to disagree on.
            dots.append(
                f'M{fmt(x)},{fmt(y - length / 2)}L{fmt(x)},{fmt(y + length / 2)}'
            )
    return (
        f'<path d="{"".join(dots)}" fill="none" stroke="{colour}" '
        f'stroke-width="1" stroke-opacity="{fmt(opacity)}"/>'
    )


def build() -> Canvas:
    canvas = Canvas("moire")

    canvas.group(lattice(INK, 0.32, 5.2), cls="la")
    canvas.group(lattice(ACCENT, 0.45, 5.2), cls="lb")

    # One lattice holds still while the other drifts through a few degrees and
    # back. The beat sweeps across the field; neither lattice ever moves far.
    canvas.css(
        f".la{{transform-origin:{fmt(CX)}px {fmt(CY)}px;transform:rotate({fmt(-math.degrees(SKEW) / 2)}deg)}}"
        f".lb{{transform-origin:{fmt(CX)}px {fmt(CY)}px;"
        f"animation:moire 24s ease-in-out infinite}}"
        f"@keyframes moire{{0%,100%{{transform:rotate({fmt(math.degrees(SKEW) / 2)}deg)}}"
        f"50%{{transform:rotate({fmt(math.degrees(SKEW) * 1.6)}deg)}}}}"
    )

    return canvas


if __name__ == "__main__":
    emit(build())
