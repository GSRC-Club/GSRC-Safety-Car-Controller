# GSRC Safety Car Controller

This repository owns the standalone Windows/Electron controller. Develop here independently of the broadcast and RC relays. `shared/` contains locally owned iRacing adapters; do not add sibling-repository imports or silently sync relay changes.

- Start with `README.md`, `progress.md`, and task-relevant documentation. Use a task branch/worktree; preserve changes owned by others.
- Keep live output disarmed by default, continuous session-bound authority, rehearsal isolation, serial command delivery, recovery acknowledgement and deferred penalties intact.
- Run `npm ci` and `npm test`. Packaging changes also require `npm run dist` on a Windows host with the pinned certificate. Never bypass the signing hooks or put private keys in Git.
- UI changes require a local Electron or browser screenshot. This is a desktop application, not an NUC/NAS service; do not deploy it to the central server.
- Use rehearsal for automated UI verification. Live hosted-session tests, installer distribution and production use require explicit scope.
- Update `progress.md` with outcomes, checks and remaining acceptance gates. Stage explicit paths, review diffs, and publish completed source to `main` without force.
- Preserve the existing private licence and attribution. Generated installers, credentials and runtime driver data stay outside Git.
