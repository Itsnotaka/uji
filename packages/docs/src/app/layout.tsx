import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import { Geist, Inter, Newsreader } from "next/font/google";
import localFont from "next/font/local";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/*
 * Geist sets the marketing statement voice: a Swiss grotesque with a
 * single-storey g and flat terminals, run at regular weight so hierarchy comes
 * from scale and spacing rather than from bold. The docs chrome stays on Inter.
 */
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

/*
 * Berkeley Mono is licensed, not open. The .ttf files live in src/fonts/ and
 * are served from the build output, so the licence has to cover web embedding
 * for this domain before this ships publicly.
 */
const berkeleyMono = localFont({
  src: [
    { path: "../fonts/BerkeleyMono-Regular.ttf", weight: "400", style: "normal" },
    { path: "../fonts/BerkeleyMono-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-berkeley-mono",
  display: "swap",
});

/*
 * Newsreader sets marketing prose on / and /branding. The editorial pattern is
 * restrained sans headings over serif paragraphs. The docs chrome never uses it.
 */
const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: {
    default: "Uji — a handwritten core for agentic UI",
    template: "%s — Uji",
  },
  description:
    "Uji is an independent, handwritten core for building cross-platform agentic UI: a durable agent harness plus a standalone agent loop.",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geist.variable} ${berkeleyMono.variable} ${newsreader.variable} ${inter.className}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
