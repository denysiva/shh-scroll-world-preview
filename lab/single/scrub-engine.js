/* ============================================================================
   scroll-world — SINGLE-FILE варіант рушія (лаб)
   ----------------------------------------------------------------------------
   Ключова відмінність від сегментного blob-рушія: увесь проліт — ОДИН
   безперервний відеофайл (усі сцени + перельоти склеєні й перекодовані all-intra:
   кожен кадр ключовий). Тому:
     • НЕМАЄ перемикань між відеофайлами → фізично неможливий «стрибок» на
       переходах між сценами (сцен на рівні файлу більше не існує — це один політ);
     • будь-яка позиція скролу перемотується миттєво й точно (кожен кадр
       самодостатній) → зникає посмикування при скрабі.
   Скрол мапиться лінійно на currentTime одного відео. Копі-блоки/навігація/
   авто-доведення лишаються тими самими, лише прив'язані до часових діапазонів
   кадрів усередині єдиного файлу.

   config:
     flight / flightMobile   — URL склеєного all-intra відео (десктоп / телефон)
     fps                     — кадрів/с у склейці (для мапи кадр→час)
     segFrames               — [к-сть кадрів кожного сегмента] у порядку польоту
                               (dive, conn, dive, conn, …, dive); index-aligned із
                               SEGMENTS, які рушій будує із sections+connectors
     poster / posterMobile   — постер (перший кадр), показується поки вантажиться blob
     решта (brand, cta, sections, connectors, diveScroll, connScroll, …) — як у
     сегментному рушії; connectors тут потрібні лише для довжини ланцюга (значення
     можуть бути будь-якими truthy).
   ========================================================================== */

