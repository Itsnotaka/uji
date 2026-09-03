import { useSyncExternalStore } from "react";
import { appearanceSettings, subscribeAppearance, type AppearanceSettings } from "./boot.ts";

/** One client-wide appearance snapshot, shared by settings and conversation presentation. */
export function useAppearanceSettings(): AppearanceSettings {
  return useSyncExternalStore(subscribeAppearance, appearanceSettings, appearanceSettings);
}
