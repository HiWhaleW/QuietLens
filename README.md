# QuietLens

QuietLens is a desktop web prototype for finding places that match a user's current sensory preferences. Instead of ranking cafes by popularity, it compares quietness, crowd levels, natural light, and seating comfort for the selected time and activity.

## Current Scope

- Desktop web experience; mobile is intentionally out of scope for this phase
- Three fixed, high-resolution Shanghai watercolor map boards
- Ten prototype cafe results in Huangpu District
- Deterministic preference scoring across four sensory dimensions
- Map-first selection flow with a watercolor place reveal and evidence drawer

## Run Locally

```bash
npm install
npm run dev
```

Create and verify a production build with:

```bash
npm run build
npm run test:sites
```

## Privacy and Repository Boundaries

This repository contains only the source code and original production assets required to run QuietLens. Local research photos, competitor references, internal review captures, machine-specific paths, credentials, and environment files are excluded from version control.

The cafe content is a prototype and should not be treated as a real-time guarantee of availability, noise, crowding, or opening hours.

## License

Copyright (c) 2026 QuietLens. All rights reserved. See [LICENSE](LICENSE).
