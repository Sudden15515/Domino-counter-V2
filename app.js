/****************************************************
 * Domino Prickräknare – allt i en fil, med gott snack
 * - Kamera i HD
 * - OpenCV.js bildanalys
 * - Prickdetektion via adaptiv tröskel + konturer
 * - Klustring (DBSCAN-light) -> brickor
 * - Grön ring på prickar, grön låda + siffra per bricka
 * - Live-läge + sliders för tuning
 ****************************************************/

// ======= justerbara parametrar =======
const CAMERA_CONSTRAINTS = {
  video: {
    facingMode: { ideal: "environment" },
    width:  { ideal: 1280 },
    height: { ideal: 720 }
  },
  audio: false
};

// tröskling (tål färg/mönster/ljus)
const ADAPTIVE_BLOCK_SIZE = 21;  // udda (11..31 oftast bra)
const ADAPTIVE_C          = 5;

// area-filter för konturer som liknar prickar (pixlar)
let MIN_AREA = 30;   // uppdateras med slider
let MAX_AREA = 5000; // uppdateras med slider

// klustring: avstånd i pixlar (uppdateras med slider eller auto)
let EPS = null;  // null => auto från bildstorlek
const MIN_PTS = 1; // min punkter/kluster (1 för att tillåta 1-prick-brickor)

// ======= element =======
const video   = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx    = overlay.getContext("2d");
const work    = document.getElementById("work");
const wctx    = work.getContext("2d", { willReadFrequently: true });

const btnSnap = document.getElementById("snap");
const liveChk = document.getElementById("live");
const statusP = document.getElementById("status");
const resultP = document.getElementById("result");

const epsRange = document.getElementById("eps");
const epsVal   = document.getElementById("epsVal");
const minRange = document.getElementById("minArea");
const minVal   = document.getElementById("minVal");
const maxRange = document.getElementById("maxArea");
const maxVal   = document.getElementById("maxVal");

let cvReady = false;
let liveTimer = null;

const startBtn = document.getElementById('startCam');

// extra loggar hjälper oss se var det fastnar
const log = (...a) => { try { console.log('[domino]', ...a); } catch {} };

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  statusP.textContent = "Startar kamera…";
  try {
    await waitForOpenCVThenStart();
  } catch (e) {
    statusP.textContent = "Fel: " + e;
    startBtn.disabled = false;
  }
});

/* =======================
   Robust laddning av OpenCV
   ======================= */
async function waitForOpenCVThenStart() {
  log('väntar på cv...');
  // vänta tills cv-definitionen finns
  while (typeof cv === 'undefined' || !cv || !cv.Mat) {
    await new Promise(r => setTimeout(r, 60));
  }
  // om redan klart – kör direkt
  if (cv.imread && cv.cvtColor) {
    log('cv klart (direkt)');
    cvReady = true;
    statusP.textContent = "OpenCV klart – startar kamera…";
    await initCamera();
    return;
  }
  // annars vänta på runtime init
  await new Promise(res => {
    cv['onRuntimeInitialized'] = () => {
      log('cv onRuntimeInitialized');
      cvReady = true;
      statusP.textContent = "OpenCV klart – startar kamera…";
      res();
    };
  });
  await initCamera();
}

startWhenCvReady();

/* =======================
   Kamera – iOS-säker init
   ======================= */
