/* ============================================================================
   scroll-world — portable scroll-scrubbed camera-flight engine
   ----------------------------------------------------------------------------
   Framework-agnostic. Vanilla JS, zero dependencies. It builds its own DOM and
   injects its own (namespaced) CSS into a container you give it, so it drops into
   plain HTML, Next.js (call from a ref/useEffect), Vue (onMounted), a server-
   rendered page, anything.

   USAGE
     mountScrollWorld(document.getElementById('world'), {
       brand: { name: 'Pearl & Co.', href: '#top' },
       diveScroll: 1.3,   // viewport-heights of scroll per dive clip
       connScroll: 0.9,   // ...per connector clip
       hint: 'scroll to fly in',
       nav: true,         // show the top section nav
       atmosphere: true,  // subtle gradient + drifting particles behind the clips
       scrollMobileFactor: 1.2,  // extra scroll distance per segment on mobile (small
                                 // viewports read the same flight as faster; industry
                                 // pattern is a LONGER mobile scroll run)
       sections: [
         { id, label, still, poster, posterMobile, clip, clipMobile, accent,
                          // `poster` = the EXTRACTED FIRST FRAME of the encoded clip
                          // (pipeline.md §5b). Shown while the clip loads, so the
                          // still→video swap is pixel-identical (no crop/render pop).
                          // `posterMobile` = same, extracted from the mobile/portrait
                          // encode (wire it whenever clipMobile has different framing).
                          // Falls back to `still` when absent; `still` remains the
                          // stills-mode / no-clip artwork.
           scroll: 1.6,   // optional per-section override of diveScroll — more scroll
                          // distance = a slower, longer dwell in this scene
           linger: 0.5,   // optional 0..1 — remaps time so the camera settles mid-scene
                          // (exactly where the copy peaks) and moves quicker at the
                          // edges. 0 = linear (default). Keep ≤ 0.6; 1 = full pause.
           eyebrow, title, body, tags:[…],
           cta:{ primary:{label,href}, secondary:{label,href} } }, // last section only
         …
       ],
       connectors: [clipUrl, …],          // length = sections.length - 1 (nulls allowed)
       connectorsMobile: [clipUrl, …],    // optional lighter connectors for phones (same length)

   MOBILE (the clipMobile/connectorsMobile variants are the opt-in mobile tiers;
   the rest of the phone handling below is always on)
     Two independent axes, deliberately separate:
     - CLIP TIER (which file): decided by device class — screen short side ≤600 CSS px
       = phone → `clipMobile`/`posterMobile`; tablets (iPad Pro included) and desktops
       get the full master. NOT decided by pointer type: iPadOS reports a coarse
       pointer and a Mac UA, but has a desktop-class screen + decoder.
     - BEHAVIOUR hardening (how it acts): on any coarse-pointer / ≤860px viewport the
       engine coalesces seeks (never issues a new currentTime while the decoder is
       still `seeking` — fast flicks can't pile up and freeze), takes a coarser seek
       step, keeps the poster up until the clip actually paints, primes each video
       (muted play→pause) on first touch (iOS blank-video fix), lengthens the scroll
       run (`scrollMobileFactor`), drops the drifting particles, and ignores
       URL-bar-only resizes (no scroll jump).
     STILLS MODE (automatic fallback, never configured): the page falls back to the
     stills cross-dissolving as you scroll — no video load or decode — when the user
     asked for it (`prefers-reduced-motion`, data-saver) or the OS blocks video at
     runtime (iOS Low Power Mode rejects even muted play(); detected on first touch).
     Chromium-only network signals (`navigator.connection.saveData`/`effectiveType`)
     are used strictly as downgrade signals — saveData → stills mode, 2g/3g → shrink
     the clip prefetch window. iOS exposes none of these, so the baseline stays
     conservative (posters first, native media prefetch near the viewport) for everyone.
     Nothing here is required — a config with only `clip`/`connectors` still works on
     phones; the mobile variants just make it lighter and smoother.

   THEME (CSS custom properties; set on the container or :root to override)
     --sw-bg         page background (match your scene bg for seamless posters)
     --sw-ink        primary text
     --sw-ink-soft   secondary text
     --sw-accent     default accent (each section overrides via its `accent`)
     --sw-font-display / --sw-font-body

   SEO / STATIC COPY
     The engine builds its DOM client-side, so on its own the page has no crawlable
     copy. Put a plain-markup version of the copy (h1 + per-section h2/p, real links)
     inside the container in a block marked `data-sw-seo` — the engine hides it on
     mount and it never fights the visual layer, but it exists in the served HTML for
     crawlers, link previews, and no-JS visitors (see index-template.html).

   REQUIREMENTS ON YOUR ASSETS
     - desktop clips ~1600×900 CRF 23, -g 8, +faststart, no audio (see pipeline.md)
     - connectors' endpoints are the neighbouring dives' ACTUAL frames (see SKILL Step 5)
     - posters extracted from the ENCODED clips' first frames (pipeline.md §5b)
     - (optional) mobile variants at ~960×540 CRF 25, -g 8 for phone bandwidth
   The engine gives each clip URL directly to <video> and scrubs currentTime. Production
   hosting must preserve HTTP byte-range responses; the encodes use +faststart so metadata
   and the first frame arrive without downloading the whole clip.
   ========================================================================== */

