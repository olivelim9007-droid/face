import {
  FilesetResolver,
  FaceLandmarker,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3";

const video = document.getElementById("camera");
const overlay = document.getElementById("camera-overlay");
const statusEl = document.getElementById("camera-status");
const fallbackImg = document.querySelector(".camera-fallback");
const startBtn = document.getElementById("start-scan");

/** @type {FaceLandmarker} */
let faceLandmarker = null;
let runningMode = "VIDEO";
let lastVideoTime = -1;
let results = undefined;
let webcamRunning = false;

const PALETTE = {
  cyan: "rgba(0, 207, 255, 0.95)",
  cyanSoft: "rgba(0, 207, 255, 0.22)",
  blue: "rgba(77, 139, 255, 0.95)",
  violet: "rgba(162, 85, 248, 0.92)",
  pink: "rgba(233, 21, 171, 0.85)",
};

// 피부 트래킹 상태 (실제 데이터 or 느낌용 시뮬레이션)
const skin = {
  hydration: 0.65,
  oil: 0.28,
  pores: 0.4,
  redness: 0.15,
  type: "중성",       // 건조 / 지성 / 복합 / 중성
  today: "보통",      // 오늘 피부: 좋아요 / 보통 / 건조해요 / 번들거려요
  lastAt: 0,
  bufCanvas: null,
  bufCtx: null,
};

// Application state
let state = "idle"; // idle -> detecting -> scanning -> done
let scanStartAt = 0;
const scanDurationMs = 3000;
let showScanBeam = false; // 진단 하기 버튼 눌렀을 때만 true
let resultNavigated = false; // 스캔 완료 후 결과 페이지 이동 한 번만
let fallbackLoopActive = false; // 카메라 없을 때 스캔 폴백 루프

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function setStatus(message) {
  if (!statusEl) return;
  if (!message) {
    statusEl.textContent = "";
    statusEl.classList.remove("is-visible");
  } else {
    statusEl.textContent = message;
    statusEl.classList.add("is-visible");
  }
}

async function createFaceLandmarker() {
  if (!window.isSecureContext) {
    setStatus("HTTPS 또는 localhost에서 실행해 주세요.");
    return;
  }

  setStatus("AI 모델 로딩 중...");
  try {
    const filesetResolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
    );
    const options = {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU"
      },
      outputFaceBlendshapes: true,
      runningMode: runningMode,
      numFaces: 1,
      minFaceDetectionConfidence: 0.4,
      minFacePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4
    };
    try {
      faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, options);
    } catch (gpuErr) {
      console.warn("GPU 실패, CPU로 시도:", gpuErr);
      options.baseOptions.delegate = "CPU";
      faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, options);
    }
    setStatus("준비 완료");
    setTimeout(() => setStatus(""), 2000);

    // Auto start if ready
    if (video && !webcamRunning) {
      enableCam();
    }
  } catch (e) {
    setStatus(`모델 로드 실패: ${e.message}`);
    console.error(e);
  }
}

function hasGetUserMedia() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function enableCam() {
  if (!faceLandmarker) return;
  if (webcamRunning) {
    webcamRunning = false;
    return;
  }

  // 9:16 세로 비율로 요청 (일부 기기는 가로만 지원할 수 있음)
  const constraints = {
    video: {
      facingMode: "user",
      width: { ideal: 720 },
      height: { ideal: 1280 }
    }
  };

  navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
    video.srcObject = stream;
    video.addEventListener("loadeddata", predictWebcam);
    webcamRunning = true;

    // Hide fallback
    if (fallbackImg) fallbackImg.classList.add("is-hidden");
    if (video) video.classList.remove("is-hidden");
    if (overlay) overlay.classList.remove("is-hidden");
    // 스캔은 '진단 하기' 버튼을 눌렀을 때만 시작 (state는 버튼에서 detecting으로 변경)
  }).catch((err) => {
    setStatus("카메라 권한이 필요합니다.");
    console.error(err);
  });
}

function getOverlaySize() {
  if (!overlay) return { w: 375, h: 812 };
  return { w: overlay.width, h: overlay.height };
}

