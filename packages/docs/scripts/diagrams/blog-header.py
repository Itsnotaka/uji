"""
Blog header graphic — an abstract gear train.

Unlike the card diagrams this one does not follow the page theme. A header
image is reused in feeds, share cards, and other people's readers, so it
carries its own ground: black on white, always, at 1200x630.

The wheels are not gears. Each one is a ring of radial lines between an inner
and an outer circle, and everything that makes it read as machinery comes from
four rules rather than from drawing teeth.

  1. Pitch first. A tooth count is chosen; the radius follows from it. Every
     wheel shares one circular pitch, so a small wheel and a large wheel are
     equally dense to the eye and no density is set by hand.
  2. Meshing. Two wheels sit at the sum of their pitch radii, which puts each
     one's lines exactly halfway into the other's band. That is only consistent
     when every wheel shares a band width, so BAND is global — which is also
     what keeps the figure looking like one mechanism.
  3. Phase. At each mesh one wheel aims a line down the line of centres and its
     partner aims a gap. Because the pitch circles are tangent and the pitch is
     shared, that interleave holds across the whole overlap, not just at the
     contact point: equal arc length steps one tooth on either wheel.
  5. Occlusion. A wheel in front cuts a disc out of the wheel behind it, and a
     line inside that disc is dropped whole. A partly cropped line reads as a
     broken line rather than as one wheel passing behind another.

The middle wheel is a double gear: two rings on one centre, driven on the large
one and driving on the small one. That makes the figure a two-stage reduction,
which is why the pinion between the two big wheels is so much smaller.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from _canvas import (
    BLACK,
    WHITE,
    Canvas,
    emit,
    fmt,
    segment_clears,
    segment_distance,
)

WIDTH = 1200.0
HEIGHT = 630.0
CENTRE_Y = HEIGHT / 2

# Where the right wheel's outer circle stops, and where the left wheel's starts.
INSET = 96.0

# Arc length between lines at the pitch circle. The only density control here.
PITCH = 20.0

# One band width for the whole figure — rule 2 only holds if every wheel has
# the same one. Keeping it narrow against the radii is what stops a wheel from
# reading as a sun: a thin ring of lines is a rim, a thick one is a burst.
BAND = 30.0

# Daylight left around a wheel that passes in front of another.
OCCLUSION_CLEARANCE = 14.0

# Daylight a line must keep from the lines it meshes with.
MESH_CLEARANCE = 7.0

STROKE = 1.7

# Rule 1. Radii are consequences of these four numbers.
TEETH = {"left": 60, "mid_outer": 42, "mid_inner": 21, "right": 62}


@dataclass
class Wheel:
    name: str
    teeth: int
    cx: float = 0.0
    cy: float = CENTRE_Y
    phase: float = 0.0

    @property
    def pitch_radius(self) -> float:
        """Circumference is teeth x pitch, so the radius falls out of the count."""
        return self.teeth * PITCH / math.tau

    @property
    def outer(self) -> float:
        return self.pitch_radius + BAND / 2

    @property
    def inner(self) -> float:
        return self.pitch_radius - BAND / 2

    @property
    def step(self) -> float:
        return math.tau / self.teeth

    def angles(self) -> list[float]:
        return [self.phase + index * self.step for index in range(self.teeth)]


def mesh_distance(a: Wheel, b: Wheel) -> float:
    """Rule 2: tangent pitch circles, which is the halfway condition."""
    return a.pitch_radius + b.pitch_radius


def tooth_phase(toward: float, wheel: Wheel) -> float:
    """A line aimed down the line of centres."""
    return toward - wheel.step * round(toward / wheel.step)


def gap_phase(toward: float, wheel: Wheel) -> float:
    """A gap aimed down the line of centres — rule 3, the other half."""
    return tooth_phase(toward, wheel) + wheel.step / 2


def wheel_segments(wheel: Wheel) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    segments = []
    for angle in wheel.angles():
        cos, sin = math.cos(angle), math.sin(angle)
        segments.append(
            (
                (wheel.cx + wheel.inner * cos, wheel.cy + wheel.inner * sin),
                (wheel.cx + wheel.outer * cos, wheel.cy + wheel.outer * sin),
            )
        )
    return segments


def draw_wheel(
    canvas: Canvas,
    wheel: Wheel,
    *,
    cutters: list[tuple[tuple[float, float], float]] = [],
    neighbours: list[Wheel] = [],
) -> int:
    """Rules 4 and 5 decide which of a wheel's lines survive."""
    rivals = [segment for neighbour in neighbours for segment in wheel_segments(neighbour)]
    drawn: list[str] = []

    for origin, end in wheel_segments(wheel):
        if any(not segment_clears(origin, end, centre, radius) for centre, radius in cutters):
            continue
        if any(segment_distance((origin, end), rival) < MESH_CLEARANCE for rival in rivals):
            continue
        drawn.append(f"M{fmt(origin[0])},{fmt(origin[1])}L{fmt(end[0])},{fmt(end[1])}")

    canvas.path("".join(drawn), stroke=BLACK, width=STROKE, opacity=1.0)
    return len(drawn)


def layout() -> dict[str, Wheel]:
    """Place the train left to right off the meshing rule alone."""
    left = Wheel("left", TEETH["left"])
    mid_outer = Wheel("mid-outer", TEETH["mid_outer"])
    mid_inner = Wheel("mid-inner", TEETH["mid_inner"])
    right = Wheel("right", TEETH["right"])

    left.cx = INSET + left.outer
    mid_outer.cx = left.cx + mesh_distance(left, mid_outer)
    mid_inner.cx = mid_outer.cx
    right.cx = mid_inner.cx + mesh_distance(mid_inner, right)

    # Rule 3, applied along the chain: a driving wheel offers a tooth, the
    # wheel it drives offers the gap that receives it.
    left.phase = tooth_phase(0.0, left)
    mid_outer.phase = gap_phase(math.pi, mid_outer)
    mid_inner.phase = tooth_phase(0.0, mid_inner)
    right.phase = gap_phase(math.pi, right)

    return {"left": left, "mid_outer": mid_outer, "mid_inner": mid_inner, "right": right}


def build() -> Canvas:
    canvas = Canvas("blog-header", width=WIDTH, height=HEIGHT, background=WHITE)
    wheels = layout()
    right = wheels["right"]

    # The right wheel turns in the pinion's plane, so it passes in front of the
    # large ring on the same centre and takes a bite out of it.
    bite = [((right.cx, right.cy), right.outer + OCCLUSION_CLEARANCE)]

    # Drawn in mesh order. A wheel yields to the ones already on the page, so
    # exactly one side of every conflict is dropped.
    left_wheel = wheels["left"]
    mid_outer = wheels["mid_outer"]
    mid_inner = wheels["mid_inner"]

    drawn = {
        "left": draw_wheel(canvas, left_wheel),
        "mid_outer": draw_wheel(canvas, mid_outer, cutters=bite, neighbours=[left_wheel]),
        "mid_inner": draw_wheel(canvas, mid_inner),
        "right": draw_wheel(canvas, right, neighbours=[mid_inner]),
    }

    for key, wheel in wheels.items():
        print(
            f"  {wheel.name:<10} teeth={wheel.teeth:3d} drawn={drawn[key]:3d} "
            f"cx={wheel.cx:7.1f} outer={wheel.outer:6.1f} inner={wheel.inner:6.1f}"
        )
    print(f"  right edge inset {WIDTH - (right.cx + right.outer):.1f}")

    return canvas


if __name__ == "__main__":
    emit(build())
