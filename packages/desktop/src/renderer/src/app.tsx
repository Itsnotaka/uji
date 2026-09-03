import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactElement } from "react";
import { keys, loadLocalResources, queryClient } from "./queries.ts";
import { router } from "./router";
import { uji } from "./uji.ts";

/** Host events reshape the world; queries re-read it. */
function useHostEvents(): void {
  useEffect(() => {
    return uji.host.onEvent((event) => {
      switch (event.kind) {
        case "workspace_opened":
        case "workspace_closed":
          // The route owns availability and replacement semantics. A host
          // event only refreshes caches, then asks the active route to decide
          // again against the newest host state.
          void loadLocalResources()
            .then(() => router.invalidate())
            .catch(() => undefined);
          return;
        case "auth_changed":
          void queryClient.invalidateQueries({ queryKey: keys.providers });
          void queryClient.invalidateQueries({ queryKey: keys.models });
          void queryClient.invalidateQueries({ queryKey: keys.modelDefault });
          return;
        case "github_changed":
          void queryClient.invalidateQueries({ queryKey: keys.github });
          return;
        case "status":
          return;
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    });
  }, []);
}

export function App(): ReactElement {
  useHostEvents();
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
