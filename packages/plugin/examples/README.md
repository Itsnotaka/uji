# Plugin examples

These plugins demonstrate Uji's public `@uji-ai/plugin` contract. The TUI preinstalls fast mode as a host option; the question tool remains opt-in so it demonstrates plugin discovery instead of becoming part of the client.

Copy or link the question plugin into a discovered plugin directory to enable it:

```sh
mkdir -p ~/.uji/plugins
ln -s "$PWD/packages/plugin/examples/question.ts" ~/.uji/plugins/question.ts
```

| Plugin | What it demonstrates |
| --- | --- |
| `question.ts` | A model-visible tool that uses `api.ask()` and the attached client's question UI |
| `fast-mode.ts` | A host-configured plugin factory with a durable `/fast` command and a `before_request` hook |
