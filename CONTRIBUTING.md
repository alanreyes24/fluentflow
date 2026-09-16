# Contributing

FluentFlow is a vibe-coded hobby project I made to practice languages. Small
fixes and bug reports are welcome, but I work on it when I have time and cannot
promise reviews or support. For a larger change, open an issue first so we can
check whether it fits the project.

Use the [README](README.md) to get started and
[development guide](docs/development.md) for configuration and packaging.

For a bug report, include the platform, commit or version, reproduction steps,
and what you expected to happen. Use a small made-up deck when possible. Remove
API keys, account details, and personal study content from logs and screenshots.
Report sensitive vulnerabilities using [SECURITY.md](SECURITY.md).

For a pull request:

- Keep it focused and explain the change in plain language.
- Run `npm test`, `npm run typecheck`, and `npm run verify`. Check the app when
  changing the UI, and add a regression test when it will catch a real bug.
- Update the docs when setup or behavior changes.
- Commit lockfile changes when changing dependencies. Do not commit `.env`
  files, credentials, private decks, databases, or build output.

AI-assisted contributions are welcome. Read and test what you submit, and say
what you have actually checked. Contributions are provided under the project's
[MIT license](LICENSE).
