import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as faceapi from 'face-api.js';
import Webcam from 'react-webcam';
import './App.css';

interface PersonData {
  name: string;
  descriptors: Float32Array[];
}

interface MatchState {
  label: string;
  distance: number | null;
}

interface LoginResult {
  status: 'allowed' | 'denied';
  name?: string;
}

type View = 'landing' | 'register' | 'login';
type ScanState = 'idle' | 'scanning' | 'done';

const DETECTION_INTERVAL_MS = 220;
const BURST_INTERVAL_MS = 300;
const MIN_CAPTURE_SCORE = 0.6;
const RECOGNITION_THRESHOLD = 0.5;
const STABLE_WINDOW = 6;
const STABLE_MIN = 4;
const SCAN_MIN_MS = 3000;
const SCAN_MAX_MS = 5000;

const detectionOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 });

const resolveViewFromHash = (): View => {
  if (typeof window === 'undefined') return 'landing';
  const hash = window.location.hash.replace('#', '');
  if (hash.startsWith('/register')) return 'register';
  if (hash.startsWith('/login')) return 'login';
  return 'landing';
};

function App() {
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [highVisibility, setHighVisibility] = useState(false);
  const [view, setView] = useState<View>(() => resolveViewFromHash());
  const [people, setPeople] = useState<PersonData[]>([]);
  const [nameInput, setNameInput] = useState('');
  const [burstActive, setBurstActive] = useState(false);
  const [liveMatch, setLiveMatch] = useState<MatchState>({
    label: 'No face',
    distance: null,
  });
  const [stableMatch, setStableMatch] = useState<MatchState>({
    label: 'Unverified',
    distance: null,
  });
  const [loggedInUser, setLoggedInUser] = useState<string | null>(null);
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanDuration, setScanDuration] = useState(3800);
  const [scanSequence, setScanSequence] = useState(0);
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null);

  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const matcherRef = useRef<faceapi.FaceMatcher | null>(null);
  const detectionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const burstIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectingRef = useRef(false);
  const matchHistoryRef = useRef<string[]>([]);
  const nameRef = useRef('');
  const stableMatchRef = useRef<MatchState>({
    label: 'Unverified',
    distance: null,
  });

  useEffect(() => {
    document.body.classList.toggle('is-bright-mode', highVisibility);
  }, [highVisibility]);

  useEffect(() => {
    stableMatchRef.current = stableMatch;
  }, [stableMatch]);

  useEffect(() => {
    const handleHashChange = () => {
      setView(resolveViewFromHash());
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

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
      stopDetectionLoop();
      stopBurstCapture(false);
      clearScanTimer();
    };
  }, []);

  useEffect(() => {
    if (view === 'landing') {
      stopDetectionLoop();
      stopBurstCapture();
      setLoggedInUser(null);
    }

    if (view !== 'login') {
      resetScanState();
      setLoginResult(null);
    }

    if (view !== 'register') {
      stopBurstCapture();
    }

    if (view === 'login') {
      matchHistoryRef.current = [];
      setStableMatch({ label: 'Unverified', distance: null });
      setLiveMatch({ label: 'No face', distance: null });
    }
  }, [view]);

  const navigate = (target: View) => {
    const hash = target === 'landing' ? '#/' : `#/${target}`;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      setView(target);
    }
  };

  const toggleVisibilityMode = () => {
    setHighVisibility((prev) => !prev);
  };

  const startDetectionLoop = () => {
    if (detectionIntervalRef.current) return;
    detectionIntervalRef.current = setInterval(() => {
      void detectFrame();
    }, DETECTION_INTERVAL_MS);
  };

  const stopDetectionLoop = () => {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const clearScanTimer = () => {
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
  };

  const resetScanState = () => {
    clearScanTimer();
    setScanState('idle');
  };

  const handleUserMedia = () => {
    if (!webcamRef.current?.video) return;
    videoRef.current = webcamRef.current.video;
    startDetectionLoop();
    if (view === 'login' && scanState === 'idle') {
      startLoginScan();
    }
  };

  const updateStableMatch = (label: string, distance: number | null) => {
    const history = matchHistoryRef.current;
    history.push(label);
    if (history.length > STABLE_WINDOW) history.shift();

    const counts: Record<string, number> = {};
    for (const entry of history) {
      counts[entry] = (counts[entry] ?? 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return;

    const [topLabel, topCount] = sorted[0];
    if (topLabel === 'unknown' || topLabel === 'No face' || topLabel === 'No references') {
      setStableMatch({ label: 'Unverified', distance: null });
      return;
    }

    if (topCount >= STABLE_MIN) {
      const stableDistance = topLabel === label ? distance : null;
      setStableMatch({ label: topLabel, distance: stableDistance });
    }
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
        setLiveMatch({ label: 'No face', distance: null });
        updateStableMatch('No face', null);
        return;
      }

      const matcher = matcherRef.current;
      if (!matcher) {
        faceapi.draw.drawDetections(canvas, resizedDetections);
        setLiveMatch({ label: 'No references', distance: null });
        updateStableMatch('No references', null);
        return;
      }

      let bestLabel = 'unknown';
      let bestDistance = Number.POSITIVE_INFINITY;

      resizedDetections.forEach((detection, index) => {
        const match = matcher.findBestMatch(detections[index].descriptor);
        const isKnown = match.label !== 'unknown';
        const boxColor = isKnown ? '#2bd4c6' : '#f3b45f';
        const label = isKnown ? match.label : 'Unknown';

        const drawBox = new faceapi.draw.DrawBox(detection.detection.box, {
          label,
          boxColor,
          lineWidth: 2,
        });
        drawBox.draw(canvas);

        if (match.distance < bestDistance) {
          bestDistance = match.distance;
          bestLabel = match.label;
        }
      });

      const liveDistance = Number.isFinite(bestDistance) ? bestDistance : null;
      setLiveMatch({ label: bestLabel, distance: liveDistance });
      updateStableMatch(bestLabel, liveDistance);
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

  const startBurstCapture = () => {
    if (burstIntervalRef.current) return;
    setBurstActive(true);
    void captureFace();
    burstIntervalRef.current = setInterval(() => {
      void captureFace();
    }, BURST_INTERVAL_MS);
  };

  const stopBurstCapture = (updateState = true) => {
    if (burstIntervalRef.current) {
      clearInterval(burstIntervalRef.current);
      burstIntervalRef.current = null;
    }
    if (updateState) {
      setBurstActive(false);
    }
  };

  const toggleBurst = () => {
    if (burstActive) {
      stopBurstCapture();
    } else {
      startBurstCapture();
    }
  };

  const finalizeLoginScan = () => {
    const label = stableMatchRef.current.label;
    if (label && label !== 'Unverified') {
      setLoggedInUser(label);
      setLoginResult({ status: 'allowed', name: label });
    } else {
      setLoginResult({ status: 'denied' });
    }
    setScanState('done');
  };

  const startLoginScan = () => {
    if (!modelsLoaded || scanState === 'scanning') return;
    clearScanTimer();
    const duration = Math.floor(SCAN_MIN_MS + Math.random() * (SCAN_MAX_MS - SCAN_MIN_MS));
    setScanDuration(duration);
    setScanSequence((prev) => prev + 1);
    setScanState('scanning');
    setLoginResult(null);
    matchHistoryRef.current = [];
    setStableMatch({ label: 'Unverified', distance: null });
    scanTimeoutRef.current = setTimeout(() => {
      finalizeLoginScan();
    }, duration);
  };

  const dismissLoginResult = () => {
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

  const canLogin = stableMatch.label !== 'Unverified';

  const formatLabel = (label: string) => {
    if (label === 'unknown') return 'Unknown';
    if (label === 'No face') return 'No face';
    if (label === 'No references') return 'No references';
    if (label === 'Unverified') return 'Unverified';
    return label;
  };

  const confidence =
    liveMatch.distance !== null
      ? Math.max(0, Math.round((1 - liveMatch.distance) * 100))
      : null;

  const scanStatus =
    scanState === 'scanning' ? 'Scanning' : scanState === 'done' ? 'Complete' : 'Ready';

  const scanActionLabel =
    scanState === 'scanning' ? 'Scanning...' : scanState === 'done' ? 'Scan again' : 'Start scan';

  const visibilityToggle = (
    <button
      type="button"
      className={`btn btn-ghost visibility-toggle ${highVisibility ? 'is-active' : ''}`}
      onClick={toggleVisibilityMode}
    >
      {highVisibility ? 'Mode terang aktif' : 'Mode terang'}
    </button>
  );

  return (
    <div className={`app page-${view} ${highVisibility ? 'is-bright' : ''}`}>
      {!modelsLoaded && (
        <div className="loading">
          <div className="spinner" />
          <p>Loading recognition models...</p>
        </div>
      )}

      {view === 'landing' && (
        <main className="landing-simple">
          <div className="landing-simple__badge">VisageID</div>
          <h1 className="landing-simple__title">Pilih tindakan dengan cepat.</h1>
          <p className="landing-simple__subtitle">
            Cukup dua tombol besar untuk bergerak: daftar wajah baru atau langsung login. Aktifkan
            mode terang jika tampilan terlalu gelap.
          </p>

          <div className="landing-simple__actions">
            <button className="btn btn-cta" onClick={() => navigate('register')}>
              Daftar wajah
              <span className="btn-cta__hint">Bangun profil biometrik kamu</span>
            </button>
            <button className="btn btn-cta btn-cta--ghost" onClick={() => navigate('login')}>
              Login
              <span className="btn-cta__hint">Masuk dengan pemindaian cepat</span>
            </button>
          </div>

          <div className="landing-simple__assist">
            <div>
              <div className="assist-title">Sulit melihat tombol?</div>
              <p className="assist-copy">Nyalakan mode terang agar area aksi lebih mudah dikenali.</p>
            </div>
            {visibilityToggle}
          </div>
        </main>
      )}

      {view === 'register' && (
        <>
          <header className="register-nav">
            <div className="register-brand">
              <div className="register-mark">RG</div>
              <div>
                <div className="register-title">Registration Studio</div>
                <div className="register-subtitle">Capture & enrollment</div>
              </div>
            </div>
            <div className="register-actions">
              <button className="btn btn-ghost" onClick={() => navigate('landing')}>
                Beranda
              </button>
              <button className="btn btn-secondary" onClick={() => navigate('login')}>
                Login
              </button>
              {visibilityToggle}
            </div>
          </header>

          <main className="register-layout">
            <section className="panel register-panel">
              <span className="register-tag">Registration</span>
              <h1>Daftarkan wajah untuk akses cepat.</h1>
              <p>
                Capture beberapa sudut wajah agar akurasi login makin tinggi. Burst capture kini
                lebih cepat untuk memperbanyak sample.
              </p>

              <div className="register-form">
                <label className="field">
                  <span>Reference name</span>
                  <input
                    type="text"
                    placeholder="Type once, keep it"
                    value={nameInput}
                    onChange={(event) => setNameInput(event.target.value)}
                  />
                  <span className="field-hint">Samples saved: {currentPersonSamples}</span>
                </label>
              </div>

              <div className="register-action-row">
                <button
                  className="btn btn-primary"
                  onClick={captureFace}
                  disabled={!modelsLoaded || !hasName}
                >
                  Add reference frame
                </button>
                <button
                  className={`btn btn-secondary ${burstActive ? 'btn-secondary--active' : ''}`}
                  onClick={toggleBurst}
                  disabled={!modelsLoaded || !hasName}
                >
                  {burstActive ? 'Stop burst capture' : 'Start burst capture'}
                </button>
              </div>

              <div className="register-metrics">
                <div className="metric-chip">Profiles {people.length}</div>
                <div className="metric-chip">Samples {totalSamples}</div>
                <div className={`metric-chip ${modelsLoaded ? 'metric-chip--on' : ''}`}>
                  Models {modelsLoaded ? 'online' : 'loading'}
                </div>
                <div className={`metric-chip ${burstActive ? 'metric-chip--on' : ''}`}>
                  Burst {burstActive ? 'on' : 'off'}
                </div>
              </div>
            </section>

            <section className="panel register-capture">
              <div className="register-capture-header">
                <div>
                  <h2>Capture Stage</h2>
                  <p>Stay centered and keep lighting consistent.</p>
                </div>
                <div className="chip">Interval {BURST_INTERVAL_MS}ms</div>
              </div>

              <div className="camera-shell camera-shell--register">
                <Webcam
                  ref={webcamRef}
                  audio={false}
                  className="webcam-video"
                  screenshotFormat="image/jpeg"
                  onUserMedia={handleUserMedia}
                  videoConstraints={{
                    width: 960,
                    height: 720,
                    facingMode: 'user',
                  }}
                />
                <canvas ref={canvasRef} className="overlay-canvas" />
                <div className="frame-guide">
                  <div className="frame-guide__glow" />
                </div>
              </div>

              <div className="register-capture-foot">
                <span className="status-label">Tip</span>
                <span className="status-value">Move slowly to capture multiple angles.</span>
              </div>
            </section>

            <section className="panel register-vault">
              <div className="register-vault-header">
                <div>
                  <h2>Reference Vault</h2>
                  <p>Each profile stores multiple descriptors for higher precision.</p>
                </div>
                <div className="chip">{totalSamples} total frames</div>
              </div>

              <div className="vault-list">
                {people.length === 0 ? (
                  <div className="empty-state">No references saved yet.</div>
                ) : (
                  people.map((person) => (
                    <div className="vault-item" key={person.name}>
                      <div>
                        <div className="vault-name">{person.name}</div>
                        <div className="vault-meta">{person.descriptors.length} samples</div>
                      </div>
                      <div className="vault-pill">Active</div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </main>
        </>
      )}

      {view === 'login' && (
        <>
          <header className="login-nav">
            <div className="login-brand">
              <div className="login-title">Access Terminal</div>
              <div className="login-subtitle">Face recognition login</div>
            </div>
            <div className="login-actions">
              <button className="btn btn-ghost" onClick={() => navigate('landing')}>
                Beranda
              </button>
              <button className="btn btn-secondary" onClick={() => navigate('register')}>
                Daftar
              </button>
              {visibilityToggle}
            </div>
          </header>

          <main className="login-layout">
            <section className="panel login-scan">
              <div className="login-scan-header">
                <div>
                  <span className="login-tag">Face Login</span>
                  <h2>Scan wajah 3-5 detik</h2>
                  <p>Hold steady while the scanner verifies your identity.</p>
                </div>
                <div className={`chip ${scanState === 'scanning' ? 'chip--active' : ''}`}>
                  {scanStatus}
                </div>
              </div>

              {people.length === 0 && (
                <div className="notice">No references stored yet. Please register first.</div>
              )}

              <div className="camera-shell camera-shell--login">
                <Webcam
                  ref={webcamRef}
                  audio={false}
                  className="webcam-video"
                  screenshotFormat="image/jpeg"
                  onUserMedia={handleUserMedia}
                  videoConstraints={{
                    width: 960,
                    height: 720,
                    facingMode: 'user',
                  }}
                />
                <canvas ref={canvasRef} className="overlay-canvas" />
                <div className="scan-frame" />
                {scanState === 'scanning' && (
                  <div
                    key={scanSequence}
                    className="scan-overlay"
                    style={{ '--scan-duration': `${scanDuration}ms` } as CSSProperties}
                  >
                    <div className="scan-beam" />
                    <div className="scan-panel">
                      <span className="scan-title">Scanning face</span>
                      <span className="scan-subtitle">Hold steady for verification</span>
                      <div className="scan-progress" />
                    </div>
                  </div>
                )}
              </div>

              <div className="login-scan-actions">
                <button
                  className="btn btn-primary"
                  onClick={startLoginScan}
                  disabled={!modelsLoaded || scanState === 'scanning'}
                >
                  {scanActionLabel}
                </button>
                <button className="btn btn-secondary" onClick={() => navigate('register')}>
                  Daftar baru
                </button>
              </div>
            </section>

            <aside className="panel login-console">
              <div className="login-console-header">
                <div>
                  <span className="login-tag">System Console</span>
                  <h3>Access Status</h3>
                  <p>Verification updates in real time.</p>
                </div>
                <div className={`status-dot ${canLogin ? 'status-dot--ready' : ''}`} />
              </div>

              <div className="status-panel">
                <div className="status-row">
                  <span className="status-label">Scan status</span>
                  <span className="status-value">{scanStatus}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Live feed</span>
                  <span className="status-value">{formatLabel(liveMatch.label)}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Confidence</span>
                  <span className="status-value">{confidence !== null ? `${confidence}%` : '--'}</span>
                </div>
                <div className="status-row">
                  <span className="status-label">Verified</span>
                  <span className="status-value">{formatLabel(stableMatch.label)}</span>
                </div>
              </div>

              <div className="login-result">
                <span className="status-label">Last result</span>
                <strong>
                  {loginResult
                    ? loginResult.status === 'allowed'
                      ? `Allowed${loginResult.name ? ` - ${loginResult.name}` : ''}`
                      : 'Not allowed'
                    : 'Pending'}
                </strong>
              </div>

              <div className="login-result">
                <span className="status-label">Logged in user</span>
                <strong>{loggedInUser ?? 'Not logged in'}</strong>
              </div>
            </aside>
          </main>
        </>
      )}

      {loginResult && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div
            className={`modal-card ${
              loginResult.status === 'allowed' ? 'modal-card--allowed' : 'modal-card--denied'
            }`}
          >
            <div
              className={`result-icon ${
                loginResult.status === 'allowed' ? 'result-icon--allowed' : 'result-icon--denied'
              }`}
            />
            <div
              className={`result-badge ${
                loginResult.status === 'allowed' ? 'result-badge--allowed' : 'result-badge--denied'
              }`}
            >
              {loginResult.status === 'allowed' ? 'Allowed' : 'Not allowed'}
            </div>
            <h3>{loginResult.status === 'allowed' ? 'Access granted' : 'Access denied'}</h3>
            <p>
              {loginResult.status === 'allowed'
                ? `Welcome, ${loginResult.name ?? 'User'}`
                : 'Face not recognized. Please try again.'}
            </p>
            <div className="modal-actions">
              {loginResult.status === 'denied' && (
                <button className="btn btn-primary" onClick={startLoginScan}>
                  Try again
                </button>
              )}
              <button className="btn btn-secondary" onClick={dismissLoginResult}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
