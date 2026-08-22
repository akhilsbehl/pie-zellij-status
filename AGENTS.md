# pie-zellij-status project instructions

This project is a public Pi extension that mirrors Pi attention state into the current Zellij session.

## Development

- The package identity is `pie-zellij-status`.
- Review `README.md` before changing adapters.
- Keep the extension and skill documentation aligned.
- Pi loads the extension source through a machine-local symlink in the parent configuration.

## Submodule development

This project is checked out as a Git submodule of `configs`. For normal development, switch from the parent's detached pinned commit to a named child branch before editing. Commit and push changes in this child repository. Update the parent repository's submodule pin in a separate commit only when explicitly requested. Use the detached pinned state only for read-only verification, reproduction, or testing the exact parent integration.
