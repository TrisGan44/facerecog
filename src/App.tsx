import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as faceapi from 'face-api.js';
import Webcam from 'react-webcam';
import './App.css';

interface PersonData {
  name: string;
  descriptors: Float32Array[];
}

interface LoginResult {
  status: 'allowed' | 'denied';
  name?: string;
}

type Screen = 'home' | 'register' | 'login';

const DETECTION_INTERVAL_MS = 200;
const BURST_INTERVAL_MS = 250;
const MIN_CAPTURE_SCORE = 0.4;
const RECOGNITION_THRESHOLD = 0.55;
const SCAN_DURATION_MS = 4000;

const detectionOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 });

function App() {
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [people, setPeople] = useState<PersonData[]>([]);
  const [nameInput, setNameInput] = useState('');
  const [burstActive, setBurstActive] = useState(false);
  const [liveMatch, setLiveMatch] = useState<string>('No face');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [loggedInUser, setLoggedInUser] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [captureFlash, setCaptureFlash] = useState(false);

  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const matcherRef = useRef<faceapi.FaceMatcher | null>(null);
  const detectionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const burstIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanProgressRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectingRef = useRef(false);
  const nameRef = useRef('');
  const matchHistoryRef = useRef<string[]>([]);
  const isFirstSaveRender = useRef(true);
  const scanningRef = useRef(false);

  useEffect(() => {
    if (people.length === 0) {
      matcherRef.current = null;
      return;
    }
    const labeledDescriptors = people.map(
      (person) => new faceapi.LabeledFaceDescriptors(person.name, person.descriptors)
    );
    matcherRef.current = new faceapi.FaceMatcher(labeledDescriptors, RECOGNITION_THRESHOLD);
  }, [people]);

  useEffect(() => {
    nameRef.current = nameInput;
  }, [nameInput]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('faceRecognition_people');
      if (stored) {
        const parsed = JSON.parse(stored) as Array<{ name: string; descriptors: number[][] }>;
        const loaded: PersonData[] = parsed.map((person) => ({
          name: person.name,
          descriptors: person.descriptors.map((desc) => new Float32Array(desc)),
        }));
        setPeople(loaded);
      }
    } catch (error) {
      console.error('Error loading from localStorage:', error);
    }
  }, []);

  useEffect(() => {
    if (isFirstSaveRender.current) {
      isFirstSaveRender.current = false;
      return;
    }
    try {
      const toStore = people.map((person) => ({
        name: person.name,
        descriptors: person.descriptors.map((desc) => Array.from(desc)),
      }));
      localStorage.setItem('faceRecognition_people', JSON.stringify(toStore));
    } catch (error) {
      console.error('Error saving to localStorage:', error);
    }
  }, [people]);

  useEffect(() => {
    const loadModels = async () => {
      const MODEL_URL = '/models';
      try {
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        setModelsLoaded(true);
      } catch (error) {
        console.error('Error loading models:', error);
      }
    };
    loadModels();

    return () => {
      if (detectionIntervalRef.current) clearInterval(detectionIntervalRef.current);
      if (burstIntervalRef.current) clearInterval(burstIntervalRef.current);
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      if (scanProgressRef.current) clearInterval(scanProgressRef.current);
    };
  }, []);

  const stopDetectionLoop = () => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    // Clear canvas and reset state
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    videoRef.current = null;
    setLiveMatch('No face');
    setConfidence(null);
  };

  const handleUserMedia = () => {
    if (!webcamRef.current?.video) return;
    videoRef.current = webcamRef.current.video;
    startDetectionLoop();
  };

  const startDetectionLoop = () => {
    // Stop existing loop first to ensure fresh start
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    detectionIntervalRef.current = setInterval(() => {
      void detectFrame();
    }, DETECTION_INTERVAL_MS);
  };

  const detectFrame = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !modelsLoaded || detectingRef.current) return;
    if (video.readyState !== 4) return;

    detectingRef.current = true;
    try {
      const displaySize = { width: video.videoWidth, height: video.videoHeight };
      faceapi.matchDimensions(canvas, displaySize);

      const detections = await faceapi
        .detectAllFaces(video, detectionOptions)
        .withFaceLandmarks()
        .withFaceDescriptors();

      const resizedDetections = faceapi.resizeResults(detections, displaySize);
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);

      if (resizedDetections.length === 0) {
        setLiveMatch('No face');
        setConfidence(null);
        matchHistoryRef.current = [];
        return;
      }

      const matcher = matcherRef.current;
      if (!matcher) {
        faceapi.draw.drawDetections(canvas, resizedDetections);
        setLiveMatch('No references');
        setConfidence(null);
        return;
      }

      resizedDetections.forEach((detection) => {
        const match = matcher.findBestMatch(detection.descriptor);
        const isKnown = match.label !== 'unknown';
        const boxColor = isKnown ? '#00ff88' : '#ff4757';

        const drawBox = new faceapi.draw.DrawBox(detection.detection.box, {
          label: `${isKnown ? match.label : 'Unknown'} ${Math.round((1 - match.distance) * 100)}%`,
          boxColor,
          lineWidth: 3,
        });
        drawBox.draw(canvas);

        setLiveMatch(isKnown ? match.label : 'Unknown');
        setConfidence(Math.round((1 - match.distance) * 100));

        if (scanningRef.current) {
          matchHistoryRef.current.push(match.label);
        }
      });
    } catch (error) {
      console.error('Detection error:', error);
    } finally {
      detectingRef.current = false;
    }
  };

  const captureFace = async () => {
    const video = videoRef.current;
    const rawName = nameRef.current.trim();
    if (!video || !modelsLoaded || rawName.length === 0) return;

    const detection = await faceapi
      .detectSingleFace(video, detectionOptions)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection || detection.detection.score < MIN_CAPTURE_SCORE) return;

    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 150);

    setPeople((prev) => {
      const existing = prev.find((person) => person.name === rawName);
      if (existing) {
        return prev.map((person) =>
          person.name === rawName
            ? { ...person, descriptors: [...person.descriptors, detection.descriptor] }
            : person
        );
      }
      return [...prev, { name: rawName, descriptors: [detection.descriptor] }];
    });
  };

  const toggleBurst = () => {
    if (burstActive) {
      if (burstIntervalRef.current) {
        clearInterval(burstIntervalRef.current);
        burstIntervalRef.current = null;
      }
      setBurstActive(false);
    } else {
      setBurstActive(true);
      void captureFace();
      burstIntervalRef.current = setInterval(() => {
        void captureFace();
      }, BURST_INTERVAL_MS);
    }
  };

  const startLoginScan = () => {
    if (!modelsLoaded || scanning || people.length === 0) return;

    setScanning(true);
    scanningRef.current = true;
    setLoginResult(null);
    setScanProgress(0);
    matchHistoryRef.current = [];

    const startTime = Date.now();
    scanProgressRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      setScanProgress(Math.min((elapsed / SCAN_DURATION_MS) * 100, 100));
    }, 50);

    scanTimeoutRef.current = setTimeout(() => {
      if (scanProgressRef.current) clearInterval(scanProgressRef.current);
      setScanProgress(100);

      const history = matchHistoryRef.current;
      const counts: Record<string, number> = {};
      for (const label of history) {
        if (label !== 'unknown') {
          counts[label] = (counts[label] ?? 0) + 1;
        }
      }

      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0 && sorted[0][1] >= 3) {
        const name = sorted[0][0];
        setLoggedInUser(name);
        setLoginResult({ status: 'allowed', name });
      } else {
        setLoginResult({ status: 'denied' });
      }

      setScanning(false);
      scanningRef.current = false;
    }, SCAN_DURATION_MS);
  };

  const deletePerson = (name: string) => {
    setPeople((prev) => prev.filter((p) => p.name !== name));
  };

  const goBack = () => {
    // Stop burst capture if active
    if (burstActive) {
      if (burstIntervalRef.current) {
        clearInterval(burstIntervalRef.current);
        burstIntervalRef.current = null;
      }
      setBurstActive(false);
    }
    // Stop scan if in progress
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    if (scanProgressRef.current) {
      clearInterval(scanProgressRef.current);
      scanProgressRef.current = null;
    }
    setScanning(false);
    scanningRef.current = false;
    // Stop detection loop - this clears videoRef and resets state
    // Next screen will get fresh detection loop when webcam mounts
    stopDetectionLoop();
    setScreen('home');
    setLoginResult(null);
  };

  const totalSamples = useMemo(
    () => people.reduce((sum, person) => sum + person.descriptors.length, 0),
    [people]
  );

  const currentPersonSamples = useMemo(() => {
    const label = nameInput.trim();
    if (!label) return 0;
    return people.find((person) => person.name === label)?.descriptors.length ?? 0;
  }, [nameInput, people]);

  const hasName = nameInput.trim().length > 0;

  return (
    <div className="app">
      {/* Loading */}
      {!modelsLoaded && (
        <div className="overlay">
          <div className="loader-card">
            <div className="loader-spinner" />
            <p>Loading AI Models...</p>
          </div>
        </div>
      )}

      {/* Home Screen */}
      {screen === 'home' && (
        <div className="home-screen">
          <div className="brand">
            <div className="brand-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2v-4M9 21H5a2 2 0 01-2-2v-4m0 0h18M3 9h18" />
              </svg>
            </div>
            <h1>FaceAuth</h1>
            <p>Secure face recognition system</p>
          </div>

          <div className="home-buttons">
            <button className="home-btn home-btn--primary" onClick={() => setScreen('register')}>
              <span className="home-btn__icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M19 8v6M22 11h-6" />
                </svg>
              </span>
              <span className="home-btn__text">
                <strong>Register</strong>
                <small>Add new face</small>
              </span>
            </button>

            <button className="home-btn home-btn--secondary" onClick={() => setScreen('login')}>
              <span className="home-btn__icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" />
                </svg>
              </span>
              <span className="home-btn__text">
                <strong>Login</strong>
                <small>Verify identity</small>
              </span>
            </button>
          </div>

          {people.length > 0 && (
            <div className="home-stats">
              <span>{people.length} registered {people.length === 1 ? 'user' : 'users'}</span>
              <span className="dot" />
              <span>{totalSamples} samples</span>
            </div>
          )}
        </div>
      )}

      {/* Register Screen */}
      {screen === 'register' && (
        <div className="screen">
          <button className="back-btn" onClick={goBack}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back
          </button>

          <h2 className="screen-title">Register Face</h2>

          <div className="camera-wrapper">
            <div className={`camera ${captureFlash ? 'camera--flash' : ''}`}>
              <Webcam
                ref={webcamRef}
                audio={false}
                className="camera__video"
                onUserMedia={handleUserMedia}
                videoConstraints={{ width: 480, height: 360, facingMode: 'user' }}
              />
              <canvas ref={canvasRef} className="camera__canvas" />
              <div className="camera__frame" />
            </div>
          </div>

          <div className="form-section">
            <div className="input-wrapper">
              <input
                type="text"
                placeholder="Enter your name"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                className="text-input"
              />
              {currentPersonSamples > 0 && (
                <span className="input-badge">{currentPersonSamples} captured</span>
              )}
            </div>

            <div className="action-buttons">
              <button
                className="action-btn action-btn--primary"
                onClick={captureFace}
                disabled={!modelsLoaded || !hasName}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Capture
              </button>
              <button
                className={`action-btn ${burstActive ? 'action-btn--danger' : 'action-btn--secondary'}`}
                onClick={toggleBurst}
                disabled={!modelsLoaded || !hasName}
              >
                {burstActive ? (
                  <>
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                    Stop
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="7" height="7" />
                      <rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" />
                      <rect x="3" y="14" width="7" height="7" />
                    </svg>
                    Burst
                  </>
                )}
              </button>
            </div>
          </div>

          {people.length > 0 && (
            <div className="people-list">
              <h3>Registered Faces</h3>
              <ul>
                {people.map((person) => (
                  <li key={person.name}>
                    <div className="person-info">
                      <span className="person-avatar">{person.name.charAt(0).toUpperCase()}</span>
                      <div>
                        <strong>{person.name}</strong>
                        <small>{person.descriptors.length} samples</small>
                      </div>
                    </div>
                    <button className="delete-btn" onClick={() => deletePerson(person.name)}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Login Screen */}
      {screen === 'login' && (
        <div className="screen">
          <button className="back-btn" onClick={goBack}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back
          </button>

          <h2 className="screen-title">Face Login</h2>

          <div className="camera-wrapper">
            <div className={`camera ${scanning ? 'camera--scanning' : ''}`}>
              <Webcam
                ref={webcamRef}
                audio={false}
                className="camera__video"
                onUserMedia={handleUserMedia}
                videoConstraints={{ width: 480, height: 360, facingMode: 'user' }}
              />
              <canvas ref={canvasRef} className="camera__canvas" />
              {scanning && (
                <div className="scan-overlay">
                  <div className="scan-line" style={{ '--progress': `${scanProgress}%` } as CSSProperties} />
                </div>
              )}
              <div className="camera__frame camera__frame--scan" />
            </div>
          </div>

          <div className="status-bar">
            <span className={`status-dot ${liveMatch !== 'No face' && liveMatch !== 'Unknown' && liveMatch !== 'No references' ? 'status-dot--success' : ''}`} />
            <span className="status-text">{liveMatch}</span>
            {confidence !== null && <span className="status-confidence">{confidence}%</span>}
          </div>

          {people.length === 0 ? (
            <div className="warning-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01" />
              </svg>
              <p>No registered faces. Please register first.</p>
            </div>
          ) : (
            <button
              className={`scan-btn ${scanning ? 'scan-btn--scanning' : ''}`}
              onClick={startLoginScan}
              disabled={!modelsLoaded || scanning}
            >
              {scanning ? (
                <>
                  <div className="scan-btn__spinner" />
                  Scanning... {Math.round(scanProgress)}%
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 19a2 2 0 01-2 2h-3v-2h3v-3h2zM1 19a2 2 0 002 2h3v-2H3v-3H1zM23 5a2 2 0 00-2-2h-3v2h3v3h2zM1 5a2 2 0 012-2h3v2H3v3H1z" />
                  </svg>
                  Start Scan
                </>
              )}
            </button>
          )}

          {loggedInUser && !loginResult && (
            <div className="logged-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                <path d="M22 4L12 14.01l-3-3" />
              </svg>
              Logged in as <strong>{loggedInUser}</strong>
            </div>
          )}
        </div>
      )}

      {/* Result Modal */}
      {loginResult && (
        <div className="overlay">
          <div className={`result-card ${loginResult.status === 'allowed' ? 'result-card--success' : 'result-card--error'}`}>
            <div className="result-icon">
              {loginResult.status === 'allowed' ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                  <path d="M22 4L12 14.01l-3-3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M15 9l-6 6M9 9l6 6" />
                </svg>
              )}
            </div>
            <h3>{loginResult.status === 'allowed' ? 'Welcome!' : 'Access Denied'}</h3>
            <p>
              {loginResult.status === 'allowed'
                ? `Hello, ${loginResult.name}`
                : 'Face not recognized'}
            </p>
            <div className="result-buttons">
              {loginResult.status === 'denied' && (
                <button className="result-btn result-btn--primary" onClick={startLoginScan}>
                  Try Again
                </button>
              )}
              <button className="result-btn result-btn--secondary" onClick={() => setLoginResult(null)}>
                {loginResult.status === 'allowed' ? 'Continue' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