// One filtered page playhead drives media, dissolves, copy and navigation. Keeping these
// helpers pure makes the seam contract regression-testable without a browser.
const SW_PLAYHEAD_RESPONSE = 16;
const SW_MAX_SPEED_VH_S = 6;
const swClamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const swSmooth = x => { x = swClamp(x); return x * x * (3 - 2 * x); };
const swLingerEase = (x, linger) => {
  const L = swClamp(linger);
  const c = x - 0.5;
  return (1 - L) * x + L * (4 * c * c * c + 0.5);
};

function advancePlayhead(current, target, dt, vh, reducedMotion) {
  if (reducedMotion || !Number.isFinite(current) || !Number.isFinite(target)) return target;
  const stepTime = swClamp(dt, 0, 0.1);
  if (!stepTime || Math.abs(target - current) < 0.05) return target;
  const easedStep = (target - current) * (1 - Math.exp(-SW_PLAYHEAD_RESPONSE * stepTime));
  const maxStep = SW_MAX_SPEED_VH_S * Math.max(1, vh) * stepTime;
  const next = current + swClamp(easedStep, -maxStep, maxStep);
  return Math.abs(target - next) < 0.05 ? target : next;
}

// Media keeps moving until the real segment boundary. Holding the endpoint across the
// whole dissolve made every block switch look like a decoder stall even at perfect rAF.
function segmentMotionLocal(y, start, end, fade, linger) {
  const local = swClamp((y - start) / Math.max(1, end - start));
  return linger ? swLingerEase(local, linger) : local;
}

function segmentOpacity(y, start, end, fade) {
  if (fade <= 0) return y >= start && y <= end ? 1 : 0;
  let outside = 0;
  if (y < start) outside = start - y;
  else if (y > end) outside = y - end;
  return swSmooth(1 - outside / fade);
}

function useLightVideoTier(phoneClass, slowConnection, downlinkMbps) {
  const constrainedBandwidth = Number.isFinite(downlinkMbps) && downlinkMbps > 0 && downlinkMbps < 8;
  return !!(phoneClass || slowConnection || constrainedBandwidth);
}

