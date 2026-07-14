/* ============================================================================
   scroll-world — CANVAS / WebCodecs варіант рушія (лаб)
   ----------------------------------------------------------------------------
   Причина існування: `<video>` + currentTime-перемотка має стелю ~15–30 к/с під
   час активного скролу (асинхронний цикл seek→decode→paint) — це і були «ривки».
   Тут ми НЕ просимо відеоелемент перемотуватись. Ми самі декодуємо потрібний кадр
   через WebCodecs VideoDecoder і малюємо його на <canvas> у циклі rAF — тобто
   перемальовуємо КОЖЕН кадр (60 к/с), синхронно, без асинхронного seek.
   Джерело — те саме ЄДИНЕ all-intra відео (кожен кадр — незалежний keyframe, тож
   будь-який кадр декодується окремо й миттєво: ідеально для random-access WebCodecs).

   Fallback: якщо браузер без WebCodecs — тихо відкочуємось на <video>-scrub того ж
   файлу (гірша плавність, але без стрибків на стиках, бо файл один).

   config: flight, flightMobile, poster, posterMobile, fps, segFrames[], sections,
           connectors, brand, cta, diveScroll, connScroll — як у single-рушії.
   Потребує глобалів MP4Box + DataStream (mp4box.all.min.js підключений раніше).
   ========================================================================== */

// Чиста, тестована мапа «частка скролу → кадр», рівномірна ПО РУХУ КАМЕРИ.
// lut — нормалізована (0..1) кумулятивна пройдена камерою відстань на кожному кадрі
// сегмента. Потрібна, бо вихідне відео Seedance періодично ЗАВМИРАЄ (10–23% кадрів
// майже не рухаються, найгірше — у перельотах між будівлями). Якщо ділити скрол рівно
// по КАДРАХ, ці завмирання читаються як ривки; ділимо рівно по РУХУ — на завмерлих
// кадрах скрол не затримується і швидкість камери стає постійною.
// Без lut (ще не завантажився) — чесний лінійний фолбек.
function frameFromMotion(lut, f0, f1, p) {
  if (!lut || lut.length < 2) return f0 + p * (f1 - f0);
  let a = 0, b = lut.length - 1;
  while (a < b) { const m = (a + b) >> 1; if (lut[m] < p) a = m + 1; else b = m; }
  if (a > 0 && lut[a] > lut[a - 1]) {
    const t = (p - lut[a - 1]) / (lut[a] - lut[a - 1]);
    return f0 + (a - 1) + t;
  }
  return f0 + a;
}

function settleTargetFor(y, segments, dir) {
  if (!segments || !segments.length) return null;
  let ci = 0;
  for (let i = 0; i < segments.length; i++) if (y >= segments[i].start) ci = i;
  const seg = segments[ci];
  if (!seg || seg.kind !== 'conn') return null;
  const to = dir >= 0 ? seg.end : seg.start;
  return Math.abs(to - y) >= 2 ? to : null;
}

