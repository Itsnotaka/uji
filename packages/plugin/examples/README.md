# Plugin examples

These plugins demonstrate Uji's public `@uji-ai/plugin` contract. The TUI preinstalls fast mode and the question tool. A plugin with the same id in a discovered directory replaces the preinstalled copy, which also demonstrates discovery:

```sh
mkdir -p ~/.uji/plugins
ln -s "$PWD/packages/plugin/examples/question.ts" ~/.uji/plugins/question.ts
```

| Plugin | What it demonstrates |
| --- | --- |
| `question.ts` | A model-visible tool that uses `api.ask()` and the attached client's question UI |
| `fast-mode.ts` | A host-configured plugin factory with a durable `/fast` command and a `before_request` hook |
| `web-search.ts` | Host-owned credentials and provider routing over direct stateless `tools/call` requests |
