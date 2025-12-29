# Review

## Findings
- **Double-start risk**: `startLoginScan` can still be invoked twice if the user double-clicks before `scanning` state flips, causing overlapping timers and interleaved match history. Guard with `scanningRef.current` or disable the button while starting. (src/App.tsx:272, 282, 288)
- **State reset regression test**: The critical bug where no-face frames erased `matchHistoryRef` during scans is fixed in the current code path; keep a regression test around this behavior to prevent reintroduction. (src/App.tsx:178-185)
- **Data persistence transparency**: Face descriptors are written to `localStorage` without user opt-in or expiry. Consider a consent prompt and a manual clear option in future iterations. (src/App.tsx:69, 90)

## Risks / Edge Cases
- Multi-face frames only process the first detection while scanning; detection order can vary, producing inconsistent match histories if two faces are present. (src/App.tsx:196)
- Acceptance still allows any 3 matches over 4 seconds, so an early strong match can succeed even if the user leaves the frame later; liveness remains basic. (src/App.tsx:292)
- Relying on `localStorage` means descriptors persist across sessions and are accessible to scripts on the origin; consider how this fits the threat model. (src/App.tsx:69, 90)

## Ratings (1-10)
- Overall: 8/10
- Codebase: 7/10
- UI/UX: 8/10
- Reliability: 7/10
- Maintainability: 7/10
- Performance: 6/10
- Accessibility: 7/10
- Security/Privacy: 4/10

## UI Notes
- Polished dark theme with clear primary actions; status pill and scan overlay give immediate feedback.
- Assistive labels were added for icon buttons and inputs; consider visible labels for the name field to aid first-time users.

## Code Quality Notes
- Good use of refs to avoid stale state in async detection loops, and cleanup of intervals/timeouts is thorough.
- Centralized logic in `App.tsx` remains readable but will become harder to extend; splitting screens/components would improve maintainability.
- The fixed match-history reset bug is a good lesson in preferring refs over state in time-sensitive loops; add tests to lock it in.

## Testing
- No automated tests found.

## Scope
- Reviewed: src/App.tsx, src/App.css, src/index.css, src/main.tsx, index.html, package.json
