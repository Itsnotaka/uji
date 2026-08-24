"""
Shared canvas for the landing-page diagrams.

Every diagram is generated, not drawn. A script in this directory computes a
figure from a closed-form rule — an involute tooth profile, a Vogel spiral, an
L-system, a superposition of sines — and emits an SVG whose only styling hooks
are the page's own colour tokens. Nothing here knows what the figures mean;
that is the generator's job.

Two conventions make the set read as one system:

  * Colour is never literal. Strokes are `currentColor` or a `var(--color-cog-*)`
    token, so a figure inverts with the theme and picks up the accent the rest
    of the page uses. The SVG is inlined into the page rather than loaded
    through <img>, which is what makes that work.
  * Motion is slow, linear, and endless. These are ambient figures beside a
    paragraph, not animations a reader is meant to watch finish. Every script
    emits a reduced-motion block that stops them outright.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

WIDTH = 320
HEIGHT = 180
CX = WIDTH / 2
CY = HEIGHT / 2

OUT_DIR = Path(__file__).resolve().parents[2] / "src" / "diagrams"

# The roles a figure may paint with. `ink` is the page's text colour, so a
# figure is legible in both themes without a second palette.
INK = "currentColor"
ACCENT = "var(--color-cog-accent)"
GREEN = "var(--color-cog-green)"
AMBER = "var(--color-cog-amber)"
VIOLET = "var(--color-cog-violet)"
CYAN = "var(--color-cog-cyan)"
GOLD = "var(--color-cog-gold)"

# Literal values, for figures that keep one appearance wherever they are shown.
BLACK = "#000000"
WHITE = "#ffffff"


def fmt(value: float) -> str:
    """Trim coordinates to two decimals so diffs stay readable."""
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def point(x: float, y: float) -> str:
    return f"{fmt(x)},{fmt(y)}"


def polyline_d(points: list[tuple[float, float]], close: bool = False) -> str:
    if not points:
        return ""
    head = f"M{point(*points[0])}"
    tail = "".join(f"L{point(*p)}" for p in points[1:])
    return head + tail + ("Z" if close else "")


def circle_d(cx: float, cy: float, r: float) -> str:
    """A circle as one path, so every figure is made of the same primitive."""
    return (
        f"M{fmt(cx - r)},{fmt(cy)}"
        f"a{fmt(r)},{fmt(r)} 0 1,0 {fmt(r * 2)},0"
        f"a{fmt(r)},{fmt(r)} 0 1,0 {fmt(-r * 2)},0"
    )


def rotate(x: float, y: float, angle: float, cx: float = 0.0, cy: float = 0.0) -> tuple[float, float]:
    sin, cos = math.sin(angle), math.cos(angle)
    dx, dy = x - cx, y - cy
    return cx + dx * cos - dy * sin, cy + dx * sin + dy * cos


@dataclass
class Canvas:
    """Accumulates SVG nodes and CSS rules, then writes one file.

    Card diagrams take the default 320x180 and paint in `currentColor`, so they
    invert with the page. A figure that must hold one appearance wherever it is
    embedded — a share card, a blog header — sets `background` instead and
    paints in literal ink.
    """

    name: str
    nodes: list[str] = field(default_factory=list)
    rules: list[str] = field(default_factory=list)
    width: float = WIDTH
    height: float = HEIGHT
    background: str | None = None

    @property
    def cx(self) -> float:
        return self.width / 2

    @property
    def cy(self) -> float:
        return self.height / 2

    def add(self, node: str) -> None:
        self.nodes.append(node)

    def css(self, rule: str) -> None:
        self.rules.append(rule.strip())

    def path(
        self,
        d: str,
        *,
        stroke: str = INK,
        width: float = 1.0,
        opacity: float = 0.4,
        dash: str | None = None,
        fill: str = "none",
        cls: str | None = None,
        extra: str = "",
    ) -> None:
        attrs = [
            f'd="{d}"',
            f'fill="{fill}"',
            f'stroke="{stroke}"',
            f'stroke-width="{fmt(width)}"',
            f'stroke-opacity="{fmt(opacity)}"',
        ]
        if dash:
            attrs.append(f'stroke-dasharray="{dash}"')
        if cls:
            attrs.append(f'class="{cls}"')
        if extra:
            attrs.append(extra)
        self.add(f"<path {' '.join(attrs)}/>")

    def dot(
        self,
        cx: float,
        cy: float,
        r: float,
        *,
        fill: str = INK,
        opacity: float = 0.4,
        cls: str | None = None,
    ) -> None:
        attrs = [
            f'cx="{fmt(cx)}"',
            f'cy="{fmt(cy)}"',
            f'r="{fmt(r)}"',
            f'fill="{fill}"',
            f'fill-opacity="{fmt(opacity)}"',
        ]
        if cls:
            attrs.append(f'class="{cls}"')
        self.add(f"<circle {' '.join(attrs)}/>")

    def group(self, body: str, *, cls: str | None = None, extra: str = "") -> None:
        attrs = []
        if cls:
            attrs.append(f'class="{cls}"')
        if extra:
            attrs.append(extra)
        head = f"<g {' '.join(attrs)}>" if attrs else "<g>"
        self.add(f"{head}{body}</g>")

    def spin(self, cls: str, *, seconds: float, cx: float, cy: float, reverse: bool = False) -> None:
        """A constant rotation about a point. The transform-box/origin pair is
        what keeps the centre stable when the SVG is scaled by its container."""
        end = -360 if reverse else 360
        self.css(
            f".{cls}{{transform-origin:{fmt(cx)}px {fmt(cy)}px;"
            f"animation:{cls}-spin {fmt(seconds)}s linear infinite}}"
            f"@keyframes {cls}-spin{{to{{transform:rotate({end}deg)}}}}"
        )

    def draw_on(self, cls: str, *, length: float, seconds: float, delay: float = 0.0) -> None:
        """Trace a path on, hold, and start again — growth, not a loop."""
        self.css(
            f".{cls}{{stroke-dasharray:{fmt(length)};stroke-dashoffset:{fmt(length)};"
            f"animation:{cls}-draw {fmt(seconds)}s var(--ease-uji, ease-out) {fmt(delay)}s infinite}}"
            f"@keyframes {cls}-draw{{0%{{stroke-dashoffset:{fmt(length)}}}"
            f"55%,100%{{stroke-dashoffset:0}}}}"
        )

    def pulse(self, cls: str, *, seconds: float, delay: float = 0.0, low: float = 0.12, high: float = 0.75) -> None:
        self.css(
            f".{cls}{{animation:{cls}-pulse {fmt(seconds)}s ease-in-out {fmt(delay)}s infinite}}"
            f"@keyframes {cls}-pulse{{0%,100%{{opacity:{low}}}50%{{opacity:{high}}}}}"
        )

    def render(self) -> str:
        style = "".join(self.rules)
        # The reduced-motion block lives inside the document so it holds however
        # the file is embedded.
        style += "@media(prefers-reduced-motion:reduce){*{animation:none!important}}"
        ground = (
            f'<rect width="{fmt(self.width)}" height="{fmt(self.height)}" fill="{self.background}"/>'
            if self.background
            else ""
        )
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {fmt(self.width)} {fmt(self.height)}" '
            f'fill="none" aria-hidden="true" class="h-full w-full">'
            f"<style>{style}</style>"
            f"{ground}"
            f'<g stroke-linecap="round" stroke-linejoin="round">'
            + "".join(self.nodes)
            + "</g></svg>"
        )

    def write(self) -> Path:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        target = OUT_DIR / f"{self.name}.svg"
        target.write_text(self.render() + "\n", encoding="utf-8")
        return target


def segment_clears(
    origin: tuple[float, float],
    end: tuple[float, float],
    centre: tuple[float, float],
    radius: float,
) -> bool:
    """True when no part of the segment falls inside the disc."""
    ax, ay = origin
    bx, by = end
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(ax - centre[0], ay - centre[1]) >= radius

    t = ((centre[0] - ax) * dx + (centre[1] - ay) * dy) / length_sq
    t = max(0.0, min(1.0, t))
    nearest = (ax + t * dx, ay + t * dy)
    return math.hypot(nearest[0] - centre[0], nearest[1] - centre[1]) >= radius


def segment_distance(
    a: tuple[tuple[float, float], tuple[float, float]],
    b: tuple[tuple[float, float], tuple[float, float]],
) -> float:
    """Smallest distance between two segments, crossings included as zero."""
    (ax, ay), (bx, by) = a
    (cx, cy), (dx, dy) = b

    r = (bx - ax, by - ay)
    s = (dx - cx, dy - cy)
    denominator = r[0] * s[1] - r[1] * s[0]
    if denominator != 0:
        t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / denominator
        u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / denominator
        if 0 <= t <= 1 and 0 <= u <= 1:
            return 0.0

    return min(
        point_segment_distance((ax, ay), b),
        point_segment_distance((bx, by), b),
        point_segment_distance((cx, cy), a),
        point_segment_distance((dx, dy), a),
    )


def point_segment_distance(
    point: tuple[float, float], segment: tuple[tuple[float, float], tuple[float, float]]
) -> float:
    (ax, ay), (bx, by) = segment
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(point[0] - ax, point[1] - ay)
    t = max(0.0, min(1.0, ((point[0] - ax) * dx + (point[1] - ay) * dy) / length_sq))
    return math.hypot(point[0] - (ax + t * dx), point[1] - (ay + t * dy))


def point_segment_distance(
    point_xy: tuple[float, float], segment: tuple[tuple[float, float], tuple[float, float]]
) -> float:
    (ax, ay), (bx, by) = segment
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(point_xy[0] - ax, point_xy[1] - ay)
    t = max(0.0, min(1.0, ((point_xy[0] - ax) * dx + (point_xy[1] - ay) * dy) / length_sq))
    return math.hypot(point_xy[0] - (ax + t * dx), point_xy[1] - (ay + t * dy))


def segment_distance(
    a: tuple[tuple[float, float], tuple[float, float]],
    b: tuple[tuple[float, float], tuple[float, float]],
) -> float:
    """Smallest distance between two segments; a crossing scores zero.

    Straight radial lines splay out of sync as a mesh widens — real teeth are
    involutes precisely to avoid that — so the wheels in this set keep their
    daylight by dropping a line rather than by drawing it through another.
    """
    (ax, ay), (bx, by) = a
    (cx, cy), (dx, dy) = b

    r = (bx - ax, by - ay)
    s = (dx - cx, dy - cy)
    denominator = r[0] * s[1] - r[1] * s[0]
    if denominator != 0:
        t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / denominator
        u = ((cx - ax) * r[1] - (cy - ay) * r[0]) / denominator
        if 0 <= t <= 1 and 0 <= u <= 1:
            return 0.0

    return min(
        point_segment_distance((ax, ay), b),
        point_segment_distance((bx, by), b),
        point_segment_distance((cx, cy), a),
        point_segment_distance((dx, dy), a),
    )


def wheel_lines(
    cx: float, cy: float, inner: float, outer: float, count: int, phase: float = 0.0
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """A wheel's teeth as segments, before any of them are dropped."""
    step = math.tau / count
    lines = []
    for index in range(count):
        angle = phase + index * step
        cos, sin = math.cos(angle), math.sin(angle)
        lines.append(
            ((cx + inner * cos, cy + inner * sin), (cx + outer * cos, cy + outer * sin))
        )
    return lines


def lines_to_path(
    lines: list[tuple[tuple[float, float], tuple[float, float]]],
) -> str:
    return "".join(f"M{point(*origin)}L{point(*end)}" for origin, end in lines)


def radial_wheel(
    cx: float,
    cy: float,
    inner: float,
    outer: float,
    count: int,
    phase: float = 0.0,
) -> str:
    """A wheel drawn as nothing but its teeth.

    The same abstraction the blog header is built from: a ring of radial lines
    between two circles, with no circles drawn. A narrow band reads as a rim
    and a wide one reads as a sun, so keep `outer - inner` small against the
    radius when the figure is meant to be machinery.
    """
    step = math.tau / count
    segments = []
    for index in range(count):
        angle = phase + index * step
        cos, sin = math.cos(angle), math.sin(angle)
        segments.append(
            f"M{point(cx + inner * cos, cy + inner * sin)}"
            f"L{point(cx + outer * cos, cy + outer * sin)}"
        )
    return "".join(segments)


def emit(canvas: Canvas) -> None:
    target = canvas.write()
    print(f"{target.relative_to(OUT_DIR.parents[2])}  {target.stat().st_size:>6} B")
