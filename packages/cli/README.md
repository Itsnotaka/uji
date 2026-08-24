# uji-ai

`uji-ai` is the executable distribution for Uji, a client/server coding-agent platform with a headless host and terminal client. It installs the `uji` command.

## Status

This release is a placeholder that reserves the npm package and `uji` command. It does not start an agent or server yet.

The planned command shape is:

```sh
npx uji-ai        # open the terminal client
npx uji-ai serve  # run the standalone headless server
```

The installed command uses the same entry point:

```sh
npm install --global uji-ai
uji
uji serve
```

The published `uji-ai` package will compose the private `@uji-ai/tui` client with the `@uji-ai/server` host. It will not carry a second implementation of either package.
