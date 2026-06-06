# Brainbox UX/UI Audit

Date: 2026-06-06

## Evidence

Screenshots were captured locally in:

`C:\Users\USER\AppData\Local\Temp\brainbox-ux-audit-20260606-201411`

Captured steps:

1. Vault list / empty knowledge state
2. Search idle state
3. Search with Brainy drawer open
4. Settings with Brainy drawer open

## Findings

1. Context panels leak across screens.
   Brainy stays open when moving from Search/Brainy to Settings, which makes Settings look like two separate products stitched together.

2. Global actions are not screen-aware.
   Settings showed `New note` as the primary action even though the user task there is configuration.

3. Empty and idle states are too large or too blank.
   The vault empty state uses a wide bordered block, while Search initially has almost no content after the search input.

4. The app still has too many local styling decisions.
   The latest token pass fixed theme drift, but components still need to converge around a smaller set of primitives: shell, toolbar, panel, row, tile, drawer, empty state.

5. The selected-vault workspace is directionally stronger than the rest of the app.
   It has a clear command bar, filter row, and canvas. The other screens should adopt that pattern instead of having separate one-off layouts.

## Cleanup Spec

1. Route changes close contextual panels.
   Brainy and item details should not remain open after navigating to unrelated screens.

2. Headers are task-specific.
   Only screens where note creation is a natural primary action should show `New note`.

3. Search gets a useful idle state.
   A search screen should not be a mostly empty canvas before the first query.

4. Empty states are compact.
   Empty vault and empty result states should be smaller, quieter, and left-aligned when they live in a working surface.

5. Continue refactoring toward shared primitives.
   Next recommended implementation pass: extract `AppShell`, `TopBar`, `ScreenPanel`, `EmptyState`, and `Drawer` so the app stops accumulating one-off CSS.
