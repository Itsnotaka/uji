export type ThemePreference = "system" | "light" | "dark";

const storageKey = "june.theme";

export function loadThemePreference(): ThemePreference {
  const stored = localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  root.classList.toggle("light", preference === "light");
  root.classList.toggle("dark", preference === "dark");
  localStorage.setItem(storageKey, preference);
}
