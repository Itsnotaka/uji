import { useMatch } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { ThreadScreen } from "../screens/thread.tsx";

/**
 * One workspace-lifetime stage for blank and session locations. The route
 * changes its data binding; it does not replace pane or workbench ownership.
 */
export function WorkspaceStage(): ReactElement {
  const session = useMatch({
    from: "/_workspace/session/$sessionId",
    shouldThrow: false,
  });

  return <ThreadScreen routeSessionId={session?.params.sessionId} />;
}