async function predictWebcam() {
  const canvasCtx = overlay.getContext("2d");

  // 캔버스는 영상 해상도, 표시는 컨테이너 전체 채움 (cover)
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    if (overlay.width !== video.videoWidth) {
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
    }
    const containerW = video.clientWidth || 375;
    const containerH = video.clientHeight || 812;
    overlay.style.width = containerW + "px";
    overlay.style.height = containerH + "px";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.transform = "none";
  }

  // Run detection only when video has a new frame and is playable
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && faceLandmarker) {
    if (lastVideoTime !== video.currentTime) {
      lastVideoTime = video.currentTime;
      try {
        const timestampMs = Math.round(video.currentTime * 1000);
        results = faceLandmarker.detectForVideo(video, timestampMs);
      } catch (err) {
        console.warn("Face detection frame error:", err);
      }
    }
  }

  // Clear
  canvasCtx.clearRect(0, 0, overlay.width, overlay.height);

  // Drawing params
  const now = performance.now();
  const t = now;
  // State machine logic
  let progress01 = 0;
  if (state === "detecting") {
    if (results && results.faceLandmarks && results.faceLandmarks.length > 0) {
      state = "scanning";
      scanStartAt = now;
    }
  } else if (state === "scanning") {
    progress01 = clamp01((now - scanStartAt) / scanDurationMs);
    if (progress01 >= 1) {
      state = "done";
      if (!resultNavigated) {
        resultNavigated = true;
        const base = Math.min(100, Math.max(0, Math.round(skin.hydration * 40 + skin.oil * 30 + 30)));
        const score = Math.min(100, Math.max(0, base + Math.floor(Math.random() * 21) - 10));
        setTimeout(() => {
          openResultModal(score);
        }, 800);
      }
    } else if (!results || results.faceLandmarks.length === 0) {
      state = "detecting";
    }
  } else if (state === "done") {
    progress01 = 1;
  }

  // Draw cosmetic grid
  drawGrid(canvasCtx, overlay.width, overlay.height, t);

  if (results && results.faceLandmarks) {
    for (const landmarks of results.faceLandmarks) {
      drawRealMesh(canvasCtx, landmarks, t, progress01);
      drawRealLandmarks(canvasCtx, landmarks, t, progress01);
      drawBoundingBox(canvasCtx, landmarks, t, progress01);

      // Analyze skin (visual only, using video frame)
      analyzeSkin(video, overlay, skin, now);

      // Data readout
      const box = getBoundingBox(landmarks, overlay.width, overlay.height);
      drawDataReadout(canvasCtx, box, t, progress01, true);
    }
  } else {
    // No face
    drawDataReadout(canvasCtx, { x: 20, y: 50, w: 0, h: 0 }, t, 0, false);
    drawScanBeam(canvasCtx, null, overlay.width, overlay.height, t, 0);
  }

  // Glitch effect
  drawGlitch(canvasCtx, overlay.width, overlay.height, t, progress01);

  if (webcamRunning) {
    window.requestAnimationFrame(predictWebcam);
  }
}

// 카메라가 꺼져 있을 때: 스캔 모션만 그린 뒤 일정 시간 후 결과 모달 표시
function runFallbackScanLoop() {
  if (fallbackLoopActive || webcamRunning) return;
  fallbackLoopActive = true;
  state = "scanning";
  if (overlay) {
    if (overlay.width === 0 || overlay.height === 0) {
      overlay.width = 375;
      overlay.height = 812;
    }
    overlay.classList.remove("is-hidden");
  }

  function tick() {
    if (!fallbackLoopActive || webcamRunning) return;
    const ctx = overlay && overlay.getContext("2d");
    if (!ctx) {
      requestAnimationFrame(tick);
      return;
    }
    const now = performance.now();
    const elapsed = now - scanStartAt;
    const progress01 = clamp01(elapsed / scanDurationMs);

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    drawGrid(ctx, overlay.width, overlay.height, now);
    drawScanBeam(ctx, null, overlay.width, overlay.height, now, progress01);
    drawGlitch(ctx, overlay.width, overlay.height, now, progress01);

    if (progress01 >= 1) {
      fallbackLoopActive = false;
      state = "done";
      if (!resultNavigated) {
        resultNavigated = true;
        const base = Math.min(100, Math.max(0, Math.round(skin.hydration * 40 + skin.oil * 30 + 30)));
        const score = Math.min(100, Math.max(0, base + Math.floor(Math.random() * 21) - 10));
        setTimeout(() => openResultModal(score), 300);
      }
      return;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// --- Drawing Helpers (거울 모드: 랜드마크 x 좌우 반전) ---
function mirrorX(normalizedX) {
  return 1 - normalizedX;
}
function landmarkToCanvasX(xNorm, w) {
  return mirrorX(xNorm) * w;
}

function getBoundingBox(landmarks, w, h) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of landmarks) {
    const fx = mirrorX(p.x);
    if (fx < minX) minX = fx;
    if (fx > maxX) maxX = fx;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX * w,
    y: minY * h,
    w: (maxX - minX) * w,
    h: (maxY - minY) * h
  };
}

function drawGrid(ctx, w, h, t) {
  ctx.save();
  ctx.globalAlpha = 0.1;
  ctx.strokeStyle = "rgba(0, 207, 255, 0.38)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 8]);
  const spacing = 40;
  const driftX = Math.sin(t * 0.0006) * 6;
  const driftY = Math.cos(t * 0.00055) * 6;
  for (let x = -spacing; x <= w + spacing; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x + driftX, 0);
    ctx.lineTo(x + driftX, h);
    ctx.stroke();
  }
  for (let y = -spacing; y <= h + spacing; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y + driftY);
    ctx.lineTo(w, y + driftY);
    ctx.stroke();
  }
  ctx.restore();
}

