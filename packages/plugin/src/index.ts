/**
 * What a plugin author imports: the author-facing name for
 * `@uji-ai/core/plugins`. It re-exports that entry and contains nothing else,
 * so one process never holds two copies of the plugin types. A loader maps
 * this package to the host's copy of core.
 */
export * from "@uji-ai/core/plugins";