function mountScrollWorld(container, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isMobile = () => coarse || smallMQ.matches;
  const phoneClass = Math.min(screen.width, screen.height) <= 600;
  const conn = navigator.connection;
  const dataSaver = !!(conn && conn.saveData);
  let stillsOnly = reduce || dataSaver;
  const hasWebCodecs = ('VideoDecoder' in window) && ('EncodedVideoChunk' in window) && (typeof MP4Box !== 'undefined');

  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;
  const FPS = config.fps || 24;
  const SEG_FRAMES = config.segFrames || [];
  const N = SECTIONS.length;
  if (!N) return;

  injectCSS();
  container.classList.add('sw-root');
  container.querySelectorAll('[data-sw-seo]').forEach(n => { n.hidden = true; });

  // ---- ланцюг сегментів (для геометрії скролу + авто-доведення) ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    const dive = { kind: 'dive', si: i, accent: s.accent, w: s.scroll || DIVE_W, linger: s.linger || 0 };
    SEGMENTS.push(dive); s._seg = dive;
    // Ширина скролу кожного перельоту — окремо (config.connScrollEach), бо перельоти
    // мають РІЗНУ кількість руху камери; однакова ширина = стрибок швидкості на межі.
    if (i < N - 1 && CONNECTORS[i]) {
      const cw = (config.connScrollEach && config.connScrollEach[i]) || CONN_W;
      SEGMENTS.push({ kind: 'conn', si: i, accent: SECTIONS[i + 1].accent, w: cw });
    }
  });
  const NSEG = SEGMENTS.length;
  const cumF = [0];
  for (let i = 0; i < NSEG; i++) cumF.push(cumF[i] + (SEG_FRAMES[i] || 0));
  const TOTAL_FRAMES = cumF[NSEG] || 1;
  const MAX_F = Math.max(0, TOTAL_FRAMES - 1);

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) { sky.appendChild(el('div', 'sw-sky__grad')); sky.appendChild(el('div', 'sw-sky__glow')); }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);
  const scrollbar = el('div', 'sw-scrollbar'); const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    brand.appendChild(el('span', 'sw-brand__mark'));
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) { const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label; topbar.appendChild(c); }

  const stage = el('div', 'sw-stage');
  const scene = el('div', 'sw-scene');
  const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async';
  const posterSrc = phoneClass ? (config.posterMobile || config.poster) : config.poster;
  if (posterSrc) img.src = posterSrc;
  const canvas = el('canvas', 'sw-scene__canvas');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  scene.appendChild(img); scene.appendChild(canvas); stage.appendChild(scene);

  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText); hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  const loader = el('div', 'sw-loader');
  loader.innerHTML = `<div class="sw-loader__box"><span class="sw-loader__brand">${esc((config.brand && config.brand.name) || '')}</span><div class="sw-loader__bar"><span></span></div><span class="sw-loader__pct">0%</span></div>`;
  const loaderBar = loader.querySelector('.sw-loader__bar span');
  const loaderPct = loader.querySelector('.sw-loader__pct');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track, loader].forEach(n => container.appendChild(n));

  const copies = [], dots = [];
  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    c.innerHTML =
      `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>` +
      (s.eyebrow ? `<span class="sw-copy__eyebrow">${esc(s.eyebrow)}</span>` : '') +
      (s.title ? `<h2 class="sw-copy__title">${esc(s.title)}</h2>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);
    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);
    if (config.nav !== false) { const b = el('button', 'sw-nav__item'); b.textContent = s.label || ''; b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b); }
  });

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1, ticking = false;
  let laidOutW = window.innerWidth;
  let targetF = 0, curF = 0;   // цільовий / поточний кадр (float)

  function layout() {
    vh = window.innerHeight; laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    const wf = isMobile() ? (config.scrollMobileFactor != null ? config.scrollMobileFactor : 1.2) : 1;
    let off = 0;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w * wf; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';
    sizeCanvas();
    read();
  }

  function sizeCanvas() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function jumpTo(i) {
    const seg = SECTIONS[i]._seg;
    window.scrollTo({ top: seg.start + (seg.end - seg.start) * 0.5, behavior: reduce ? 'auto' : 'smooth' });
  }

  // Таблиця руху (motion LUT): для кожного сегмента — нормалізована «пройдена камерою
  // відстань» на кожному кадрі. Потрібна, бо вихідне відео Seedance періодично ЗАВМИРАЄ
  // (10–23% кадрів майже не рухаються, найгірше — у перельотах). Якщо ділити скрол рівно
  // по КАДРАХ, ці завмирання читаються як ривки. Ділимо рівно по РУХУ — на завмерлих
  // кадрах скрол не затримується, швидкість камери стає постійною.
  let LUT = null;
  if (config.motionLut) {
    fetch(config.motionLut).then(r => r.ok ? r.json() : null)
      .then(j => { if (j && j.segments && j.segments.length === NSEG) LUT = j.segments; })
      .catch(() => {});
  }

  function frameInSegment(ci, p) {
    return frameFromMotion(LUT && LUT[ci], cumF[ci], cumF[ci + 1] - 1, p);
  }

  function frameForScroll(y) {
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;
    const s = SEGMENTS[ci];
    const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
    const p = s.linger ? lingerEase(local, s.linger) : local;
    return { f: clamp(frameInSegment(ci, p), 0, MAX_F), ci };
  }

  function read() {
    const y = window.scrollY || window.pageYOffset;
    const fr = frameForScroll(y);
    targetF = fr.f;
    const ci = fr.ci;

    if (!drawnOnce) {
      const gp = clamp(y / (totalW * vh), 0, 1);
      const sc = reduce ? 1 : 1.03 + gp * 0.06;
      img.style.transform = `translateX(${stageX - 2}vw) scale(${sc.toFixed(3)})`;
    }

    for (let i = 0; i < N; i++) {
      const seg = SECTIONS[i]._seg;
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (i === 0) cop = after ? 0 : smooth(1 - pr / 0.62);
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];
      c.style.opacity = cop;
      c.style.transform = reduce ? 'none' : `translateY(${(0.5 - pr) * 4}vh)`;
      c.style.pointerEvents = cop > 0.5 ? 'auto' : 'none';
    }

    const cur = SEGMENTS[ci];
    const near = clamp(cur.kind === 'dive' ? cur.si : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);
    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => d.classList.toggle('is-active', k === near));
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) => n.classList.toggle('is-active', k === near));
      container.style.setProperty('--sw-accent', SECTIONS[near].accent || '');
    }
    scrollbarFill.style.transform = `scaleX(${clamp(y / (totalW * vh))})`;
    hint.style.opacity = clamp(1 - y / (0.5 * vh));
    if (particles) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
    ticking = false;
  }

  // ---------------------------------------------------------------- WebCodecs ядро
  const samples = new Array(TOTAL_FRAMES);   // index → Uint8Array (encoded keyframe)
  let samplesReady = 0, allSamples = false;
  let decoder = null, decCfg = null;
  const decoded = new Map();                 // index → VideoFrame
  const pending = new Set();
  let drawnOnce = false, lastDir = 1, videoEl = null;
  // Живий прапорець «малюємо через WebCodecs». draw() читає САМЕ його (а не const
  // hasWebCodecs), інакше при падінні WebCodecs fallback на <video> ніколи б не ожив.
  let _wc = hasWebCodecs;
  // MAX_CACHED тримає декодовані VideoFrame — це ЖИВА відеопам'ять (1600×900 NV12 ≈
  // 2.16 МБ/кадр). 64 кадри = ~138 МБ; тиснемо до 48 (~104 МБ), запасу все одно вдосталь
  // (декод 0.6 мс/кадр). Кадри поза вікном обов'язково close() — інакше витік GPU-пам'яті.
  const WIN_AHEAD = 40, WIN_BEHIND = 8, MAX_CACHED = 48;
  let lastPumpTi = -1;

  // Радіус пошуку навмисно вузький (24, не 90): краще коротко не оновити кадр, ніж
  // намалювати кадр за пів секунди польоту звідси — це читалось би як стрибок.
  function nearestDecoded(ti) {
    if (decoded.has(ti)) return ti;
    for (let r = 1; r <= 24; r++) {
      if (decoded.has(ti - r)) return ti - r;
      if (decoded.has(ti + r)) return ti + r;
    }
    return null;
  }

  function evict(ti) {
    if (decoded.size <= MAX_CACHED) return;
    let far = -1, fd = -1;
    for (const k of decoded.keys()) { const d = Math.abs(k - ti); if (d > fd) { fd = d; far = k; } }
    if (far >= 0) { try { decoded.get(far).close(); } catch (e) {} decoded.delete(far); }
  }

  function pump(ti, dir) {
    if (!decoder || decoder.state !== 'configured') return;
    const ahead = dir >= 0 ? WIN_AHEAD : WIN_BEHIND;
    const behind = dir >= 0 ? WIN_BEHIND : WIN_AHEAD;
    const lo = Math.max(0, ti - behind), hi = Math.min(MAX_F, ti + ahead);
    // порядок: від цілі назовні у напрямку руху (найпотрібніші кадри — першими)
    const order = [];
    if (dir >= 0) { for (let i = ti; i <= hi; i++) order.push(i); for (let i = ti - 1; i >= lo; i--) order.push(i); }
    else { for (let i = ti; i >= lo; i--) order.push(i); for (let i = ti + 1; i <= hi; i++) order.push(i); }
    for (const i of order) {
      if (i < 0 || i > MAX_F) continue;
      if (decoded.has(i) || pending.has(i) || !samples[i]) continue;
      if (decoder.decodeQueueSize > 6) break;
      pending.add(i);
      try { decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, duration: 1, data: samples[i] })); }
      catch (e) { pending.delete(i); }
    }
  }

  function drawCover(src, iw, ih) {
    const cw = canvas.width, ch = canvas.height;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = (cw - dw) / 2, dy = (ch - dh) * 0.42;
    ctx.drawImage(src, dx, dy, dw, dh);
  }

  function drawFrame(f) {
    try { drawCover(f, f.displayWidth || f.codedWidth, f.displayHeight || f.codedHeight); } catch (e) {}
  }
  // Показуємо картинку щойно є перший кадр, але ПРЕЛОАДЕР тримаємо, доки движок не
  // готовий: демукс 1763 семплів іде в головному потоці, і якщо пустити скролити одразу
  // після першого кадру — перші секунди затинаються (заміряно на записі Дениса: 16 із 32
  // затиків були в перші 8 с). Чекаємо: усі семпли розібрані + прогріте вікно декоду.
  const WARM_FRAMES = 24;
  function markDrawn() {
    if (!drawnOnce) { drawnOnce = true; scene.classList.add('has-canvas'); }
    if (!loaderDone && allSamples && decoded.size >= WARM_FRAMES) finishLoader();
  }

  function draw() {
    requestAnimationFrame(draw);
    // плавне доведення поточного кадру до цілі (легкий лерп прибирає «сходинки» від колеса)
    curF += (targetF - curF) * (reduce ? 1 : 0.25);
    const cf = clamp(curF, 0, MAX_F);
    const ti = clamp(Math.round(cf), 0, MAX_F);
    if (_wc && !stillsOnly) {
      // ТЕМПОРАЛЬНА ІНТЕРПОЛЯЦІЯ. Кадрів лише ~133 на в'юпорт скролу, тож при
      // повільному (читацькому) скролі камера дає 20–40 УНІКАЛЬНИХ кадрів/с проти
      // 60 Гц екрана — один кадр висів би 2–3 оновлення поспіль = сходинки.
      // Змішуємо два сусідні кадри за дробовою частиною позиції → рух лишається
      // неперервним на БУДЬ-ЯКІЙ швидкості скролу (на швидкості читається як motion blur).
      const a = Math.floor(cf), b = Math.min(MAX_F, a + 1), t = cf - a;
      const fa = decoded.get(a), fb = decoded.get(b);
      if (fa) {
        drawFrame(fa);
        if (fb && t > 0.02) { ctx.globalAlpha = t; drawFrame(fb); ctx.globalAlpha = 1; }
        markDrawn();
      } else {
        // потрібного кадру ще немає — малюємо найближчий готовий, аби рух не спинявся
        const best = nearestDecoded(ti);
        if (best != null) { drawFrame(decoded.get(best)); markDrawn(); }
      }
      // pump/evict — лише коли цільовий кадр реально змінився (інакше щокадру
      // будували б масив-порядок і сканували кеш дарма).
      if (ti !== lastPumpTi) { lastPumpTi = ti; pump(ti, lastDir); evict(ti); }
    } else if (videoEl && videoReady) {
      // fallback: <video>-scrub (без стрибків на стиках — файл один)
      if (!videoEl.seeking) {
        const t = clamp(curF, 0, MAX_F) / FPS;
        if (Math.abs(videoEl.currentTime - t) > 0.012) { try { videoEl.currentTime = t; } catch (e) {} }
      }
    }
  }

  // ---- завантаження склейки з прогресом ----
  let videoReady = false;
  function loadFlight() {
    if (stillsOnly) { finishLoader(); return; }
    const url = (phoneClass && config.flightMobile) ? config.flightMobile : config.flight;
    if (!url) { finishLoader(); return; }
    fetch(url).then(res => {
      if (!res.ok) throw new Error('flight ' + res.status);
      const total = +(res.headers.get('Content-Length') || 0);
      if (!res.body) return res.arrayBuffer();
      const reader = res.body.getReader();
      let loaded = 0; const chunks = [];
      return (function pumpDL() {
        return reader.read().then(({ done, value }) => {
          if (done) {
            const buf = new Uint8Array(loaded); let off = 0;
            for (const c of chunks) { buf.set(c, off); off += c.length; }
            return buf.buffer;
          }
          chunks.push(value); loaded += value.length;
          // Завантаження — перша фаза прогресу (0→90%); решту добере демукс і прогрів.
          if (total) { const pct = Math.min(90, Math.round(loaded / total * 90)); loaderBar.style.transform = `scaleX(${pct / 100})`; loaderPct.textContent = pct + '%'; }
          return pumpDL();
        });
      })();
    }).then(buf => {
      armLoaderTimeout(8000);
      if (hasWebCodecs) demux(buf);
      else fallbackVideo(buf);
    }).catch(() => { finishLoader(); });
  }

  function demux(arrbuf) {
    const file = MP4Box.createFile();
    file.onError = () => { fallbackVideo(arrbuf); };
    file.onReady = (info) => {
      const vt = (info.videoTracks && info.videoTracks[0]);
      if (!vt) { fallbackVideo(arrbuf); return; }
      const W = vt.video.width, H = vt.video.height;
      decCfg = { codec: vt.codec, codedWidth: W, codedHeight: H, description: descFor(file, vt.id), optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
      decoder = new VideoDecoder({
        output: (frame) => {
          const i = frame.timestamp;
          pending.delete(i);
          if (decoded.has(i)) { try { frame.close(); } catch (e) {} return; }
          decoded.set(i, frame);
          evict(clamp(Math.round(curF), 0, MAX_F));
        },
        error: () => {}
      });
      VideoDecoder.isConfigSupported(decCfg).then(sup => {
        if (!sup || !sup.supported) { fallbackVideo(arrbuf); return; }
        decoder.configure(decCfg);
        file.setExtractionOptions(vt.id, null, { nbSamples: vt.nb_samples || TOTAL_FRAMES });
        file.start();
      }).catch(() => fallbackVideo(arrbuf));
    };
    file.onSamples = (id, user, samps) => {
      for (const s of samps) {
        const idx = s.number;                      // decode-order index (немає B-кадрів → == порядок показу)
        if (idx >= 0 && idx < TOTAL_FRAMES) { samples[idx] = s.data; samplesReady++; }
      }
      // Демукс — друга фаза прогресу (90→97%): він теж триває і теж блокує потік.
      if (!allSamples) {
        const pct = 90 + Math.min(7, Math.round(samplesReady / TOTAL_FRAMES * 7));
        loaderBar.style.transform = `scaleX(${pct / 100})`; loaderPct.textContent = pct + '%';
      }
      if (samplesReady >= TOTAL_FRAMES - 1) { allSamples = true; pump(0, 1); }
      // перший кадр — якнайшвидше
      if (samples[0] && !drawnOnce) pump(0, 1);
    };
    arrbuf.fileStart = 0;
    file.appendBuffer(arrbuf);
    file.flush();
  }

  function descFor(file, trackId) {
    const trak = file.getTrackById(trackId);
    const entries = trak.mdia.minf.stbl.stsd.entries;
    for (const e of entries) {
      const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
      if (box) {
        const DS = (typeof DataStream !== 'undefined') ? DataStream : MP4Box.DataStream;
        const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);   // без 8-байтного заголовка бокса
      }
    }
    return undefined;
  }

  function fallbackVideo(buf) {
    // WebCodecs недоступний / не підтримав кодек → <video>-scrub того ж файлу.
    _wc = false;
    const blob = new Blob([buf], { type: 'video/mp4' });
    const v = document.createElement('video');
    v.className = 'sw-scene__video'; v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.src = URL.createObjectURL(blob);
    v.addEventListener('loadedmetadata', () => { videoReady = true; try { v.currentTime = 0; } catch (e) {} });
    v.addEventListener('seeked', () => { scene.classList.add('has-canvas'); if (!drawnOnce) { drawnOnce = true; finishLoader(); } }, { once: true });
    scene.appendChild(v); videoEl = v;
  }
  Object.defineProperty(window, '__sw_wc', { get: () => _wc, configurable: true });

  let loaderDone = false;
  // Запобіжник: якщо демукс/декод десь застрягне, прелоадер не має висіти вічно —
  // краще пустити на сторінку (кадр уже намальовано), ніж тримати перед бар'єром.
  function armLoaderTimeout(ms) { setTimeout(() => { if (drawnOnce) finishLoader(); }, ms); }

  function finishLoader() {
    if (loaderDone) return; loaderDone = true;
    loaderBar.style.transform = 'scaleX(1)'; loaderPct.textContent = '100%';
    loader.classList.add('is-done');
    setTimeout(() => { try { loader.remove(); } catch (e) {} }, 650);
  }

  seedParticles(particles, reduce || coarse);
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(read); } }, { passive: true });
  function onResize() { if (coarse && window.innerWidth === laidOutW) return; layout(); }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  layout();
  requestAnimationFrame(draw);
  loadFlight();

  // ── Auto-settle ──────────────────────────────────────────────────────────────
  if (!reduce) {
    const IDLE_MS = 220, MS_PER_VH = 1400, SETTLE_MIN = 450, SETTLE_MAX = 1300;
    let lastInputAt = performance.now();
    let lastY = window.scrollY || 0, dir = 1;
    let settling = false, sFrom = 0, sTo = 0, sStart = 0, sDur = 700, programmatic = false;
    const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const markInput = () => { lastInputAt = performance.now(); settling = false; programmatic = false; };
    window.addEventListener('wheel', (e) => { if (e.deltaY) { dir = Math.sign(e.deltaY); lastDir = dir; } markInput(); }, { passive: true });
    window.addEventListener('touchmove', markInput, { passive: true });
    window.addEventListener('touchstart', markInput, { passive: true });
    window.addEventListener('keydown', markInput);
    window.addEventListener('scroll', () => {
      const y = window.scrollY || 0; const d = Math.sign(y - lastY); lastY = y;
      if (programmatic) return;
      if (d) { dir = d; lastDir = d; }
    }, { passive: true });
    function settleTick(now) {
      requestAnimationFrame(settleTick);
      const y = window.scrollY || 0;
      if (settling) {
        programmatic = true;
        const t = Math.min(1, (now - sStart) / sDur);
        window.scrollTo(0, Math.round(sFrom + (sTo - sFrom) * easeInOut(t)));
        if (t >= 1) { settling = false; programmatic = false; lastY = window.scrollY || 0; }
        return;
      }
      if (now - lastInputAt < IDLE_MS) return;
      if (document.querySelector('dialog[open]')) return;
      const to = settleTargetFor(y, SEGMENTS, dir);
      if (to == null) return;
      const vhNow = window.innerHeight || 800;
      sDur = Math.max(SETTLE_MIN, Math.min(SETTLE_MAX, Math.abs(to - y) / vhNow * MS_PER_VH));
      sFrom = y; sTo = to; sStart = now; settling = true;
    }
    requestAnimationFrame(settleTick);
  }

  // ---- helpers ----
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function ctaBtns(cta) {
    let h = '';
    if (cta.primary) h += `<a class="sw-btn sw-btn--primary" href="${esc(cta.primary.href || '#')}">${esc(cta.primary.label)}</a>`;
    if (cta.secondary) h += `<a class="sw-btn sw-btn--ghost" href="${esc(cta.secondary.href || '#')}">${esc(cta.secondary.label)}</a>`;
    return h;
  }
}

function seedParticles(host, reduce) {
  if (!host || reduce) return;
  const kinds = ['dot', 'dot', 'ring'];
  const seeds = [7, 23, 41, 58, 71, 88, 12, 34, 52, 66, 83, 95, 18, 29, 47, 63, 77, 91, 5, 38, 55, 69, 82, 97];
  for (let k = 0; k < 20; k++) {
    const s = document.createElement('span');
    s.className = 'sw-pt sw-pt--' + kinds[k % kinds.length];
    s.style.left = seeds[k % seeds.length] + 'vw';
    s.style.top = ((seeds[(k * 3) % seeds.length] * 1.3) % 100) + 'vh';
    s.style.setProperty('--sw-sc', (0.5 + ((seeds[(k * 5) % seeds.length] % 60) / 60) * 1.1).toFixed(2));
    const dur = 14 + (seeds[(k * 7) % seeds.length] % 22);
    s.style.animationDuration = dur + 's';
    s.style.animationDelay = (-(seeds[(k * 2) % seeds.length] % dur)) + 's';
    host.appendChild(s);
  }
}

function injectCSS() {
  if (document.getElementById('sw-css')) return;
  const css = `
  .sw-root{--sw-bg:#F5EDE0;--sw-ink:#241d2b;--sw-ink-soft:#6a6072;--sw-accent:#8a7bb5;
    --sw-font-display:ui-rounded,"SF Pro Rounded","Segoe UI",system-ui,sans-serif;
    --sw-font-body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    color:var(--sw-ink);font-family:var(--sw-font-body);}
  html,body{margin:0;background:var(--sw-bg,#F5EDE0);overflow-x:hidden;}
  .sw-sky{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:var(--sw-bg);}
  .sw-sky__grad{position:absolute;inset:-10%;background:linear-gradient(178deg,color-mix(in srgb,var(--sw-accent) 12%,var(--sw-bg)) 0%,var(--sw-bg) 55%,color-mix(in srgb,var(--sw-accent) 6%,var(--sw-bg)) 100%);}
  .sw-sky__glow{position:absolute;inset:0;background:radial-gradient(60% 42% at 74% 16%,color-mix(in srgb,var(--sw-accent) 22%,transparent),transparent 70%),radial-gradient(46% 34% at 50% 50%,color-mix(in srgb,#fff 45%,transparent),transparent 70%);}
  .sw-particles{position:absolute;inset:-6% -2%;will-change:transform;}
  .sw-pt{position:absolute;width:13px;height:13px;transform:scale(var(--sw-sc,1));opacity:0;animation:sw-drift linear infinite;}
  .sw-pt::before{content:"";position:absolute;inset:0;border-radius:50%;}
  .sw-pt--dot::before{background:radial-gradient(circle at 34% 30%,color-mix(in srgb,var(--sw-accent) 60%,#000),#000 82%);}
  .sw-pt--ring::before{background:transparent;border:2px solid color-mix(in srgb,var(--sw-accent) 55%,transparent);}
  @keyframes sw-drift{0%{opacity:0;transform:scale(var(--sw-sc)) translate(0,12vh) rotate(0)}12%{opacity:.5}88%{opacity:.45}100%{opacity:0;transform:scale(var(--sw-sc)) translate(4vw,-22vh) rotate(210deg)}}
  .sw-scrollbar{position:fixed;top:0;left:0;right:0;height:3px;z-index:60;background:color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-scrollbar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);}
  .sw-topbar{position:fixed;top:0;left:0;right:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:clamp(14px,2.4vw,26px) clamp(18px,5vw,64px);}
  .sw-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--sw-ink);}
  .sw-brand__mark{width:24px;height:28px;border-radius:7px 7px 10px 10px;background:linear-gradient(160deg,var(--sw-accent),color-mix(in srgb,var(--sw-accent) 60%,#000));box-shadow:0 6px 14px color-mix(in srgb,var(--sw-accent) 40%,transparent);}
  .sw-brand__name{font-family:var(--sw-font-display);font-weight:700;font-size:1.1rem;}
  /* БЕЗ backdrop-filter: блюр над canvas, що перемальовується щокадрово, змушує GPU
     переблюрювати щокадру = ривки. Замість блюру — щільніший фон. */
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 82%,transparent);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;overflow:hidden;}
  .sw-scene__canvas,.sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;}
  .sw-scene__video,.sw-scene__still{object-fit:cover;object-position:center 42%;}
  .sw-scene__canvas{opacity:0;transition:opacity .35s ease;} .sw-scene.has-canvas .sw-scene__canvas{opacity:1;}
  .sw-scene.has-canvas .sw-scene__still{opacity:0;} .sw-scene__still{will-change:transform;transition:opacity .35s ease;}
  .sw-scene__video{z-index:1;} .sw-scene__canvas{z-index:2;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;transform:translateY(-50%);width:min(42vw,460px);opacity:0;will-change:opacity,transform;}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;pointer-events:auto;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 95%,transparent);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .3s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  .sw-loader{position:fixed;inset:0;z-index:200;display:grid;place-items:center;background:var(--sw-bg);transition:opacity .55s ease;}
  .sw-loader.is-done{opacity:0;pointer-events:none;}
  .sw-loader__box{display:flex;flex-direction:column;align-items:center;gap:16px;width:min(74vw,320px);}
  .sw-loader__brand{font-family:var(--sw-font-display);font-weight:700;font-size:1.2rem;color:var(--sw-ink);letter-spacing:.01em;}
  .sw-loader__bar{width:100%;height:4px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--sw-accent) 18%,transparent);}
  .sw-loader__bar span{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:var(--sw-accent);transition:transform .18s ease;}
  .sw-loader__pct{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;color:var(--sw-ink-soft);}
  @media (max-width:860px){
    .sw-nav{display:none;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    .sw-copy{left:clamp(18px,5vw,64px);right:clamp(18px,5vw,64px);top:auto;bottom:clamp(64px,14vh,120px);transform:none;width:auto;max-width:560px;}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  @media (hover:none) and (pointer:coarse){ .sw-route{padding:14px 6px;} .sw-route__dot{width:28px;height:28px;} .sw-btn{padding:15px 26px;} }
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { mountScrollWorld, __test: { settleTargetFor, frameFromMotion } };
if (typeof window !== 'undefined') window.mountScrollWorld = mountScrollWorld;