function drawBoundingBox(ctx, landmarks, t, progress01) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const box = getBoundingBox(landmarks, w, h);

  // 넓게 인식: 패딩을 넉넉히
  const pad = 40;
  box.x -= pad; box.y -= pad;
  box.w += pad * 2; box.h += pad * 2;

  const pulse = 0.65 + 0.35 * Math.sin(t * 0.006);

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = PALETTE.cyan;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = PALETTE.cyan;
  ctx.shadowBlur = 14 * pulse;
  ctx.strokeRect(box.x, box.y, box.w, box.h);

  // Corners
  const len = 20;
  ctx.lineWidth = 2;
  ctx.strokeStyle = PALETTE.blue;
  ctx.beginPath();
  // Top Left
  ctx.moveTo(box.x, box.y + len); ctx.lineTo(box.x, box.y); ctx.lineTo(box.x + len, box.y);
  // Top Right
  ctx.moveTo(box.x + box.w - len, box.y); ctx.lineTo(box.x + box.w, box.y); ctx.lineTo(box.x + box.w, box.y + len);
  // Bottom Right
  ctx.moveTo(box.x + box.w, box.y + box.h - len); ctx.lineTo(box.x + box.w, box.y + box.h); ctx.lineTo(box.x + box.w - len, box.y + box.h);
  // Bottom Left
  ctx.moveTo(box.x + len, box.y + box.h); ctx.lineTo(box.x, box.y + box.h); ctx.lineTo(box.x, box.y + box.h - len);
  ctx.stroke();
  ctx.restore();

  // Scan beam
  drawScanBeam(ctx, box, w, h, t, progress01);
}

function drawScanBeam(ctx, box, w, h, t, progress01) {
  // 진단 하기 버튼 눌렀을 때만 위→아래 스캔 모션 표시
  if (!showScanBeam) return;

  const baseY = (t * 0.3) % h;
  const lineH = 40;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const g = ctx.createLinearGradient(0, baseY - lineH, 0, baseY + lineH);
  g.addColorStop(0, "rgba(0, 207, 255, 0)");
  g.addColorStop(0.5, "rgba(0, 207, 255, 0.4)");
  g.addColorStop(1, "rgba(0, 207, 255, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, baseY - lineH, w, lineH * 2);

  if (box) {
    // Local beam on face
    const beamY = box.y + ((t * 0.4) % box.h);
    ctx.globalAlpha = 0.3 + 0.3 * progress01;
    ctx.fillStyle = "rgba(162, 85, 248, 0.2)";
    ctx.fillRect(box.x, beamY - 5, box.w, 10);
  }
  ctx.restore();
}

function drawRealLandmarks(ctx, landmarks, t, progress01) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  // Key landmarks indices (MediaPipe Face Mesh)
  // Eyes: 33, 133, 362, 263
  // Nose: 1
  // Mouth: 13, 14

  const features = [
    { idx: 33, name: "L-EYE" },
    { idx: 263, name: "R-EYE" },
    { idx: 1, name: "NOSE" },
    { idx: 13, name: "MOUTH" }
  ];

  ctx.save();
  ctx.font = '15px "SF Pro Text", -apple-system, sans-serif';

  for (const feat of features) {
    if (!landmarks[feat.idx]) continue;
    const p = landmarks[feat.idx];
    const px = landmarkToCanvasX(p.x, w);
    const py = p.y * h;

    const wobble = 1.0 * Math.sin(t * 0.006 + feat.idx);

    // Point
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, 2 * Math.PI);
    ctx.fillStyle = PALETTE.cyan;
    ctx.shadowColor = PALETTE.cyan;
    ctx.shadowBlur = 10;
    ctx.fill();

    // Crosshair
    ctx.strokeStyle = PALETTE.violet;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px - 6, py); ctx.lineTo(px + 6, py);
    ctx.moveTo(px, py - 6); ctx.lineTo(px, py + 6);
    ctx.stroke();

    // Label
    ctx.fillStyle = "white";
    ctx.fillText(feat.name, px + 8, py - 8);
  }

  // Draw contours specifically (Eyes, Mouth, Face Oval)
  if (FaceLandmarker.FACE_LANDMARKS_TESSELATION) {
    // Too many lines for tesselation, use contours instead if possible.
    // But wait, user wants "object detection eyes/nose/mouth".
    // Let's highlight checks.
  }
  ctx.restore();
}

