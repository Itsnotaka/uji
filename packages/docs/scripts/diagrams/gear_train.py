"""
Agent loop — a train of wheels.

The loop is the one part of Uji that has no state of its own: it turns because
something else turns it, and the ratio between the wheels is fixed by their
tooth counts, not by anything either wheel decides.

Drawn in the same abstraction as the blog header — a wheel is a ring of radial
lines and nothing else. Tooth counts come first and radii follow from them, so
every wheel shares one circular pitch and any two of them mesh. Sitting at the
sum of their pitch radii puts each wheel's lines exactly halfway into its
neighbour's band, and each wheel's period is its own tooth count, so the small
wheel visibly turns faster because it has fewer teeth.
"""

from __future__ import annotations

import math

from _canvas import ACCENT, CY, INK, VIOLET, Canvas, emit, radial_wheel

# Arc length between lines at the pitch circle: the only density control.
PITCH = 14.6
# One band for the whole figure, or the halfway rule cannot hold.
BAND = 15.0

WHEELS = [
    {"teeth": 22, "colour": INK, "opacity": 0.4, "reverse": False},
    {"teeth": 13, "colour": ACCENT, "opacity": 0.85, "reverse": True},
    {"teeth": 18, "colour": VIOLET, "opacity": 0.55, "reverse": False},
]

# One tooth-passing time for the whole train, so the periods fall out of the
# tooth counts rather than being chosen per wheel.
BEAT = 0.42


def pitch_radius(teeth: int) -> float:
    return teeth * PITCH / math.tau


def build() -> Canvas:
    canvas = Canvas("gear-train")

    radii = [pitch_radius(int(wheel["teeth"])) for wheel in WHEELS]
    span = sum(radii) * 2
    x = (320 - span) / 2 + radii[0]
    centres: list[float] = []
    for index, radius in enumerate(radii):
        if index:
            x += radii[index - 1] + radius
        centres.append(x)

    for index, wheel in enumerate(WHEELS):
        teeth = int(wheel["teeth"])
        cx = centres[index]
        radius = radii[index]
        step = math.tau / teeth
        # A driving wheel offers a line down the line of centres; the wheel it
        # drives offers the gap that receives it.
        phase = 0.0 if index % 2 == 0 else step / 2
        cls = f"g{index}"

        canvas.group(
            f'<path d="{radial_wheel(cx, CY, radius - BAND / 2, radius + BAND / 2, teeth, phase)}" '
            f'fill="none" stroke="{wheel["colour"]}" stroke-width="1" '
            f'stroke-opacity="{wheel["opacity"]}"/>',
            cls=cls,
        )
        canvas.spin(cls, seconds=BEAT * teeth, cx=cx, cy=CY, reverse=bool(wheel["reverse"]))

    return canvas


if __name__ == "__main__":
    emit(build())