async function initCamera(){
  try {
    // iOS-vänlig autoplay
    video.muted = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');

    // 1) Försök med bakre kamera i HD
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (e) {
      // 2) Fallback till valfri kamera om det behövs
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    video.srcObject = stream;

    // Vänta på metadata – annars är videoWidth = 0 på iOS
    await new Promise(res => {
      if (video.readyState >= 1 && video.videoWidth) return res();
      video.onloadedmetadata = () => res();
    });

    try { await video.play(); } catch (_) {}

    // matcha canvasstorlek till riktiga pixelmått
    resizeCanvases();
    window.addEventListener("resize", resizeCanvases);

    // init sliders
    MIN_AREA = +minRange.value;
    MAX_AREA = +maxRange.value;
    minVal.textContent = MIN_AREA;
    maxVal.textContent = MAX_AREA;

    // EPS auto = 6% av max(width,height)
    setAutoEps();

    btnSnap.disabled = false;
    statusP.textContent = "Kamera igång ✅";
  } catch (err) {
    statusP.textContent = "Kunde inte starta kamera: " + err;
    console.error(err);
  }
}

function resizeCanvases(){
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  overlay.width = w; overlay.height = h;
  work.width    = w; work.height    = h;
  setAutoEps();
}

function setAutoEps(){
  if (EPS === null) {
    const w = work.width, h = work.height;
    const auto = Math.round(Math.max(w, h) * 0.065); // ~6.5% är en bra start
    epsRange.value = auto;
    epsVal.textContent = "auto (" + auto + ")";
  }
}

// UI – sliders och knappar
btnSnap.addEventListener("click", () => {
  const out = analyzeFrame();
  prettyPrint(out);
});

liveChk.addEventListener("change", e => {
  if (e.target.checked) {
    liveTimer = setInterval(() => {
      const out = analyzeFrame();
      prettyPrint(out);
    }, 140); // lagom fps
  } else {
    clearInterval(liveTimer);
    liveTimer = null;
  }
});

epsRange.addEventListener("input", e => {
  EPS = +e.target.value;      // explicit värde -> inte “auto” längre
  epsVal.textContent = EPS;
});

minRange.addEventListener("input", e => {
  MIN_AREA = +e.target.value;
  minVal.textContent = MIN_AREA;
});

maxRange.addEventListener("input", e => {
  MAX_AREA = +e.target.value;
  maxVal.textContent = MAX_AREA;
});

// ===== Bildanalys – huvudrutin =====
function analyzeFrame(){
  if (!cvReady || video.videoWidth === 0) return { total:0, clusters:[], ms:0 };

  // 1) videoframe -> arbetscanvas
  wctx.drawImage(video, 0, 0, work.width, work.height);

  const t0 = performance.now();

  // 2) cv image
  let src  = cv.imread(work);
  let gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  // 3) blur + adaptiv tröskel (svart/vitt)
  let blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0);

  let bin = new cv.Mat();
  cv.adaptiveThreshold(
    blur, bin, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY_INV,
    ADAPTIVE_BLOCK_SIZE, ADAPTIVE_C
  );

  // 4) morfologisk stängning = fyll små hål i prickar
  const k = cv.Mat.ones(3,3,cv.CV_8U);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);

  // 5) hitta konturer (kandidater till prickar)
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(bin, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  // 6) filtrera konturer -> cirklar
  const dots = []; // {x,y,r}
  for (let i=0; i<contours.size(); i++){
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area >= MIN_AREA && area <= MAX_AREA) {
      // grovt formfilter – någorlunda cirkulärt (bbox ~ kvadrat)
      const rect = cv.boundingRect(cnt);
      const ratio = rect.width / rect.height;
      if (ratio > 0.5 && ratio < 2.0) {
        // minsta omslutande cirkel
        const center = new cv.Point(0,0);
        const radius = new cv.Mat();
        cv.minEnclosingCircle(cnt, center, radius);
        dots.push({ x:center.x, y:center.y, r: radius.data32F[0] });
        radius.delete();
      }
    }
    cnt.delete();
  }
  contours.delete(); hierarchy.delete();

  // 7) klustra prickar -> brickor
  const eps = (EPS ?? Math.round(Math.max(work.width, work.height) * 0.065));
  const clusters = dbscan(dots, eps, MIN_PTS); // array av arrays

  // 8) rita allt skönt på overlay
  drawOverlay(dots, clusters);

  const ms = Math.round(performance.now() - t0);

  // free
  src.delete(); gray.delete(); blur.delete(); bin.delete(); k.delete();

  // summera
  const perTile = clusters.map(c => c.length);
  const total = dots.length;
  return { total, clusters: perTile, ms };
}

