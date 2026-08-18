import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { PropsWithChildren } from "react";

import "../styles.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "June — Agent software that feels obvious" },
      {
        name: "description",
        content: "June Core powers real agent apps across desktop, web, and the interfaces ahead.",
      },
    ],
  }),
  shellComponent: RootDocument,
  component: Outlet,
});

function RootDocument({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