// Чиста, тестована логіка авто-доведення (та сама, що в blob-рушії): якщо y стоїть
// у зоні переходу (kind='conn'), ДОКІНЧУЄ політ до МЕЖІ сцени в напрямку руху.
function settleTargetFor(y, segments, dir) {
  if (!segments || !segments.length) return null;
  let ci = 0;
  for (let i = 0; i < segments.length; i++) if (y >= segments[i].start) ci = i;
  const seg = segments[ci];
  if (!seg || seg.kind !== 'conn') return null;         // не в переході — не чіпаємо
  const to = dir >= 0 ? seg.end : seg.start;            // межа сцени в напрямку руху
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

  // ---- ланцюг сегментів (dive0, conn0, dive1, …) — геометрія скролу й авто-доведення ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    const dive = { kind: 'dive', si: i, accent: s.accent, w: s.scroll || DIVE_W, linger: s.linger || 0 };
    SEGMENTS.push(dive); s._seg = dive;
    if (i < N - 1 && CONNECTORS[i]) {
      SEGMENTS.push({ kind: 'conn', si: i, accent: SECTIONS[i + 1].accent, w: CONN_W });
    }
  });
  const NSEG = SEGMENTS.length;

  // ---- часова мапа: кумулятивні кадри на межах кожного сегмента ----
  // cumF[i] = кадр початку сегмента i; cumF[NSEG] = загальна к-сть кадрів.
  const cumF = [0];
  for (let i = 0; i < NSEG; i++) cumF.push(cumF[i] + (SEG_FRAMES[i] || 0));
  const TOTAL_FRAMES = cumF[NSEG] || 1;
  // Ціль перемотки не заходить за останній валідний кадр (інакше seek у порожнечу).
  const MAX_T = Math.max(0, (TOTAL_FRAMES - 1)) / FPS;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) { sky.appendChild(el('div', 'sw-sky__grad')); sky.appendChild(el('div', 'sw-sky__glow')); }
  const particles = el('div', 'sw-particles'); sky.appendChild(particles);

  const scrollbar = el('div', 'sw-scrollbar');
  const scrollbarFill = el('span'); scrollbar.appendChild(scrollbarFill);

  const topbar = el('div', 'sw-topbar');
  if (config.brand) {
    const brand = el('a', 'sw-brand'); brand.href = (config.brand.href || '#');
    brand.appendChild(el('span', 'sw-brand__mark'));
    const nm = el('span', 'sw-brand__name'); nm.textContent = config.brand.name || ''; brand.appendChild(nm);
    topbar.appendChild(brand);
  }
  const nav = el('nav', 'sw-nav'); if (config.nav !== false) topbar.appendChild(nav);
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label; topbar.appendChild(c);
  }

  const stage = el('div', 'sw-stage');
  // ЄДИНА сцена — один постер + одне відео, завжди видимі (без перемикань).
  const scene = el('div', 'sw-scene'); scene.style.opacity = 1; scene.style.zIndex = 120;
  const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async';
  const posterSrc = phoneClass ? (config.posterMobile || config.poster) : config.poster;
  if (posterSrc) img.src = posterSrc;
  scene.appendChild(img); stage.appendChild(scene);
  let video = null, ready = false, curT = 0, targetT = 0;

  const copylayer = el('div', 'sw-copylayer');
  const route = el('div', 'sw-route');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText); hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  // ---- прелоадер (реальний прогрес завантаження склейки) ----
  const loader = el('div', 'sw-loader');
  loader.innerHTML =
    `<div class="sw-loader__box">` +
    `<span class="sw-loader__brand">${esc((config.brand && config.brand.name) || '')}</span>` +
    `<div class="sw-loader__bar"><span></span></div>` +
    `<span class="sw-loader__pct">0%</span></div>`;
  const loaderBar = loader.querySelector('.sw-loader__bar span');
  const loaderPct = loader.querySelector('.sw-loader__pct');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track, loader].forEach(n => container.appendChild(n));

  // per-section копі / маршрут / нав
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

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });

  // ---- math ----
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
  const lingerEase = (x, L) => { L = clamp(L); const c = x - 0.5; return (1 - L) * x + L * (4 * c * c * c + 0.5); };
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1, ticking = false;
  let laidOutW = window.innerWidth;

  function layout() {
    vh = window.innerHeight; laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    const wf = isMobile() ? (config.scrollMobileFactor != null ? config.scrollMobileFactor : 1.2) : 1;
    let off = 0;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w * wf; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';
    read();
  }

  function jumpTo(i) {
    const seg = SECTIONS[i]._seg;
    window.scrollTo({ top: seg.start + (seg.end - seg.start) * 0.5, behavior: reduce ? 'auto' : 'smooth' });
  }

  // Глобальна ціль часу з позиції скролу.
  function timeForScroll(y) {
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;
    const s = SEGMENTS[ci];
    const local = clamp((y - s.start) / (s.end - s.start), 0, 1);
    const p = s.linger ? lingerEase(local, s.linger) : local;
    const f = cumF[ci] + p * (cumF[ci + 1] - cumF[ci]);   // кадр
    return { t: clamp(f / FPS, 0, MAX_T), ci };
  }

  function read() {
    const y = window.scrollY || window.pageYOffset;
    const tm = timeForScroll(y);
    targetT = tm.t;
    const ci = tm.ci;

    // Постер (поки немає відео) — легкий Ken-Burns за загальним прогресом.
    if (!ready) {
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
    const near = clamp(cur.kind === 'dive' ? cur.si
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);
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

  function raf() {
    if (video && ready) {
      const eps = isMobile() ? 0.03 : 0.012;   // ~пів кадра допуску
      curT += (targetT - curT) * (reduce ? 1 : 0.2);
      if (!video.seeking) {
        const t = clamp(curT, 0, MAX_T);
        if (Math.abs(video.currentTime - t) > eps) { try { video.currentTime = t; } catch (e) {} }
      }
    }
    requestAnimationFrame(raf);
  }

  // ---- завантаження склейки з прогресом ----
  function loadFlight() {
    if (stillsOnly) { loader.classList.add('is-done'); return; }
    const url = (phoneClass && config.flightMobile) ? config.flightMobile : config.flight;
    if (!url) { loader.classList.add('is-done'); return; }
    fetch(url).then(res => {
      if (!res.ok) throw new Error('flight ' + res.status);
      const total = +(res.headers.get('Content-Length') || 0);
      if (!res.body || !total) return res.blob();       // без прогресу — просто blob
      const reader = res.body.getReader();
      let loaded = 0; const chunks = [];
      return (function pump() {
        return reader.read().then(({ done, value }) => {
          if (done) return new Blob(chunks, { type: 'video/mp4' });
          chunks.push(value); loaded += value.length;
          const pct = Math.min(99, Math.round(loaded / total * 100));
          loaderBar.style.transform = `scaleX(${pct / 100})`;
          loaderPct.textContent = pct + '%';
          return pump();
        });
      })();
    }).then(blob => {
      const v = document.createElement('video');
      v.className = 'sw-scene__video';
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      v.src = URL.createObjectURL(blob);
      v.addEventListener('loadedmetadata', () => {
        ready = true;
        try { v.currentTime = 0; } catch (e) {}
      });
      v.addEventListener('seeked', () => { scene.classList.add('has-clip'); finishLoader(); }, { once: true });
      scene.appendChild(v); video = v;
    }).catch(() => { finishLoader(); });   // упало — лишаємось на постері (Ken-Burns)
  }

  let loaderDone = false;
  function finishLoader() {
    if (loaderDone) return; loaderDone = true;
    loaderBar.style.transform = 'scaleX(1)'; loaderPct.textContent = '100%';
    loader.classList.add('is-done');
    setTimeout(() => { try { loader.remove(); } catch (e) {} }, 650);
  }

  // iOS: прайм відео на першому дотику (muted play→pause), інакше muted-scrub може лишитись пустим.
  let userReady = false;
  function onFirstGesture() {
    if (userReady) return; userReady = true;
    if (video && isMobile()) {
      try { const p = video.play(); if (p && p.then) p.then(() => { try { video.pause(); } catch (e) {} }).catch(() => { stillsOnly = true; }); } catch (e) {}
    }
  }
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

  seedParticles(particles, reduce || coarse);
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(read); } }, { passive: true });
  function onResize() { if (coarse && window.innerWidth === laidOutW) return; layout(); }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  layout();
  requestAnimationFrame(raf);
  loadFlight();

  // ── Auto-settle: доводимо політ до сцени, якщо зупинився В ЗОНІ ПЕРЕХОДУ ──────
  if (!reduce) {
    const IDLE_MS = 220;
    const MS_PER_VH = 1400;
    const SETTLE_MIN = 450, SETTLE_MAX = 1300;
    let lastInputAt = performance.now();
    let lastY = window.scrollY || 0, dir = 1;
    let settling = false, sFrom = 0, sTo = 0, sStart = 0, sDur = 700, programmatic = false;
    const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const markInput = () => { lastInputAt = performance.now(); settling = false; programmatic = false; };
    window.addEventListener('wheel', (e) => { if (e.deltaY) dir = Math.sign(e.deltaY); markInput(); }, { passive: true });
    window.addEventListener('touchmove', markInput, { passive: true });
    window.addEventListener('touchstart', markInput, { passive: true });
    window.addEventListener('keydown', markInput);
    window.addEventListener('scroll', () => {
      const y = window.scrollY || 0; const d = Math.sign(y - lastY); lastY = y;
      if (programmatic) return;
      if (d) dir = d;
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
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(10px);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#fff;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;overflow:hidden;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
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
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 85%,transparent);backdrop-filter:blur(6px);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
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
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  @media (max-width:860px) and (orientation:portrait){ .sw-scene__video,.sw-scene__still{object-position:center 44%;} }
  @media (hover:none) and (pointer:coarse){ .sw-route{padding:14px 6px;} .sw-route__dot{width:28px;height:28px;} .sw-btn{padding:15px 26px;} }
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { mountScrollWorld, __test: { settleTargetFor } };
if (typeof window !== 'undefined') window.mountScrollWorld = mountScrollWorld;
