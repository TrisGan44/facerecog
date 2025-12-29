# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run dev      # Start development server with HMR
npm run build    # TypeScript compile + Vite production build
npm run lint     # Run ESLint
npm run preview  # Preview production build locally
```

## Architecture Overview

This is a browser-based face recognition application built with React + TypeScript + Vite, using face-api.js for ML-powered face detection and recognition.

### Core Technology Stack
- **face-api.js**: TensorFlow.js-based face detection/recognition library
- **react-webcam**: Webcam access component
- **localStorage**: Persists registered face descriptors between sessions

### Application Flow

**Single-Page Architecture** (`src/App.tsx`):
- One persistent webcam instance that never unmounts (avoids detection issues when switching modes)
- Tab-based mode switching between "Daftar" (register) and "Login"
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

**localStorage Race Condition Fix**: Uses `isFirstSaveRender` ref to skip saving on initial mount, preventing empty array from overwriting stored face data on page load.
