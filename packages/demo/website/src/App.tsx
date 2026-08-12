import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";

type Demo = {
  id: string;
  index: string;
  title: string;
  kicker: string;
  description: string;
  href: string;
  external: boolean;
  action: string;
  accent: string;
  mark: string;
  tags: string[];
};

const demos: Demo[] = [
  {
    id: "grok-bot",
    index: "01",
    title: "Grok Bot",
    kicker: "Chat surface",
    description: "An always-on agent team, rendered as a focused desktop conversation.",
    href: "http://127.0.0.1:5173",
    external: true,
    action: "Open on :5173",
    accent: "#e36f47",
    mark: "G",
    tags: ["React", "Mock protocol"],
  },
  {
    id: "opencrew",
    index: "02",
    title: "OpenCrew",
    kicker: "Reference note",
    description:
      "What June can learn from channel-shaped multi-agent teams—and what stays outside core.",
    href: "#opencrew",
    external: false,
    action: "Read reference",
    accent: "#6d61c4",
    mark: "O",
    tags: ["Cautionary", "No code copied"],
  },
];

function SearchIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="m20 20-4-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg aria-hidden="true" fill="none" height="17" viewBox="0 0 24 24" width="17">
      {diagonal ? (
        <>
          <path d="M7 17 17 7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path
            d="M8 7h9v9"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </>
      ) : (
        <>
          <path d="M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path
            d="m13 6 6 6-6 6"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </>
      )}
    </svg>
  );
}

function Brand() {
  return (
    <a className="site-brand" href="#" aria-label="June demos home">
      <span>J</span>
      <strong>june</strong>
      <i>/</i>
      <em>demos</em>
    </a>
  );
}

function Home() {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredDemos = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return demos;
    return demos.filter((demo) =>
      [demo.title, demo.kicker, demo.description, ...demo.tags]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [query]);

  function openDemo(demo: Demo) {
    if (demo.external) {
      window.open(demo.href, "_blank", "noopener,noreferrer");
      return;
    }
    window.location.hash = demo.id;
  }

  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (!filteredDemos.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        (current) => (current + direction + filteredDemos.length) % filteredDemos.length,
      );
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selection = filteredDemos[activeIndex] ?? filteredDemos[0];
      if (selection) openDemo(selection);
    }
  }

  return (
    <>
      <header className="site-header">
        <Brand />
        <div className="header-status">
          <span /> protocol-shaped UI
        </div>
      </header>

      <main className="landing">
        <section className="hero">
          <p className="overline">
            <span>Interface studies</span>
            <b>002</b>
          </p>
          <h1>
            Small surfaces.
            <br />
            <em>Clear boundaries.</em>
          </h1>
          <p className="hero-copy">
            Focused demos for agent products built above June’s schema and protocol—not inside the
            loop.
          </p>
        </section>

        <section className="command-panel" aria-label="Demo command menu">
          <label className="command-search">
            <SearchIcon />
            <input
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeys}
              placeholder="Search demos and references…"
              type="search"
              value={query}
            />
            <kbd>⌘ K</kbd>
          </label>

          <div className="command-section-label">
            <span>Showcase</span>
            <small>{filteredDemos.length.toString().padStart(2, "0")}</small>
          </div>

          <div className="demo-list">
            {filteredDemos.map((demo, index) => (
              <a
                className={`demo-row${index === activeIndex ? " is-active" : ""}`}
                href={demo.href}
                key={demo.id}
                onMouseEnter={() => setActiveIndex(index)}
                rel={demo.external ? "noreferrer" : undefined}
                style={{ "--demo-accent": demo.accent } as CSSProperties}
                target={demo.external ? "_blank" : undefined}
              >
                <span className="demo-index">{demo.index}</span>
                <span className="demo-mark">{demo.mark}</span>
                <span className="demo-copy">
                  <span className="demo-title-line">
                    <strong>{demo.title}</strong>
                    <small>{demo.kicker}</small>
                  </span>
                  <span className="demo-description">{demo.description}</span>
                  <span className="demo-tags">
                    {demo.tags.map((tag) => (
                      <i key={tag}>{tag}</i>
                    ))}
                  </span>
                </span>
                <span className="demo-action">
                  <small>{demo.action}</small>
                  <Arrow diagonal={demo.external} />
                </span>
              </a>
            ))}

            {!filteredDemos.length && (
              <div className="no-results">
                <span>∅</span>
                <p>No surface matches “{query}”.</p>
              </div>
            )}
          </div>

          <footer className="command-footer">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate
            </span>
            <span>
              <kbd>↵</kbd> open
            </span>
            <span className="command-footnote">clean-room studies</span>
          </footer>
        </section>

        <section className="principles" aria-label="Demo principles">
          <article>
            <span>01 / Boundary</span>
            <strong>UI speaks schema</strong>
            <p>Clients render protocol items. They do not own the agent loop.</p>
          </article>
          <article>
            <span>02 / Posture</span>
            <strong>Copy the lesson</strong>
            <p>Study public behavior and architecture, never proprietary product source.</p>
          </article>
          <article>
            <span>03 / Scope</span>
            <strong>Stubs over bindings</strong>
            <p>Product flows are visible; host-specific widgets can wait for a host.</p>
          </article>
        </section>
      </main>

      <footer className="site-footer">
        <span>June / 2026</span>
        <span>Interfaces for durable agents</span>
      </footer>
    </>
  );
}

