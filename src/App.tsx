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

type Mode = 'register' | 'login';

const DETECTION_INTERVAL_MS = 200;
const BURST_INTERVAL_MS = 250;
const MIN_CAPTURE_SCORE = 0.4;
const RECOGNITION_THRESHOLD = 0.55;
const SCAN_DURATION_MS = 4000;

const detectionOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 });

function App() {
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('register');
  const [people, setPeople] = useState<PersonData[]>([]);
  const [nameInput, setNameInput] = useState('');
  const [burstActive, setBurstActive] = useState(false);
  const [liveMatch, setLiveMatch] = useState<string>('No face');
  const [confidence, setConfidence] = useState<number | null>(null);
  const [loggedInUser, setLoggedInUser] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null);
  const [scanProgress, setScanProgress] = useState(0);

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

  // Update matcher when people changes
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

  // Load people from localStorage
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

  // Save people to localStorage
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

  // Load models
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

  const handleUserMedia = () => {
    if (!webcamRef.current?.video) return;
    videoRef.current = webcamRef.current.video;
    startDetectionLoop();
  };

  const startDetectionLoop = () => {
    if (detectionIntervalRef.current) return;
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
        const boxColor = isKnown ? '#00ff88' : '#ff6b6b';
        const label = isKnown ? match.label : 'Unknown';

        const drawBox = new faceapi.draw.DrawBox(detection.detection.box, {
          label: `${label} ${Math.round((1 - match.distance) * 100)}%`,
          boxColor,
          lineWidth: 3,
        });
        drawBox.draw(canvas);

        setLiveMatch(label);
        setConfidence(Math.round((1 - match.distance) * 100));

        // Track match history for login
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

    // Progress animation
    const startTime = Date.now();
    scanProgressRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      setScanProgress(Math.min((elapsed / SCAN_DURATION_MS) * 100, 100));
    }, 50);

    scanTimeoutRef.current = setTimeout(() => {
      if (scanProgressRef.current) clearInterval(scanProgressRef.current);
      setScanProgress(100);

      // Analyze match history
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
    <div className="app-single">
      {/* Loading Modal */}
      {!modelsLoaded && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="spinner" />
            <h3>Loading Models...</h3>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="header">
        <h1 className="logo">FaceID</h1>
        <div className="mode-tabs">
          <button
            className={`tab ${mode === 'register' ? 'tab--active' : ''}`}
            onClick={() => setMode('register')}
          >
            Daftar
          </button>
          <button
            className={`tab ${mode === 'login' ? 'tab--active' : ''}`}
            onClick={() => setMode('login')}
          >
            Login
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {/* Camera - Always visible */}
        <section className="camera-section">
          <div className="camera-container">
            <Webcam
              ref={webcamRef}
              audio={false}
              className="webcam"
              onUserMedia={handleUserMedia}
              videoConstraints={{
                width: 640,
                height: 480,
                facingMode: 'user',
              }}
            />
            <canvas ref={canvasRef} className="canvas-overlay" />

            {/* Scan Progress Overlay */}
            {scanning && (
              <div className="scan-overlay">
                <div className="scan-line" style={{ '--progress': `${scanProgress}%` } as CSSProperties} />
                <div className="scan-text">Scanning... {Math.round(scanProgress)}%</div>
              </div>
            )}
          </div>

          {/* Live Status */}
          <div className="live-status">
            <span className="status-indicator" data-match={liveMatch !== 'No face' && liveMatch !== 'Unknown' && liveMatch !== 'No references'} />
            <span>{liveMatch}</span>
            {confidence !== null && <span className="confidence">{confidence}%</span>}
          </div>
        </section>

        {/* Controls Panel */}
        <section className="controls-section">
          {/* Register Mode */}
          {mode === 'register' && (
            <div className="register-controls">
              <h2>Daftar Wajah Baru</h2>

              <div className="input-group">
                <input
                  type="text"
                  placeholder="Masukkan nama..."
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  className="name-input"
                />
                {currentPersonSamples > 0 && (
                  <span className="sample-count">{currentPersonSamples} samples</span>
                )}
              </div>

              <div className="button-group">
                <button
                  className="btn btn-primary"
                  onClick={captureFace}
                  disabled={!modelsLoaded || !hasName}
                >
                  Capture
                </button>
                <button
                  className={`btn ${burstActive ? 'btn-danger' : 'btn-secondary'}`}
                  onClick={toggleBurst}
                  disabled={!modelsLoaded || !hasName}
                >
                  {burstActive ? 'Stop' : 'Burst'}
                </button>
              </div>

              <div className="stats">
                <span>{people.length} orang</span>
                <span>{totalSamples} samples</span>
              </div>
            </div>
          )}

          {/* Login Mode */}
          {mode === 'login' && (
            <div className="login-controls">
              <h2>Login dengan Wajah</h2>

              {people.length === 0 ? (
                <p className="warning">Belum ada wajah terdaftar. Daftar dulu!</p>
              ) : (
                <>
                  <button
                    className="btn btn-primary btn-large"
                    onClick={startLoginScan}
                    disabled={!modelsLoaded || scanning}
                  >
                    {scanning ? 'Scanning...' : 'Mulai Scan'}
                  </button>

                  {loggedInUser && (
                    <div className="logged-in">
                      <span className="check-icon">✓</span>
                      <span>Logged in: <strong>{loggedInUser}</strong></span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Saved Faces List */}
          <div className="saved-faces">
            <h3>Wajah Tersimpan</h3>
            {people.length === 0 ? (
              <p className="empty">Belum ada</p>
            ) : (
              <ul className="faces-list">
                {people.map((person) => (
                  <li key={person.name} className="face-item">
                    <div>
                      <strong>{person.name}</strong>
                      <span>{person.descriptors.length} samples</span>
                    </div>
                    <button
                      className="btn-delete"
                      onClick={() => deletePerson(person.name)}
                      title="Hapus"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      {/* Login Result Modal */}
      {loginResult && (
        <div className="modal-backdrop">
          <div className={`modal-card ${loginResult.status === 'allowed' ? 'modal--success' : 'modal--error'}`}>
            <div className={`result-icon ${loginResult.status === 'allowed' ? 'icon--success' : 'icon--error'}`}>
              {loginResult.status === 'allowed' ? '✓' : '✗'}
            </div>
            <h3>{loginResult.status === 'allowed' ? 'Berhasil!' : 'Gagal'}</h3>
            <p>
              {loginResult.status === 'allowed'
                ? `Selamat datang, ${loginResult.name}`
                : 'Wajah tidak dikenali'}
            </p>
            <div className="modal-buttons">
              {loginResult.status === 'denied' && (
                <button className="btn btn-primary" onClick={startLoginScan}>
                  Coba Lagi
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setLoginResult(null)}>
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