function drawRealMesh(ctx, landmarks, t, progress01) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const connections = FaceLandmarker.FACE_LANDMARKS_TESSELATION;

  if (!connections) return;

  ctx.save();
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";

  ctx.beginPath();
  for (const edge of connections) {
    const p1 = landmarks[edge.start];
    const p2 = landmarks[edge.end];
    if (p1 && p2) {
      ctx.moveTo(landmarkToCanvasX(p1.x, w), p1.y * h);
      ctx.lineTo(landmarkToCanvasX(p2.x, w), p2.y * h);
    }
  }
  ctx.stroke();

  // 눈/입/코 라인
  ctx.lineWidth = 1.7;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.shadowColor = "rgba(255, 255, 255, 0.4)";
  ctx.shadowBlur = 6;

  const contours = [
    FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
    FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
    FaceLandmarker.FACE_LANDMARKS_LIPS,
    FaceLandmarker.FACE_LANDMARKS_NOSE,
  ];

  for (const contour of contours) {
    if (!contour) continue;
    ctx.beginPath();
    let first = true;
    for (const edge of contour) {
      const p1 = landmarks[edge.start];
      const p2 = landmarks[edge.end];
      if (first) {
        ctx.moveTo(landmarkToCanvasX(p1.x, w), p1.y * h);
        first = false;
      }
      ctx.lineTo(landmarkToCanvasX(p2.x, w), p2.y * h);
    }
    ctx.stroke();
  }

  ctx.restore();
}

function drawDataReadout(ctx, box, t, progress01, hasFace) {
  if (!ctx) return;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;

  if (!hasFace || (!results?.faceLandmarks?.length)) {
    const x = 20;
    const y = 60;
    ctx.save();
    ctx.font = "15px -apple-system, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText("얼굴을 맞춰 주세요", x, y);
    ctx.restore();
    return;
  }

  // 실시간 피부 트래킹 패널 (얼굴이 인식되면 진단하기 버튼 누르기 전에도 표시)
  const showPanel = state === "idle" || state === "detecting" || state === "scanning" || state === "done";
  if (!showPanel) return;

  const pad = 17;
  const panelW = 192;
  const panelH = 158;
  const px = Math.max(pad, Math.min(box.x + box.w * 0.5 - panelW * 0.5, w - panelW - pad));
  let py = box.y + box.h + 12;
  if (py + panelH > h - 80) py = box.y - panelH - 12;
  if (py < pad) py = h - panelH - 80;

  ctx.save();

  // 패널 배경
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, px, py, panelW, panelH, 14);
  ctx.fill();
  ctx.stroke();

  const lineH = 24;
  const leftX = px + pad;
  const rightX = px + panelW - pad;
  let ly = py + 26;

  ctx.font = "15px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillText("실시간 피부", leftX, ly);
  ly += 6;

  // 수분
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText("수분", leftX, ly + 16);
  drawBar(ctx, px + pad + 44, ly + 4, panelW - pad * 2 - 52, 7, skin.hydration, "rgba(0,207,255,0.8)");
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillText(Math.round(skin.hydration * 100) + "%", rightX, ly + 16);
  ly += lineH;

  // 유분
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText("유분", leftX, ly + 16);
  drawBar(ctx, px + pad + 44, ly + 4, panelW - pad * 2 - 52, 7, skin.oil, "rgba(162,85,248,0.75)");
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillText(Math.round(skin.oil * 100) + "%", rightX, ly + 16);
  ly += lineH;

  // 피부 타입
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText("피부 타입", leftX, ly + 14);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillText(skin.type, rightX, ly + 14);
  ly += 22;

  // 오늘 피부
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillText("오늘 피부", leftX, ly + 14);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillText(skin.today, rightX, ly + 14);

  if (state === "scanning") {
    const dot = Math.floor(t / 400) % 4;
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(0,207,255,0.9)";
    ctx.fillText(".".repeat(dot + 1), rightX, py + 24);
  }
  ctx.textAlign = "left";

  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawBar(ctx, x, y, width, height, value01, fillStyle) {
  const v = clamp01(value01);
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = fillStyle;
  ctx.fillRect(x, y, width * v, height);
}