function OpenCrewPage({ onBack }: { onBack: () => void }) {
  return (
    <>
      <header className="site-header reference-header">
        <Brand />
        <button className="back-button" onClick={onBack} type="button">
          <span>←</span> All studies
        </button>
      </header>

      <main className="reference-page">
        <section className="reference-hero">
          <p className="overline">
            <span>Cautionary reference</span>
            <b>02</b>
          </p>
          <div className="reference-title-row">
            <span className="reference-mark">O</span>
            <div>
              <h1>OpenCrew</h1>
              <p>Multi-agent teamwork made legible through familiar channels and threads.</p>
            </div>
          </div>
        </section>

        <aside className="caution-note">
          <span>Reference only</span>
          <p>
            OpenCrew is a product and operating model for OpenClaw teams. June studies its visible
            coordination patterns; it does not fork them into <code>@june/core</code> or make the
            loop depend on a specific chat host.
          </p>
        </aside>

        <section className="reference-lessons">
          <article>
            <span className="lesson-number">01</span>
            <div>
              <small>Orientation</small>
              <h2>Channels make roles tangible</h2>
              <p>
                A user can see where the chief of staff, builder, and specialist live without
                learning an orchestration DSL.
              </p>
            </div>
          </article>
          <article>
            <span className="lesson-number">02</span>
            <div>
              <small>Isolation</small>
              <h2>Threads make tasks concrete</h2>
              <p>
                Conversation structure becomes the task boundary, so parallel work remains
                inspectable instead of disappearing into a graph.
              </p>
            </div>
          </article>
          <article>
            <span className="lesson-number">03</span>
            <div>
              <small>Coordination</small>
              <h2>Handoffs stay in the room</h2>
              <p>
                Agent-to-agent discussion is useful when the user can review direction, ownership,
                and the final result in the same surface.
              </p>
            </div>
          </article>
        </section>

        <section className="boundary-section">
          <div className="boundary-heading">
            <p className="overline">
              <span>The June cut</span>
              <b>04</b>
            </p>
            <h2>Keep the interaction. Refuse the coupling.</h2>
          </div>
          <div
            className="boundary-map"
            role="img"
            aria-label="OpenCrew informs observations which become protocol items rendered by demos, without entering June core"
          >
            <div className="map-node map-source">
              <small>Reference</small>
              <strong>OpenCrew</strong>
              <span>channels · threads · roles</span>
            </div>
            <span className="map-arrow">→</span>
            <div className="map-node">
              <small>Extract</small>
              <strong>UX observations</strong>
              <span>states · events · handoffs</span>
            </div>
            <span className="map-arrow">→</span>
            <div className="map-node map-target">
              <small>June boundary</small>
              <strong>Protocol / schema</strong>
              <span>portable items for any UI</span>
            </div>
            <span className="map-arrow">→</span>
            <div className="map-node">
              <small>Render</small>
              <strong>Demo clients</strong>
              <span>web · desktop · CLI peers</span>
            </div>
          </div>
          <div className="not-core">
            <span>Not this</span>
            <code>OpenCrew implementation → @june/core</code>
            <strong>×</strong>
          </div>
        </section>

        <section className="source-note">
          <div>
            <small>Local reference inspected</small>
            <code>/home/box/Developer/opencrew</code>
          </div>
          <a href="https://github.com/AlexAnys/opencrew" rel="noreferrer" target="_blank">
            View upstream <Arrow diagonal />
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <button onClick={onBack} type="button">
          ← Return to showcase
        </button>
        <span>No source copied into June</span>
      </footer>
    </>
  );
}

export function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1));

  useEffect(() => {
    const updateRoute = () => setRoute(window.location.hash.slice(1));
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  function goHome() {
    window.history.pushState(null, "", window.location.pathname + window.location.search);
    setRoute("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="site-shell">
      <div className="paper-grid" aria-hidden="true" />
      {route === "opencrew" ? <OpenCrewPage onBack={goHome} /> : <Home />}
    </div>
  );
}
