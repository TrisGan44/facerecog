# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run build    # TypeScript compile + Vite production build
npm run lint     # Run ESLint
npm run preview  # Preview production build locally
```

Note: User runs dev server manually.

## Architecture Overview

This is a browser-based face recognition application built with React + TypeScript + Vite, using face-api.js for ML-powered face detection and recognition.

### Core Technology Stack
- **face-api.js**: TensorFlow.js-based face detection/recognition library
- **react-webcam**: Webcam access component
- **localStorage**: Persists registered face descriptors between sessions

### Application Flow

**Screen-Based Navigation** (`src/App.tsx`):
- Three screens: `home`, `register`, `login` (controlled by `screen` state)
- Webcam mounts fresh on each screen - detection loop starts via `onUserMedia` callback
- Navigation via `goBack()` which properly cleans up detection loop before switching
- Continuous face detection loop runs at ~200ms intervals

**Face Registration**:
1. User enters name and captures face samples via single capture or burst mode
2. face-api.js extracts 128-dimensional face descriptors
3. Descriptors stored in `people` state and persisted to localStorage

**Face Login**:
1. User initiates 4-second scan
2. Detection loop collects match labels into `matchHistoryRef` during scan
3. After scan, analyzes history - requires 3+ consistent matches to allow login

### Key Implementation Details

**Refs vs State for Detection Loop**: The detection loop uses refs (`scanningRef`, `matchHistoryRef`) instead of state to avoid React closure issues where async callbacks capture stale state values.

**Face Models** (in `public/models/`):
- `ssd_mobilenetv1`: Face detection
- `face_landmark_68`: Facial landmark detection
- `face_recognition`: 128-dim descriptor extraction

**Recognition Threshold**: Set to 0.55 (lower = stricter matching). FaceMatcher returns "unknown" if best match distance exceeds threshold.

## Bug Fixes & Lessons Learned

### 1. localStorage Race Condition
**Bug**: On page load, the save effect ran with empty `people=[]` before localStorage was loaded, overwriting stored face data.
**Fix**: `isFirstSaveRender` ref skips the first render's save operation.

### 2. Detection Loop Not Restarting After Navigation
**Bug**: When navigating home→register→home→login, detection loop kept running with stale `videoRef` from the first screen. The `startDetectionLoop()` guard `if (detectionIntervalRef.current) return` prevented new loop from starting.
**Fix**:
- `stopDetectionLoop()` clears interval, resets `videoRef` to null, clears canvas
- `goBack()` calls `stopDetectionLoop()` before changing screen
- `startDetectionLoop()` now always clears existing interval before starting fresh
- When new screen mounts, `onUserMedia` callback sets fresh `videoRef` and starts new loop

### 3. Login Failing Despite Face Recognition
**Bug**: Face showed as recognized (e.g., "aang 91%") but login still denied. React closure issue - `scanning` state was captured at old value inside `detectFrame` async callback.
**Fix**: Use `scanningRef.current` (ref) instead of `scanning` (state) inside detection loop. Refs don't have closure issues since they're mutable objects.