function drawGlitch(ctx, w, h, t, progress01) {
  if (state !== "scanning") return;
  if (Math.random() > 0.1) return;

  const y = Math.random() * h;
  const glH = Math.random() * 20;

  ctx.save();
  ctx.fillStyle = Math.random() > 0.5 ? PALETTE.cyanSoft : "rgba(162, 85, 248, 0.2)";
  ctx.fillRect(0, y, w, glH);
  ctx.restore();
}

// Reuse existing skin analysis logic (simplified for module)
function ensureSkinBuffer() {
  if (!skin.bufCanvas) {
    skin.bufCanvas = document.createElement("canvas");
    skin.bufCtx = skin.bufCanvas.getContext("2d", { willReadFrequently: true });
  }
  const targetW = 64;
  const targetH = 64;
  if (skin.bufCanvas.width !== targetW) {
    skin.bufCanvas.width = targetW;
    skin.bufCanvas.height = targetH;
  }
}

function analyzeSkin(videoEl, overlayEl, skinState, now) {
  if (now - skinState.lastAt < 120) return;
  skinState.lastAt = now;
  ensureSkinBuffer();

  const ctx = skinState.bufCtx;
  ctx.drawImage(videoEl, 0, 0, 64, 64);
  const imgData = ctx.getImageData(0, 0, 64, 64);
  let sum = 0, sumSq = 0, count = 0;
  for (let i = 0; i < imgData.data.length; i += 4) {
    const g = (imgData.data[i] + imgData.data[i + 1] + imgData.data[i + 2]) / 3;
    sum += g;
    sumSq += g * g;
    count++;
  }
  const brightness = count ? sum / count / 255 : 0.5;
  const variance = count ? Math.max(0, sumSq / count - (sum / count) ** 2) / (255 * 255) : 0.02;

  // 수분·유분: 밝기·대비에 반응해서 실제 측정값처럼 보이게 (노이즈 최소화)
  const t = now * 0.001;
  const drift = 0.02 * Math.sin(t * 0.3) + 0.01 * Math.sin(t * 0.7);
  const hydBase = 0.48 + brightness * 0.28 + variance * 2;
  const oilBase = 0.18 + (1 - brightness) * 0.35 + variance * 1.5;
  const hydTarget = clamp01(hydBase + drift);
  const oilTarget = clamp01(oilBase - drift * 0.5);
  skinState.hydration = lerp(skinState.hydration, hydTarget, 0.12);
  skinState.oil = lerp(skinState.oil, oilTarget, 0.12);

  // 피부 타입: 유분·수분 비율로 결정 (느낌만)
  const o = skinState.oil;
  const h = skinState.hydration;
  if (o > 0.45 && h < 0.55) skinState.type = "지성";
  else if (o < 0.25 && h < 0.6) skinState.type = "건조";
  else if (o > 0.38 && h > 0.55) skinState.type = "복합";
  else skinState.type = "중성";

  // 오늘 피부 상태 (트래킹 느낌)
  const todayOptions = ["좋아요", "보통", "건조해요", "번들거려요", "촉촉해요"];
  const todayWeights = [
    h > 0.65 ? 2 : 0.5,
    1,
    h < 0.5 ? 1.5 : 0.3,
    o > 0.45 ? 1.5 : 0.3,
    h > 0.7 ? 1.2 : 0.2
  ];
  if (Math.random() < 0.08) {
    let total = 0;
    todayWeights.forEach((w, i) => { total += w; });
    let r = Math.random() * total;
    for (let i = 0; i < todayWeights.length; i++) {
      r -= todayWeights[i];
      if (r <= 0) { skinState.today = todayOptions[i]; break; }
    }
  }
}


