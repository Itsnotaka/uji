import { createFileRoute } from "@tanstack/react-router";

import { DesktopPreview } from "../components/desktop-preview";
import { SiteHeader } from "../components/site-header";

const principles = [
  {
    index: "01",
    title: "No workspace gate",
    body: "A bot can begin with a conversation. When a product needs a workspace, the UI chooses and provides it through the SDK.",
  },
  {
    index: "02",
    title: "No hidden server",
    body: "The Electron main process owns the harness, provider, and durable session. The renderer gets only the API it needs.",
  },
  {
    index: "03",
    title: "No pretend features",
    body: "Today: login, stream, stop, new chat, local history. New machinery arrives only when a real product flow requires it.",
  },
] as const;

const showcases = [
  {
    scenario: "conversation",
    number: "01",
    title: "Conversation",
    body: "The primary loop: a user message, an agent reply, and the local composer that starts the next run.",
  },
  {
    scenario: "search",
    number: "02",
    title: "Search",
    body: "A measured scrim, elevated palette, and selected result using Uji’s semantic surface tokens.",
  },
  {
    scenario: "details",
    number: "03",
    title: "Bot details",
    body: "The same conversation shell with the responsive inspector open over the right edge.",
  },
] as const;

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <main id="top" className="overflow-hidden bg-ink text-ink-foreground">
      <SiteHeader />

      <section className="mx-auto flex min-h-[720px] max-w-[1440px] flex-col justify-center px-5 pt-16 pb-24 md:px-10 md:pt-24">
        <p className="mb-6 font-mono text-[10px] tracking-[0.16em] text-ink-foreground/45 uppercase">
          Uji / Agent interface core
        </p>
        <h1 className="max-w-6xl text-[clamp(4.25rem,11vw,10rem)] leading-[0.84] font-medium tracking-[-0.075em]">
          Agent software,
          <br />
          made obvious.
        </h1>
        <div className="mt-12 flex max-w-3xl flex-col gap-8 border-t border-ink-foreground/20 pt-6 md:flex-row md:items-start md:justify-between">
          <p className="max-w-xl text-[clamp(1rem,2vw,1.35rem)] leading-relaxed text-ink-foreground/60">
            Uji is the small, durable core behind real agent apps. The first product demo is a
            native desktop conversation that signs in with ChatGPT and works without a project
            folder.
          </p>
          <a
            className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-ink-foreground px-5 text-sm font-medium text-ink hover:bg-ink-foreground/85"
            href="#desktop"
          >
            See the states ↓
          </a>
        </div>
      </section>

      <section id="desktop" className="bg-paper px-5 py-24 text-paper-foreground md:px-10 md:py-36">
        <div className="mx-auto max-w-[1440px]">
          <div className="mb-20 grid gap-8 md:grid-cols-[1fr_minmax(300px,520px)] md:items-end">
            <h2 className="text-[clamp(3.25rem,7vw,7rem)] leading-[0.9] font-medium tracking-[-0.065em]">
              One real app.
              <br />
              Three honest states.
            </h2>
            <p className="text-base leading-relaxed text-paper-foreground/55 md:pb-2">
              Conversation, search, and bot details are separate states of the runnable Electron
              demo. No invented products, and no screenshots detached from the shared token system.
            </p>
          </div>
          <div className="space-y-20 md:space-y-28">
            {showcases.map((showcase) => (
              <article
                className="scroll-mt-6"
                data-demo-scenario={showcase.scenario}
                id={`demo-${showcase.scenario}`}
                key={showcase.scenario}
              >
                <div className="mb-5 grid gap-2 border-t border-paper-foreground/15 pt-4 md:grid-cols-[5rem_12rem_minmax(0,1fr)] md:items-baseline">
                  <span className="font-mono text-[10px] text-paper-foreground/40">
                    {showcase.number}
                  </span>
                  <h3 className="text-lg font-medium tracking-[-0.025em]">{showcase.title}</h3>
                  <p className="max-w-2xl text-sm leading-relaxed text-paper-foreground/55">
                    {showcase.body}
                  </p>
                </div>
                <DesktopPreview scenario={showcase.scenario} />
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="core" className="mx-auto max-w-[1440px] px-5 py-28 md:px-10 md:py-40">
        <div className="grid gap-16 md:grid-cols-[minmax(280px,1fr)_2fr]">
          <div>
            <p className="font-mono text-[10px] tracking-[0.16em] text-ink-foreground/40 uppercase">
              The model
            </p>
            <h2 className="mt-5 text-4xl leading-tight font-medium tracking-[-0.045em] md:text-6xl">
              Core runs.
              <br />
              UI decides.
            </h2>
          </div>
          <div className="grid border-t border-ink-foreground/20 md:grid-cols-3">
            {principles.map((principle) => (
              <article
                className="border-b border-ink-foreground/20 py-6 md:min-h-80 md:border-r md:px-6 md:first:pl-0 md:last:border-r-0"
                key={principle.index}
              >
                <span className="font-mono text-[10px] text-ink-foreground/35">
                  {principle.index}
                </span>
                <h3 className="mt-16 text-xl font-medium tracking-[-0.025em]">{principle.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-foreground/45">
                  {principle.body}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-ink-foreground/15 px-5 py-24 md:px-10 md:py-32">
        <div className="mx-auto flex max-w-[1440px] flex-col items-start justify-between gap-10 md:flex-row md:items-end">
          <h2 className="max-w-4xl text-[clamp(3rem,7vw,7rem)] leading-[0.9] font-medium tracking-[-0.065em]">
            Build the interface people understand.
          </h2>
          <a
            className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-ink-foreground px-5 text-sm font-medium text-ink hover:bg-ink-foreground/85"
            href="https://github.com/Itsnotaka/uji"
            rel="noreferrer"
            target="_blank"
          >
            Explore Uji on GitHub ↗
          </a>
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1440px] items-center justify-between border-t border-ink-foreground/15 px-5 py-7 text-[11px] text-ink-foreground/35 md:px-10">
        <span>Uji</span>
        <span>Core for agent interfaces</span>
      </footer>
    </main>
  );
}
