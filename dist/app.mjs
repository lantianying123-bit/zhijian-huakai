import { approach, clamp, handOpenness } from './gesture.mjs';

const flower = document.querySelector('#flower');
const film = flower.closest('.film');
const camera = document.querySelector('#camera');
const preview = document.querySelector('#camera-preview');
const markers = document.querySelector('#markers');
const drawing = markers.getContext('2d');
const slider = document.querySelector('#aperture');
const amount = document.querySelector('#amount');
const toggle = document.querySelector('#camera-toggle');
const buttonLabel = document.querySelector('#button-label');
const status = document.querySelector('#camera-status');

let position = 0;
let target = 0;
let stream;
let tracker;
let trackerPromise;
let cameraActive = false;
let cameraRun = 0;
let lastFrame = performance.now();
let lastDetection = -Infinity;
let lastCameraTime = -1;
let lastHand = -Infinity;
let manualUntil = 0;
let dragging = false;
let shownPercent = -1;
let litPosition = -1;

function setStatus(state, text) {
  if (status.dataset.state === state && status.textContent === text) return;
  status.dataset.state = state;
  status.textContent = text;
}

function showProgress() {
  if (position !== litPosition) {
    const light = Math.pow(position, 1.24);
    const glowProgress = clamp((position - 0.09) / 0.91);
    const glow = glowProgress ** 2 * (3 - 2 * glowProgress) * 0.73;
    film.style.setProperty('--bloom-light', light.toFixed(4));
    film.style.setProperty('--glow', glow.toFixed(4));
    litPosition = position;
  }
  const percent = Math.round(position * 100);
  if (percent !== shownPercent) {
    if (!dragging) slider.value = percent;
    amount.value = percent + '%';
    slider.style.setProperty('--fill', percent + '%');
    shownPercent = percent;
  }
  if (!Number.isFinite(flower.duration) || flower.readyState < 2 || flower.seeking) return;

  // Leave the seek target inside the last decoded frame.
  const time = position * Math.max(0, flower.duration - 0.045);
  if (Math.abs(flower.currentTime - time) >= 0.017) flower.currentTime = time;
}

function getTracker() {
  trackerPromise ??= (async () => {
    const { FilesetResolver, HandLandmarker } = await import('./vendor/vision_bundle.mjs');
    const assets = await FilesetResolver.forVisionTasks(new URL('./vendor/wasm', import.meta.url).href);
    return HandLandmarker.createFromOptions(assets, {
      baseOptions: { modelAssetPath: new URL('./vendor/hand_landmarker.task', import.meta.url).href },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
  })().catch(error => {
    trackerPromise = undefined;
    throw error;
  });
  return trackerPromise;
}

function releaseCamera() {
  cameraRun++;
  cameraActive = false;
  stream?.getTracks().forEach(track => track.stop());
  stream = undefined;
  camera.srcObject = null;
  preview.hidden = true;
  toggle.setAttribute('aria-pressed', 'false');
  buttonLabel.textContent = '开启摄像头';
  lastHand = -Infinity;
  lastCameraTime = -1;
  clearMarkers();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('error', '请在 Chrome 或 Edge 中打开网页后再开启摄像头。');
    return;
  }

  const run = ++cameraRun;
  cameraActive = true;
  toggle.setAttribute('aria-pressed', 'true');
  buttonLabel.textContent = '关闭摄像头';
  setStatus('loading', '正在请求摄像头权限…');
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 30, max: 30 } },
    });
    if (run !== cameraRun) {
      newStream.getTracks().forEach(track => track.stop());
      return;
    }
    stream = newStream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (run !== cameraRun) return;
        releaseCamera();
        setStatus('error', '摄像头已断开，可以重新开启。');
      }, { once: true });
    }
    camera.srcObject = stream;
    await camera.play();
    if (run !== cameraRun) return;
    preview.hidden = false;
    setStatus('loading', '正在加载手势识别…');
    const readyTracker = await getTracker();
    if (run !== cameraRun) return;
    tracker = readyTracker;
    setStatus('waiting', '将一只手举到摄像头前。');
  } catch (error) {
    if (run !== cameraRun) return;
    console.warn('Camera setup failed', error);
    releaseCamera();
    const messages = {
      NotAllowedError: '请在浏览器中允许访问摄像头，再试一次。',
      NotFoundError: '没有找到摄像头，可先用滑杆体验。',
      NotReadableError: '摄像头可能被占用，关闭其他使用摄像头的应用后再试。',
    };
    setStatus('error', messages[error.name] ?? '手势识别启动失败，请刷新网页后重试。');
  }
}