function captureFaceToStorage() {
  try {
    if (!video || video.videoWidth === 0 || video.readyState < 2) {
      sessionStorage.removeItem("faceCapture");
      return;
    }
    const canvas = document.createElement("canvas");
    const w = video.videoWidth;
    const h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    sessionStorage.setItem("faceCapture", canvas.toDataURL("image/jpeg", 0.85));
  } catch (e) {
    console.warn("faceCapture 저장 실패:", e);
    sessionStorage.removeItem("faceCapture");
  }
}

function openResultModal(score) {
  const modal = document.getElementById("result-modal");
  const iframe = document.getElementById("result-iframe");
  if (!modal || !iframe) return;
  captureFaceToStorage();
  iframe.src = `result.html?score=${score}`;
  modal.classList.remove("is-hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeResultModal() {
  const modal = document.getElementById("result-modal");
  const iframe = document.getElementById("result-iframe");
  if (modal && iframe) {
    modal.classList.add("is-hidden");
    modal.setAttribute("aria-hidden", "true");
    iframe.src = "about:blank";
  }
}

window.addEventListener("message", (e) => {
  if (e.data === "closeResultModal") closeResultModal();
});

// --- 실시간 날씨 (Open-Meteo, API 키 불필요) ---
const WEATHER_CODE_MAP = {
  0: "Clear",
  1: "Mainly Clear",
  2: "Partly Cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Rain",
  63: "Rain",
  65: "Rain",
  71: "Snow",
  73: "Snow",
  75: "Snow",
  77: "Snow",
  80: "Showers",
  81: "Showers",
  82: "Showers",
  85: "Snow",
  86: "Snow",
  95: "Thunderstorm",
  96: "Thunderstorm",
  99: "Thunderstorm"
};
const DEFAULT_LAT = 37.5665;
const DEFAULT_LON = 126.978;

function setWeatherEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function loadWeather() {
  let lat = DEFAULT_LAT;
  let lon = DEFAULT_LON;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000, maximumAge: 300000 });
    });
    lat = pos.coords.latitude;
    lon = pos.coords.longitude;
  } catch (_) {
    /* use default Seoul */
  }

  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,uv_index&timezone=auto`
    );
    if (!res.ok) return;
    const data = await res.json();
    const cur = data.current;
    if (!cur) return;
    const tempRaw = Number(cur.temperature_2m);
    const tempRounded = Math.round(tempRaw);
    const tempStr = tempRounded === 0 && tempRaw !== 0
      ? tempRaw.toFixed(1) + "º"
      : tempRounded + "º";
    const code = cur.weather_code;
    const uv = cur.uv_index != null ? Math.round(Number(cur.uv_index)) : null;
    setWeatherEl("weather-temp", tempStr);
    setWeatherEl("weather-condition", WEATHER_CODE_MAP[code] || "—");
    setWeatherEl("weather-uv", uv != null ? "UV Index " + uv : "UV Index —");
  } catch (e) {
    console.warn("날씨 로드 실패:", e);
  }

  try {
    const geoRes = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ko`
    );
    if (!geoRes.ok) return;
    const geo = await geoRes.json();
    const city = geo.city || geo.locality || geo.principalSubdivision || geo.countryName || "—";
    setWeatherEl("weather-location", city);
    const locEl = document.getElementById("weather-location");
    if (locEl) {
      const hasKorean = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(city);
      locEl.classList.toggle("weather-location--ko", !!hasKorean);
    }
  } catch (_) {
    const fallback = lat === DEFAULT_LAT && lon === DEFAULT_LON ? "Seoul" : "—";
    setWeatherEl("weather-location", fallback);
    const locEl = document.getElementById("weather-location");
    if (locEl) locEl.classList.remove("weather-location--ko");
  }
}

// Init
createFaceLandmarker();
loadWeather();
startBtn.addEventListener("click", () => {
  showScanBeam = true;
  state = "detecting";
  scanStartAt = performance.now();
  resultNavigated = false;
  if (!webcamRunning) {
    runFallbackScanLoop();
  }
});