function mountScrollWorld(container, config) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // BEHAVIOUR hardening (seek step, priming, particles, resize gating) keys off input
  // type + viewport: `coarse` is captured once (input type doesn't change mid-session);
  // the ≤860px query is read live via isMobile() so a desktop resize/DevTools toggle
  // switches seek behaviour without a reload.
  const coarse = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const smallMQ = window.matchMedia('(max-width: 860px)');
  const isMobile = () => coarse || smallMQ.matches;
  // CLIP TIER keys off device class, NOT input type: an iPad Pro is coarse-pointer but
  // has a desktop-class screen and decoder — it gets the 1080p master, with the touch
  // hardening above still on. screen.* is stable across rotation and window resizes;
  // a phone's short side is ≤ ~500 CSS px, tablets start at 744.
  const phoneClass = Math.min(screen.width, screen.height) <= 600;
  // Network signals are Chromium-only (iOS/Safari/Firefox expose nothing) — treat them
  // strictly as a *downgrade* signal on top of a conservative default, never as a gate
  // for the good experience.
  const conn = navigator.connection;
  const dataSaver = !!(conn && conn.saveData);
  const slowNet = !!(conn && /^(slow-2g|2g|3g)$/.test(conn.effectiveType || ''));
  // A desktop full Tour consumes ~8.2 Mbps on average. Prefer the 960×540 tier below
  // that measured budget instead of allowing a correct decoder to buffer-stall.
  const lightVideoTier = useLightVideoTier(phoneClass, slowNet, conn && conn.downlink);
  // Stills mode: the page becomes the stills cross-dissolving as you scroll — no video
  // load, no decode. Entered up-front for prefers-reduced-motion and data-saver, and at
  // runtime when iOS Low Power Mode blocks video (see enterStillsMode/primeVideo).
  let stillsOnly = reduce || dataSaver;
  const SECTIONS = config.sections || [];
  const CONNECTORS = config.connectors || [];
  const CONNECTORS_M = config.connectorsMobile || [];
  const DIVE_W = config.diveScroll || 1.3;
  const CONN_W = config.connScroll || 0.9;
  const CROSSFADE = (config.crossfade != null) ? config.crossfade : 0.12;  // seam dissolve width (vh)
  const N = SECTIONS.length;
  if (!N) return;

  injectCSS();
  container.classList.add('sw-root');
  // Server-rendered SEO copy (crawlers/no-JS read it from the HTML); once the
  // engine mounts, the visual layer takes over and the static block hides.
  container.querySelectorAll('[data-sw-seo]').forEach(n => { n.hidden = true; });

  // ---- build the interleaved segment chain: dive0, conn0, dive1, … diveN-1 ----
  const SEGMENTS = [];
  SECTIONS.forEach((s, i) => {
    const dive = { kind: 'dive', si: i, clip: s.clip, clipM: s.clipMobile, still: s.still,
                   poster: s.poster, posterM: s.posterMobile,
                   accent: s.accent, w: s.scroll || DIVE_W, linger: s.linger || 0 };
    SEGMENTS.push(dive);
    s._seg = dive;
    // A connector is optional: if connectors[i] is falsy, the two dives simply
    // crossfade directly (no fly-over). Lets a page complete even when a
    // connector can't be generated (e.g. a content-filter false-positive).
    if (i < N - 1 && CONNECTORS[i]) {
      // Постер конектора — його ВЛАСНИЙ перший кадр (config.connectorPosters);
      // постер наступної сцени — лише фолбек: конектор стартує з кінця попередньої,
      // тож чужий постер на довантаженні показував не той кадр.
      const cp = (config.connectorPosters || [])[i];
      const cpm = (config.connectorPostersMobile || [])[i];
      SEGMENTS.push({ kind: 'conn', si: i, clip: CONNECTORS[i], clipM: CONNECTORS_M[i],
                      still: SECTIONS[i + 1].still, poster: cp || SECTIONS[i + 1].poster,
                      posterM: cpm || SECTIONS[i + 1].posterMobile,
                      accent: SECTIONS[i + 1].accent, w: CONN_W });
    }
  });
  const NSEG = SEGMENTS.length;

  // ---- DOM ----
  const sky = el('div', 'sw-sky');
  if (config.atmosphere !== false) {
    sky.appendChild(el('div', 'sw-sky__grad'));
    sky.appendChild(el('div', 'sw-sky__glow'));
  }
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
  const nav = el('nav', 'sw-nav'); nav.setAttribute('aria-label', 'Chapters');
  if (config.nav !== false) topbar.appendChild(nav);
  let topCtaEl = null;
  if (config.cta && config.cta.label) {
    const c = el('a', 'sw-topcta'); c.href = config.cta.href || '#'; c.textContent = config.cta.label;
    c.style.transition = 'opacity .3s';
    topbar.appendChild(c); topCtaEl = c;
  }

  const stage = el('div', 'sw-stage');
  const copylayer = el('div', 'sw-copylayer');
  const route = el('nav', 'sw-route'); route.setAttribute('aria-label', 'Scenes');
  const hint = el('div', 'sw-hint');
  const hintText = el('span'); hintText.textContent = config.hint || 'scroll'; hint.appendChild(hintText);
  hint.appendChild(el('i'));
  const track = el('div', 'sw-track');

  [sky, scrollbar, topbar, stage, copylayer, route, hint, track].forEach(n => container.appendChild(n));

  // segment scenes
  SEGMENTS.forEach((s, sceneIndex) => {
    const scene = el('div', 'sw-scene'); scene.style.setProperty('--sw-accent', s.accent || '');
    // The later segment is the incoming dissolve layer. This order is invariant, so
    // setting it once avoids a needless style write on every animation frame.
    scene.style.zIndex = String(100 + sceneIndex);
    const img = el('img', 'sw-scene__still'); img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
    // Prefer the extracted-frame poster (pixel-identical to the clip's first frame,
    // so the still→video swap can't pop) — matching the encode the device will get.
    // In stills mode the clip never loads, so the higher-fidelity source still is the
    // better permanent image.
    const pref = lightVideoTier ? (s.posterM || s.poster) : s.poster;
    const posterSrc = (!stillsOnly && pref) ? pref : s.still;
    if (posterSrc) img.src = posterSrc;
    scene.appendChild(img); stage.appendChild(scene);
    s.el = scene; s.img = img; s.video = null; s.hasClip = false;
    s.loading = false; s.ready = false; s.cur = 0; s.target = 0; s.visible = false;
    s.lastMediaTime = 0; s.seekDemandAt = 0; s.loadingStartedAt = 0;
  });

  // per-section copy / route / nav
  const copies = [], dots = [];
  SECTIONS.forEach((s, i) => {
    const c = el('article', 'sw-copy'); c.style.setProperty('--sw-accent', s.accent || '');
    // Перша сцена — це hero сторінки: її заголовок є видимим H1 документа
    // (SEO-блок ховається на mount, тому accessibility tree без цього лишалась без H1)
    const hTag = i === 0 ? 'h1' : 'h2';
    c.innerHTML =
      `<span class="sw-copy__num">${pad(i + 1)} / ${pad(N)}</span>` +
      (s.eyebrow ? `<span class="sw-copy__eyebrow">${esc(s.eyebrow)}</span>` : '') +
      (s.title ? `<${hTag} class="sw-copy__title">${esc(s.title)}</${hTag}>` : '') +
      (s.body ? `<p class="sw-copy__body">${esc(s.body)}</p>` : '') +
      (s.tags && s.tags.length ? `<ul class="sw-copy__tags">${s.tags.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '') +
      (s.cta ? `<div class="sw-copy__cta">${ctaBtns(s.cta)}</div>` : '');
    copylayer.appendChild(c); copies.push(c);

    const dot = el('button', 'sw-route__dot'); dot.style.setProperty('--sw-accent', s.accent || '');
    // Лейбл на мобільних display:none — кнопка без aria-label лишалась безіменною
    dot.setAttribute('aria-label', s.label || ('Scene ' + (i + 1)));
    dot.innerHTML = `<span class="sw-route__label">${esc(s.label || '')}</span><i></i>`;
    dot.addEventListener('click', () => jumpTo(i)); route.appendChild(dot); dots.push(dot);

    if (config.nav !== false) {
      const b = el('button', 'sw-nav__item'); b.textContent = s.label || '';
      b.addEventListener('click', () => jumpTo(i)); nav.appendChild(b);
    }
  });

  // ---- math ----
  const clamp = swClamp;
  const smooth = swSmooth;
  // Per-section dwell: monotone remap of scroll→time so the camera settles mid-scene
  // (where the copy peaks) and moves quicker near the seams. L=0 linear, L=1 full
  // mid-scene pause. f(0)=0, f(1)=1 always, so seam frames are untouched.
  const lingerEase = swLingerEase;
  let vh = window.innerHeight, stageX = 0, totalW = 0, activeIndex = -1;
  let renderY = window.scrollY || window.pageYOffset || 0;
  let scrollTargetY = renderY;
  let travelDirection = 1;
  let lastInputY = scrollTargetY;
  let laidOutW = window.innerWidth;   // width the current layout was computed at (see onResize)

  function layout() {
    vh = window.innerHeight;
    laidOutW = window.innerWidth;
    stageX = window.innerWidth > 860 ? 4 : 0;
    // Small viewports read a camera flight as faster than big ones do, so give each
    // segment more scroll distance on mobile (industry pattern: mobile scroll runs are
    // LONGER than desktop's for the same sequence). Override via scrollMobileFactor.
    const wf = isMobile() ? (config.scrollMobileFactor != null ? config.scrollMobileFactor : 1.2) : 1;
    let off = 0;
    SEGMENTS.forEach(s => { s.start = off * vh; off += s.w * wf; s.end = off * vh; });
    totalW = off;
    track.style.height = (totalW * vh + vh) + 'px';   // +1vh so the last flight completes
    // Geometry changed (rotation/real width resize): synchronize once so the virtual
    // camera cannot interpolate through stale segment coordinates.
    scrollTargetY = window.scrollY || window.pageYOffset || 0;
    renderY = scrollTargetY;
    read(renderY, scrollTargetY);
  }

  function jumpTo(i) {
    const seg = SECTIONS[i]._seg;
    window.scrollTo({ top: seg.start + (seg.end - seg.start) * 0.5, behavior: reduce ? 'auto' : 'smooth' });
  }

  function enterStillsMode() {
    if (stillsOnly) return;
    stillsOnly = true;
    SEGMENTS.forEach(s => unloadClip(s));   // cancel video ranges and release decoders
    read(renderY, scrollTargetY);
  }

  function loadClip(s, preloadMode) {
    if (stillsOnly || s.dead || !s.clip) return;
    const mode = preloadMode === 'metadata' ? 'metadata' : 'auto';
    if (s.video) {
      // Upgrade the imminent clip without resetting its resource selection/currentTime.
      if (mode === 'auto' && s.video.preload !== 'auto') s.video.preload = 'auto';
      return;
    }
    if (s.loading) return;
    s.loading = true;
    s.loadingStartedAt = performance.now();
    // Serve the lighter encode on phones and bandwidth-constrained desktops.
    const url = (lightVideoTier && s.clipM) ? s.clipM : s.clip;
    const generation = (s.videoGen = (s.videoGen || 0) + 1);
    const v = document.createElement('video');
    v.className = 'sw-scene__video';
    v.muted = true;
    v.playsInline = true;
    v.preload = mode;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');

    const current = () => generation === s.videoGen && s.video === v && !stillsOnly;
    const reveal = () => { if (current()) s.el.classList.add('has-clip'); };
    v.addEventListener('loadedmetadata', () => {
      if (!current()) return;
      s.loading = false;
      s.loadingStartedAt = 0;
      s.ready = true;
      // Late-load catch-up uses the already-filtered global playhead. There is no
      // second per-clip easing clock for the video to chase.
      s.cur = s.target;
      const dur = v.duration || 1;
      try { v.currentTime = clamp(s.cur, 0, 0.999) * dur; } catch (e) {}
      s.lastMediaTime = v.currentTime;
      s.seekDemandAt = 0;
    });
    // Both events imply that a decoded current frame exists. Keep the matching poster
    // above the video until one of them fires; this avoids blank iOS media layers.
    v.addEventListener('loadeddata', () => {
      if (!current()) return;
      try { v.pause(); } catch (e) {}
      reveal();
      if (userReady) primeVideo(v);
    }, { once: true });
    v.addEventListener('seeked', reveal, { once: true });
    v.addEventListener('error', () => {
      if (!current()) return;
      s.loading = false;
      s.ready = false;
      s.fails = (s.fails || 0) + 1;
      if (s.fails >= 3) s.dead = true;
      unloadClip(s);
    }, { once: true });

    // Native media loading is deliberately used instead of fetch(...).blob(). A direct
    // URL can paint progressively and lets the browser issue byte-range requests around
    // the requested keyframe; the old path waited for the entire 2–11 MB file first.
    s.el.appendChild(v);
    s.video = v;
    s.hasClip = true;
    v.src = url;
    try { v.load(); } catch (e) {}
  }

  // MediaPool hygiene: keep only the visible segment and its neighbours. Removing src
  // asks the browser to cancel range work and release decoder buffers.
  function unloadClip(s) {
    s.videoGen = (s.videoGen || 0) + 1;
    if (s.video) {
      try { s.video.pause(); } catch (e) {}
      try { s.video.removeAttribute('src'); s.video.load(); } catch (e) {}
      s.video.remove();
    }
    s.el.classList.remove('has-clip');
    s.video = null; s.hasClip = false; s.ready = false; s.loading = false;
    s.lastMediaTime = 0; s.seekDemandAt = 0; s.loadingStartedAt = 0;
  }

  function read(renderAt, inputAt) {
    const y = Number.isFinite(renderAt) ? renderAt : renderY;
    const inputY = Number.isFinite(inputAt) ? inputAt : scrollTargetY;
    const fade = CROSSFADE * vh;
    let ci = 0;
    for (let i = 0; i < NSEG; i++) if (y >= SEGMENTS[i].start) ci = i;

    if (Math.abs(inputY - lastInputY) > 0.5) travelDirection = inputY > lastInputY ? 1 : -1;
    lastInputY = inputY;
    let inputIndex = 0;
    for (let i = 0; i < NSEG; i++) if (inputY >= SEGMENTS[i].start) inputIndex = i;

    // Native video pool: current + both seam neighbours, with the travel-direction
    // neighbour upgraded to `auto`. A distant scrollbar/nav destination may receive
    // metadata on a normal connection, but never competes on a signalled slow network.
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      const nearVisual = Math.abs(i - ci) <= 1;
      const targetHint = !slowNet && i === inputIndex && Math.abs(inputIndex - ci) > 1;
      if (nearVisual || targetHint) {
        const imminent = i === ci || i === ci + travelDirection;
        loadClip(s, imminent ? 'auto' : 'metadata');
      } else if (s.hasClip || s.loading) {
        unloadClip(s);
      }

      const local = segmentMotionLocal(y, s.start, s.end, fade, s.linger || 0);
      s.target = local;
      const op = segmentOpacity(y, s.start, s.end, fade);
      s.el.style.opacity = op; s.visible = op > 0.001;
      if (stillsOnly) {
        // Ken Burns доречний лише в режимі стілів — там нема відео, з яким треба збігатись
        const sc = reduce ? 1 : 1.03 + local * 0.14;
        s.img.style.transform = `translateX(${stageX - 2}vw) scale(${sc.toFixed(3)})`;
      } else {
        // Постер мусить піксельно збігатися з першим кадром кліпа: без трансформацій,
        // інакше still→video підміна «стрибає» геометрично.
        s.img.style.transform = 'none';
      }
    }

    for (let i = 0; i < N; i++) {
      const seg = SECTIONS[i]._seg;
      const pr = clamp((y - seg.start) / (seg.end - seg.start), 0, 1);
      const before = y < seg.start, after = y > seg.end;
      let cop;
      if (i === 0) cop = after ? 0 : smooth(1 - pr / 0.62);            // greets on landing
      else if (i === N - 1) cop = before ? 0 : smooth(pr / 0.4);       // holds CTA at the end
      else cop = (before || after) ? 0 : smooth(1 - Math.abs(pr - 0.5) / 0.5);
      const c = copies[i];
      c.style.opacity = cop;
      // Десктопний CSS центрує блок через translateY(-50%) — інлайн-трансформація не
      // має його перетирати (інакше копі з'їжджає і ріжеться на коротких вікнах).
      const center = isMobile() ? '' : 'translateY(-50%) ';
      c.style.transform = reduce ? (center ? 'translateY(-50%)' : 'none') : center + `translateY(${(0.5 - pr) * 4}vh)`;
      // Невидимий блок не має бути ані клікабельним, ані фокусованим, ані видимим SR.
      // Мутації — ЛИШЕ при зміні стану: щокадрові setAttribute/inert інвалідовували
      // стилі шести блоків на кожен тік скролу (помітний хіт саме на перемиканні).
      const on = cop > 0.5;
      if (c.__swOn !== on) {
        c.__swOn = on;
        c.style.pointerEvents = on ? 'auto' : 'none';
        if (on) { c.inert = false; c.removeAttribute('aria-hidden'); }
        else { c.inert = true; c.setAttribute('aria-hidden', 'true'); }
      }
    }

    const cur = SEGMENTS[ci];
    const near = clamp(cur.kind === 'dive' ? cur.si
      : (((y - cur.start) / (cur.end - cur.start)) > 0.5 ? cur.si + 1 : cur.si), 0, N - 1);
    if (near !== activeIndex) {
      activeIndex = near;
      dots.forEach((d, k) => { d.classList.toggle('is-active', k === near); d.setAttribute('aria-current', k === near ? 'step' : 'false'); });
      nav.querySelectorAll('.sw-nav__item').forEach((n, k) => n.classList.toggle('is-active', k === near));
      container.style.setProperty('--sw-accent', SECTIONS[near].accent || '');
      // Дубль CTA: коли активний фінал зі своїм primary CTA — верхня кнопка ховається
      if (topCtaEl) {
        const hide = near === N - 1;
        topCtaEl.style.opacity = hide ? '0' : '1';
        topCtaEl.style.pointerEvents = hide ? 'none' : 'auto';
      }
    }
    scrollbarFill.style.transform = `scaleX(${clamp(y / (totalW * vh))})`;
    hint.style.opacity = clamp(1 - y / (0.5 * vh));
    if (particles) particles.style.transform = `translate3d(0, ${-y * 0.05}px, 0)`;
  }

  // A single time-based camera playhead is the only smoothing clock. Media position,
  // layer alpha, copy and nav all sample it in this same rAF turn.
  let rafPrevT = 0;
  function raf(now) {
    const dt = rafPrevT ? Math.min(0.1, (now - rafPrevT) / 1000) : 1 / 60;
    rafPrevT = now;
    scrollTargetY = window.scrollY || window.pageYOffset || 0;
    const previousY = renderY;
    renderY = advancePlayhead(renderY, scrollTargetY, dt, vh, reduce);
    if (Math.abs(renderY - previousY) > 0.01 || Math.abs(scrollTargetY - renderY) > 0.01) {
      read(renderY, scrollTargetY);
    }

    // Крок сіку не дрібніший за половину медіа-кадру (24 fps): частіші сіки
    // лише гріють декодер, нових кадрів вони не дають.
    const eps = isMobile() ? 0.045 : 1 / 48;
    for (let i = 0; i < NSEG; i++) {
      const s = SEGMENTS[i];
      // Missing Range support can also leave a direct media request permanently at
      // HAVE_NOTHING without firing an error. A visible poster remains usable, so make
      // that fallback explicit after the metadata grace period.
      if (s.hasClip && s.visible && !s.ready && s.loadingStartedAt && now - s.loadingStartedAt > 3000) {
        enterStillsMode();
        break;
      }
      if (!s.hasClip || !s.ready) continue;
      if (!s.visible && Math.abs(s.cur - s.target) < 0.002) continue;

      // ── Hardware video path: seek directly from the already-smoothed playhead ──
      if (!s.video) continue;
      // Never queue a seek while the decoder is still resolving the last one.
      // On phones a fast flick would otherwise pile up seeks and freeze the clip;
      // target keeps advancing, so we seek to the latest value when it is free.
      s.cur = s.target;
      if (!s.visible) continue;
      const dur = s.video.duration || 1;
      const t = clamp(s.cur, 0, 0.999) * dur;
      const advanced = Math.abs(s.video.currentTime - s.lastMediaTime) > eps * 0.5;
      if (advanced) { s.lastMediaTime = s.video.currentTime; s.seekDemandAt = 0; }
      const gap = Math.abs(s.video.currentTime - t);

      // A CDN without HTTP Range can expose metadata/readyState yet silently ignore
      // random seeks. Detect sustained visible demand and degrade to animated stills
      // instead of leaving the entire journey frozen on frame zero.
      if (gap > 0.15) {
        if (!s.seekDemandAt) s.seekDemandAt = now;
        else if (now - s.seekDemandAt > 1800) { enterStillsMode(); break; }
      } else {
        s.seekDemandAt = 0;
      }
      if (s.video.seeking) continue;
      if (gap > eps) { try { s.video.currentTime = t; } catch (e) {} }
    }
    requestAnimationFrame(raf);
  }

  // iOS needs a user gesture before a muted video will decode/paint reliably. On the
  // first touch we prime every loaded clip (muted play→pause) so the first seek is
  // instant instead of showing a blank frame. `userReady` also makes freshly-loaded
  // clips prime themselves (see loadClip).
  let userReady = false;
  function primeVideo(v) {
    if (!isMobile() || !v) return;
    // A muted, playsinline play() that REJECTS on a user gesture means the OS is
    // blocking video — in practice iOS Low Power Mode, where currentTime scrubbing
    // doesn't work either. Fall back to stills for the whole page instead of showing
    // frozen/blank scenes.
    try { const p = v.play(); if (p && p.then) p.then(() => { try { v.pause(); } catch (e) {} }).catch(() => { enterStillsMode(); }); }
    catch (e) {}
  }
  function onFirstGesture() {
    if (userReady) return;
    userReady = true;
    SEGMENTS.forEach(s => primeVideo(s.video));
  }
  window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', onFirstGesture, { once: true, passive: true });

  // Клавіатурна навігація по сценах: ←/→ (не чіпаємо стрілки вгору/вниз і PgUp/PgDn —
  // ними браузер скролить нативно, і це вже працює зі скрабом)
  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const ae = document.activeElement;
    if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); jumpTo(clamp(activeIndex + 1, 0, N - 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); jumpTo(clamp(activeIndex - 1, 0, N - 1)); }
  });

  // Particles are a per-frame cost we can't afford alongside video scrubbing on a phone.
  seedParticles(particles, reduce || coarse);
  // Mobile browsers fire `resize` every time the URL bar slides in/out. Re-running
  // layout() there rebuilds the track height and yanks the scroll position, so on
  // touch we ignore height-only changes and only relayout when the width actually
  // changes (rotation still comes through orientationchange). layout() records the
  // width it laid out at.
  function onResize() {
    if (coarse && window.innerWidth === laidOutW) return;
    layout();
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', layout);
  window.addEventListener('load', layout);
  layout();
  requestAnimationFrame(raf);

  // Мінімальний публічний інтерфейс для page-рівня (Tour, кастомні контроли):
  // жива геометрія сегментів + jumpTo. Читати ПІСЛЯ mount; значення в px.
  return {
    jumpTo,
    geometry() {
      return {
        vh,
        sections: SECTIONS.map(s => ({ id: s.id, start: s._seg.start, end: s._seg.end })),
        total: totalW * vh,
      };
    },
    isStills: () => stillsOnly,
  };

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
  .sw-root button:focus-visible,.sw-root a:focus-visible{outline:2px solid var(--sw-accent);outline-offset:2px;border-radius:6px;}
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
  .sw-nav{display:flex;gap:4px;padding:5px;background:color-mix(in srgb,#fff 82%,transparent);border:1px solid color-mix(in srgb,var(--sw-accent) 16%,transparent);border-radius:999px;}
  .sw-nav__item{font:inherit;font-size:.82rem;color:var(--sw-ink-soft);border:0;background:transparent;cursor:pointer;padding:7px 14px;border-radius:999px;transition:color .25s,background .25s;}
  .sw-nav__item:hover{color:var(--sw-ink);} .sw-nav__item.is-active{color:#0E1214;background:var(--sw-accent);}
  .sw-topcta{text-decoration:none;font-weight:600;font-size:.9rem;color:#fff;background:var(--sw-ink);padding:10px 20px;border-radius:999px;white-space:nowrap;}
  .sw-stage{position:fixed;inset:0;z-index:10;pointer-events:none;}
  .sw-scene{position:absolute;inset:0;opacity:0;overflow:hidden;will-change:opacity;}
  .sw-scene__video,.sw-scene__still{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;}
  .sw-scene__still{will-change:transform,opacity;z-index:2;transition:opacity .28s ease;} .sw-scene.has-clip .sw-scene__still{opacity:0;} .sw-scene__video{z-index:1;}
  .sw-copylayer{position:fixed;inset:0;z-index:20;pointer-events:none;}
  .sw-copylayer::before{content:"";position:absolute;inset:0;width:min(58vw,780px);background:linear-gradient(90deg,var(--sw-bg) 0%,color-mix(in srgb,var(--sw-bg) 82%,transparent) 34%,color-mix(in srgb,var(--sw-bg) 40%,transparent) 62%,transparent 100%);}
  .sw-copy{position:absolute;left:clamp(18px,5vw,64px);top:50%;transform:translateY(-50%);width:min(42vw,460px);opacity:0;will-change:opacity,transform;}
  .sw-copy__num{font-family:ui-monospace,Menlo,monospace;font-size:.74rem;letter-spacing:.12em;color:var(--sw-ink-soft);}
  .sw-copy__eyebrow{display:block;margin-top:18px;font-family:var(--sw-font-display);font-weight:700;font-size:.8rem;letter-spacing:.16em;text-transform:uppercase;color:var(--sw-accent);}
  .sw-copy__title{font-family:var(--sw-font-display);font-weight:700;color:var(--sw-ink);font-size:clamp(2rem,4.4vw,3.5rem);line-height:1.03;margin:12px 0 0;letter-spacing:-.01em;text-shadow:0 2px 20px color-mix(in srgb,var(--sw-bg) 70%,transparent);}
  .sw-copy__body{margin-top:18px;font-size:clamp(1rem,1.25vw,1.14rem);line-height:1.55;color:color-mix(in srgb,var(--sw-ink) 78%,var(--sw-ink-soft));max-width:40ch;text-shadow:0 1px 12px color-mix(in srgb,var(--sw-bg) 90%,transparent);}
  .sw-copy__tags{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:24px 0 0;padding:0;}
  .sw-copy__tags li{font-size:.82rem;font-weight:600;color:color-mix(in srgb,var(--sw-accent) 70%,#000);padding:7px 14px;border-radius:999px;background:color-mix(in srgb,var(--sw-accent) 14%,#fff);border:1px solid color-mix(in srgb,var(--sw-accent) 30%,transparent);}
  .sw-copy__cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px;}
  .sw-btn{text-decoration:none;font-weight:600;font-size:.95rem;padding:13px 24px;border-radius:999px;transition:transform .2s;}
  .sw-btn--primary{color:#fff;background:var(--sw-ink);} .sw-btn--primary:hover{transform:translateY(-2px);}
  .sw-btn--ghost{color:var(--sw-ink);border:1.5px solid color-mix(in srgb,var(--sw-ink) 25%,transparent);} .sw-btn--ghost:hover{transform:translateY(-2px);}
  .sw-route{position:fixed;right:clamp(14px,2.4vw,30px);top:50%;z-index:40;transform:translateY(-50%);display:flex;flex-direction:column;gap:22px;padding:18px 10px;}
  .sw-route::before{content:"";position:absolute;left:50%;top:22px;bottom:22px;width:2px;transform:translateX(-50%);background:var(--sw-accent);opacity:.28;}
  .sw-route__dot{position:relative;border:0;background:transparent;cursor:pointer;width:14px;height:14px;display:grid;place-items:center;}
  .sw-route__dot i{width:9px;height:9px;border-radius:50%;background:color-mix(in srgb,var(--sw-accent) 40%,transparent);transition:transform .3s,background .3s,box-shadow .3s;}
  .sw-route__dot:hover i{transform:scale(1.25);background:var(--sw-accent);}
  .sw-route__dot.is-active i{background:var(--sw-accent);transform:scale(1.4);box-shadow:0 0 0 5px color-mix(in srgb,var(--sw-accent) 22%,transparent);}
  .sw-route__label{position:absolute;right:24px;top:50%;transform:translateY(-50%) translateX(6px);white-space:nowrap;font-size:.78rem;font-weight:600;color:var(--sw-ink);background:color-mix(in srgb,#fff 94%,transparent);padding:5px 11px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;border:1px solid color-mix(in srgb,var(--sw-accent) 14%,transparent);}
  .sw-route__dot:hover .sw-route__label,.sw-route__dot.is-active .sw-route__label{opacity:1;transform:translateY(-50%) translateX(0);}
  .sw-hint{position:fixed;left:50%;bottom:26px;z-index:30;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;font-size:.76rem;letter-spacing:.14em;text-transform:uppercase;color:var(--sw-ink-soft);transition:opacity .3s;}
  .sw-hint i{width:22px;height:34px;border-radius:12px;border:2px solid color-mix(in srgb,var(--sw-ink) 28%,transparent);position:relative;}
  .sw-hint i::after{content:"";position:absolute;left:50%;top:7px;width:4px;height:7px;border-radius:2px;background:var(--sw-accent);transform:translateX(-50%);animation:sw-wheel 1.7s ease-in-out infinite;}
  @keyframes sw-wheel{0%{opacity:0;top:6px}40%{opacity:1}100%{opacity:0;top:17px}}
  .sw-track{position:relative;z-index:1;width:100%;pointer-events:none;}
  @media (max-width:860px){
    .sw-nav{display:none;}
    .sw-copylayer::before{width:100%;height:60%;top:auto;bottom:0;background:linear-gradient(0deg,var(--sw-bg) 8%,color-mix(in srgb,var(--sw-bg) 70%,transparent) 46%,transparent 100%);}
    /* Anchor copy to the bottom, clear of the home indicator / collapsing URL bar.
       dvh + env() are progressive: browsers that lack them keep the vh fallback line. */
    .sw-copy{left:clamp(18px,5vw,64px);right:clamp(18px,5vw,64px);top:auto;bottom:clamp(64px,14vh,120px);transform:none;width:auto;max-width:560px;}
    .sw-copy{bottom:calc(clamp(56px,12dvh,110px) + env(safe-area-inset-bottom));}
    .sw-copy__title{font-size:clamp(1.9rem,7.5vw,2.7rem);}
    .sw-copy__body{max-width:none;font-size:clamp(.98rem,3.6vw,1.1rem);} .sw-scene__video,.sw-scene__still{object-position:center 46%;}
    .sw-hint{bottom:calc(20px + env(safe-area-inset-bottom));}
    .sw-route{gap:16px;right:6px;} .sw-route__label{display:none;}
  }
  /* Portrait phones crop a 16:9 clip hard; keep the framing centred so the focal
     subject (which the camera dives toward) stays in view. */
  @media (max-width:860px) and (orientation:portrait){
    .sw-scene__video,.sw-scene__still{object-position:center 44%;}
  }
  /* Touch: give the route dots a finger-sized hit area without growing the visible dot. */
  @media (hover:none) and (pointer:coarse){
    .sw-route{padding:14px 6px;}
    .sw-route__dot{width:28px;height:28px;}
    .sw-btn{padding:15px 26px;}
  }
  @media (prefers-reduced-motion:reduce){ .sw-hint i::after{animation:none;} .sw-pt{display:none;} }
  `;
  // Wrap in a cascade layer so the page's own theme tokens (unlayered
  // :root / .sw-root { --sw-bg / --sw-ink / --sw-accent … }) always win over
  // these defaults, regardless of injection order. Enables clean dark themes.
  const style = document.createElement('style'); style.id = 'sw-css';
  style.textContent = '@layer sw {\n' + css + '\n}';
  document.head.appendChild(style);
}

// Expose runtime plus the pure timeline seam for deterministic regression tests.
const __test = { advancePlayhead, segmentMotionLocal, segmentOpacity, useLightVideoTier };
if (typeof module !== 'undefined' && module.exports) module.exports = { mountScrollWorld, __test };
if (typeof window !== 'undefined') window.mountScrollWorld = mountScrollWorld;
