# Extensions directory

Put one extension bundle per subdirectory. Each bundle needs `moira-extension.json` and the
entrypoint named by that manifest.

This directory is mounted read-only into the optional extension runner. It is not visible to the
Moira application, and installed bundles are intentionally ignored by Git.

```bash
cp -R examples/extensions/webhook-notify extensions/
```

Enable the runner and diagnose bundle loading with the commands in [Self-hosting: Enable
extensions](../packages/docs/src/content/docs/docs/getting-started/self-hosting.mdx#enable-extensions).
The manifest and SDK contracts are in [Writing an
Extension](../packages/docs/src/content/docs/docs/guides/writing-extensions.mdx).
