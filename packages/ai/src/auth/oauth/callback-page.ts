/**
 * HTML served by the localhost OAuth callback server. Self-contained (no
 * external fonts, scripts, or images) so it renders identically offline and
 * on any browser the user happens to have open.
 */

interface CallbackPageOptions {
  /** Product name shown above the headline. */
  brand?: string;
  /** Extra detail for failures, e.g. an `error_description` from the provider. */
  detail?: string;
}

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light dark;
    --bg: #f6f6f5;
    --card: #ffffff;
    --border: #e4e4e2;
    --text: #161614;
    --muted: #6f6c67;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121211;
      --card: #1c1c1a;
      --border: #2e2e2b;
      --text: #f2f1ee;
      --muted: #a29f99;
    }
  }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main {
    width: 100%;
    max-width: 26rem;
    padding: 2.25rem 2rem 2rem;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--card);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px -18px rgba(0, 0, 0, 0.35);
    text-align: center;
    animation: rise 0.35s ease-out both;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    main { animation: none; }
  }
  .badge {
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    margin: 0 auto 1.25rem;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .badge svg { width: 1.5rem; height: 1.5rem; display: block; }
  .brand {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h1 { margin: 0 0 0.5rem; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); }
  .detail {
    margin-top: 1rem;
    padding: 0.7rem 0.85rem;
    border-radius: 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--text);
    text-align: left;
    overflow-wrap: anywhere;
  }
  footer {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
    font-size: 0.8125rem;
    color: var(--muted);
  }
`;

const SUCCESS_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>`;
const ERROR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Accent {
  /** `[light, dark]` foreground for the status badge. */
  fg: [string, string];
  /** `[light, dark]` background for the status badge. */
  bg: [string, string];
}

const SUCCESS_ACCENT: Accent = { fg: ["#1f8a5b", "#4ec78d"], bg: ["#e6f4ec", "#183024"] };
const ERROR_ACCENT: Accent = { fg: ["#c0392f", "#f08b80"], bg: ["#fbeae8", "#3a1c18"] };

function accentStyles(accent: Accent): string {
  return `
  :root { --accent: ${accent.fg[0]}; --accent-soft: ${accent.bg[0]}; }
  @media (prefers-color-scheme: dark) {
    :root { --accent: ${accent.fg[1]}; --accent-soft: ${accent.bg[1]}; }
  }`;
}

function render(options: {
  brand: string;
  title: string;
  body: string;
  icon: string;
  accent: Accent;
  footer: string;
  detail?: string;
}): string {
  const detail =
    options.detail === undefined || options.detail.trim() === ""
      ? ""
      : `\n      <p class="detail">${escapeHtml(options.detail.trim())}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(options.title)} &middot; ${escapeHtml(options.brand)}</title>
  <style>${STYLES}${accentStyles(options.accent)}
  </style>
</head>
<body>
  <main>
    <div class="badge">${options.icon}</div>
    <p class="brand">${escapeHtml(options.brand)}</p>
    <h1>${escapeHtml(options.title)}</h1>
    <p>${escapeHtml(options.body)}</p>${detail}
    <footer>${escapeHtml(options.footer)}</footer>
  </main>
</body>
</html>
`;
}

/** Page shown after the provider redirects back with a usable authorization code. */
export function renderCallbackSuccess(options: CallbackPageOptions = {}): string {
  return render({
    brand: options.brand ?? "June",
    title: "You're signed in",
    body: "Authentication finished successfully.",
    icon: SUCCESS_ICON,
    accent: SUCCESS_ACCENT,
    footer: "You can close this tab — the rest happens in your terminal.",
    detail: options.detail,
  });
}

/** Page shown when the callback carries no code, a bad state, or a provider error. */
export function renderCallbackError(options: CallbackPageOptions = {}): string {
  return render({
    brand: options.brand ?? "June",
    title: "Sign-in failed",
    body: "We couldn't complete authentication.",
    icon: ERROR_ICON,
    accent: ERROR_ACCENT,
    footer: "You can close this tab and start the login again from your terminal.",
    detail: options.detail,
  });
}
