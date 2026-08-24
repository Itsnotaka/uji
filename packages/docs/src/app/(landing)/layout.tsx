import { GridLines } from "@/components/landing/grid-lines";
import { RailNav } from "@/components/landing/rail-nav";
import { LandingFooter } from "@/components/landing/landing-footer";

/*
 * The landing surface has its own chrome: no docs sidebar, no marketing
 * header, no theme switch. The nav is a rail in the first three columns, and
 * it lives here rather than in the page so that its sticky container is as
 * tall as the whole document — a rail that sticks only within one section is
 * not a rail.
 */
export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <div className="cog-page flex min-h-screen flex-col">
      <div className="relative flex-1">
        <GridLines />

        <div className="cog-container relative z-10">
          <div className="cog-grid">
            <div className="col-span-full pt-16 md:col-span-3 md:pt-(--cog-section)">
              <div className="sticky top-8">
                <RailNav />
              </div>
            </div>

            <main className="col-span-full md:col-span-12">{children}</main>
          </div>
        </div>
      </div>

      <LandingFooter />
    </div>
  );
}