// ===== Ritning =====
function drawOverlay(dots, clusters){
  octx.clearRect(0,0,overlay.width, overlay.height);

  // a) prickar – gröna ringar
  octx.lineWidth = 2;
  octx.strokeStyle = "rgba(0,255,100,0.95)";
  octx.fillStyle   = "rgba(0,255,100,0.18)";

  for (const d of dots){
    octx.beginPath();
    octx.arc(d.x, d.y, d.r, 0, Math.PI*2);
    octx.fill();
    octx.stroke();
  }

  // b) brickor – grön ruta + siffra
  octx.font = "700 22px system-ui, Arial";
  octx.textBaseline = "top";

  clusters.forEach((cluster) => {
    // bounding box över alla prickar i klustret
    let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
    cluster.forEach(p => {
      minx = Math.min(minx, p.x - p.r);
      miny = Math.min(miny, p.y - p.r);
      maxx = Math.max(maxx, p.x + p.r);
      maxy = Math.max(maxy, p.y + p.r);
    });
    const pad = 10;
    minx -= pad; miny -= pad; maxx += pad; maxy += pad;

    // ruta
    octx.strokeStyle = "rgba(0,255,100,0.95)";
    octx.lineWidth = 3;
    octx.strokeRect(minx, miny, maxx-minx, maxy-miny);

    // etikett (antal prickar i klustret)
    const txt = String(cluster.length);
    const tw = octx.measureText(txt).width + 12;
    const th = 28;
    octx.fillStyle = "rgba(0,0,0,0.6)";
    octx.fillRect(minx, miny - th, tw, th);
    octx.fillStyle = "#00ff7b";
    octx.fillText(txt, minx + 6, miny - th + 4);
  });
}

// ===== DBSCAN-light (ren JS) =====
function dbscan(points, eps, minPts){
  // points: [{x,y,r}]
  const N = points.length;
  const visited = new Array(N).fill(false);
  const labels  = new Array(N).fill(undefined); // -1 = brus
  let C = 0; // kluster-id
  const clusters = [];

  const regionQuery = (i) => {
    const p = points[i];
    const out = [];
    for (let j=0; j<N; j++){
      const q = points[j];
      const dx = p.x - q.x, dy = p.y - q.y;
      if ((dx*dx + dy*dy) <= eps*eps) out.push(j);
    }
    return out;
  };

  for (let i=0; i<N; i++){
    if (visited[i]) continue;
    visited[i] = true;

    let neighbors = regionQuery(i);
    if (neighbors.length < minPts){
      labels[i] = -1; // brus
      continue;
    }

    // starta nytt kluster
    const clusterIdx = C++;
    labels[i] = clusterIdx;
    const seeds = new Set(neighbors);
    seeds.delete(i);

    // expandera
    for (const n of seeds){
      if (!visited[n]){
        visited[n] = true;
        const nbs2 = regionQuery(n);
        if (nbs2.length >= minPts){
          nbs2.forEach(x => seeds.add(x));
        }
      }
      if (labels[n] === undefined || labels[n] === -1){
        labels[n] = clusterIdx;
      }
    }
  }

  // konvertera etiketter -> klusterlistor
  for (let c=0; c<C; c++){
    clusters.push([]);
  }
  for (let i=0; i<N; i++){
    const lab = labels[i];
    if (lab === undefined || lab === -1){
      // Ensamma prickar får eget “kluster” (gäller t.ex. 1-prick-brickor)
      clusters.push([points[i]]);
    } else {
      clusters[lab].push(points[i]);
    }
  }
  return clusters.filter(arr => arr.length > 0);
}

// ===== fin output =====
function prettyPrint(out){
  const pretty = out.clusters.join(", ");
  resultP.textContent =
    `Antal prickar är: ${out.total}  |  Brickor: [${pretty}]  —  ${out.ms} ms`;
}


