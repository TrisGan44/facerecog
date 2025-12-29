# Review

## Findings
- Low: `startLoginScan` can be triggered twice on rapid double-click before `scanning` state updates, creating overlapping intervals/timeouts and mixed match history. Consider guarding with `scanningRef.current`. (src/App.tsx:272, src/App.tsx:282, src/App.tsx:288)

## Risks / Edge Cases
- Multi-face scans only process the first detection; detection order can change frame-to-frame, leading to inconsistent results if two faces are present. (src/App.tsx:196)
- Scan acceptance is based on any 3 matches over 4 seconds, so a brief early match can succeed even if the face disappears later; may be acceptable but is not strict liveness. (src/App.tsx:292)
- Biometric descriptors are stored in localStorage, accessible to any script on the origin and persisted without explicit consent UI. (src/App.tsx:69, src/App.tsx:90)

## Ratings (1-10)
- Overall: 8/10
- Codebase: 7/10
- UI/UX: 8/10
- Reliability: 7/10
- Maintainability: 7/10
- Performance: 6/10
- Accessibility: 6/10
- Security/Privacy: 4/10

## UI Notes
- Polished dark theme, strong hierarchy, and clear primary actions.
- Scan overlay and status pill provide immediate feedback.
- The UI now provides clearer labels for assistive tech; consider adding visible labels for the name input if you want non-placeholder guidance.

## Code Quality Notes
- Good use of refs to avoid stale state in async detection loops.
- Cleanup of intervals/timeouts is thorough.
- Centralized logic in `App.tsx` is readable but will be harder to extend; consider splitting into screen components when features grow.

## Testing
- No automated tests found.

## Scope
- Reviewed: src/App.tsx, src/App.css, src/index.css, src/main.tsx, index.html, package.json
