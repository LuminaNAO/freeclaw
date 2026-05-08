# FreeClaw Versioning

FreeClaw reset its product version when it forked from OpenClaw. Treat the
root `package.json` version as the source of truth for the FreeClaw product
line, even if older inherited git tags exist in this repository.

Use semantic versioning for FreeClaw releases:

- patch version for compatible fixes
- minor version for compatible user-facing features
- major version for breaking changes

Do not use plain `vX.Y.Z` tags for new FreeClaw releases unless the tag name is
known to be free and belongs to the FreeClaw line. This repository contains
historical tags from before the FreeClaw reset, so prefer fork-specific release
tags:

```text
freeclaw-vX.Y.Z
```

Example: if `package.json` is `1.0.3` and the next FreeClaw release is a minor
feature release, set `package.json` to `1.1.0` and tag it as
`freeclaw-v1.1.0`.
