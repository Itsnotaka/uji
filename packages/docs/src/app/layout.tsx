import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/*
 * Berkeley Mono is licensed, not open. The .ttf files live in src/fonts/ and
 * are served from the build output, so the licence has to cover web embedding
 * for this domain before this ships publicly.
 *
 * It carries more than code here: labels, section numbers, and data columns are
 * set in it, which is what keeps hierarchy legible without leaning on Inter's
 * weights alone.
 */
const berkeleyMono = localFont({
  src: [
    { path: "../fonts/BerkeleyMono-Regular.ttf", weight: "400", style: "normal" },
    { path: "../fonts/BerkeleyMono-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-berkeley-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "June — a handwritten core for agentic UI",
    template: "%s — June",
  },
  description:
    "June is an independent, handwritten core for building cross-platform agentic UI: a durable agent harness plus a standalone agent loop.",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${berkeleyMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