function clearMarkers() {
  drawing.clearRect(0, 0, markers.width, markers.height);
}

function drawPinch(landmarks) {
  if (markers.width !== camera.videoWidth || markers.height !== camera.videoHeight) {
    markers.width = camera.videoWidth;
    markers.height = camera.videoHeight;
  }
  clearMarkers();
  const points = [landmarks[4], landmarks[8]].map(point => [
    point.x * markers.width, point.y * markers.height,
  ]);
  drawing.strokeStyle = '#e1edba';
  drawing.fillStyle = '#e1edba';
  drawing.lineWidth = markers.width / 145;
  drawing.beginPath();
  drawing.moveTo(...points[0]);
  drawing.lineTo(...points[1]);
  drawing.stroke();
  for (const [x, y] of points) {
    drawing.beginPath();
    drawing.arc(x, y, markers.width / 70, 0, Math.PI * 2);
    drawing.fill();
  }
}

function trackHand(now) {
  if (!cameraActive || !tracker || camera.readyState < 2) return;
  if (now - lastDetection < 36 || lastCameraTime === camera.currentTime) return;
  lastDetection = now;
  lastCameraTime = camera.currentTime;

  let landmarks;
  try {
    landmarks = tracker.detectForVideo(camera, now).landmarks[0];
  } catch (error) {
    console.warn('Hand tracking failed', error);
    tracker.close();
    tracker = undefined;
    trackerPromise = undefined;
    releaseCamera();
    setStatus('error', '手势识别已中断，可以重新开启摄像头。');
    return;
  }

  const openness = landmarks ? handOpenness(landmarks, camera.videoWidth, camera.videoHeight) : null;
  if (openness === null) {
    if (now - lastHand > 240) {
      clearMarkers();
      setStatus('waiting', '将一只手举到摄像头前。');
    }
    return;
  }

  drawPinch(landmarks);
  lastHand = now;
  setStatus('tracking', '已识别手势 · 捏合或分开两指');
  if (dragging || now < manualUntil) return;
  if (openness === 0 || openness === 1 || Math.abs(openness - target) >= 0.016) target = openness;
}

function update(now) {
  trackHand(now);
  const elapsed = clamp(now - lastFrame, 0, 50);
  position = approach(position, target, elapsed);
  lastFrame = now;
  showProgress();
  requestAnimationFrame(update);
}

toggle.addEventListener('click', () => {
  if (!cameraActive) {
    void startCamera();
    return;
  }
  releaseCamera();
  setStatus('off', '摄像头关闭，可拖动滑杆体验。');
});

slider.addEventListener('pointerdown', () => { dragging = true; });
for (const event of ['pointerup', 'pointercancel']) {
  window.addEventListener(event, () => {
    if (!dragging) return;
    dragging = false;
    manualUntil = performance.now() + 1000;
  });
}
slider.addEventListener('input', () => {
  manualUntil = performance.now() + 1000;
  target = Number(slider.value) / 100;
  position = target;
  showProgress();
});
flower.addEventListener('seeked', showProgress);
flower.addEventListener('error', () => { document.querySelector('#stage-message').hidden = false; });
window.addEventListener('pagehide', () => {
  releaseCamera();
  setStatus('off', '摄像头关闭，可拖动滑杆体验。');
});
requestAnimationFrame(update);
