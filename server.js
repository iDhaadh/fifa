'use strict';

/**
 * Channel Gateway
 * ----------------
 * Makes in-house HTTP-FLV channels watchable full-screen from any browser
 * (desktop, Android, iPhone) behind an unguessable access token.
 *
 * How it plays everywhere: a per-channel ffmpeg process remuxes the live FLV
 * (H.264 video copied as-is, MP3 audio -> AAC) into HLS. HLS plays natively on
 * iOS Safari and via hls.js on everything else. ffmpeg starts on first viewer
 * and is reaped after a short idle period.
 *
 * Routes:
 *   GET /:token                       -> channel picker
 *   GET /:token/play/:channelId       -> full-screen HLS player
 *   GET /:token/hls/:channelId/:file  -> HLS playlist + segments
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (!config.password) {
  console.error('\n[FATAL] No password set. Add "password" to config.json.\n');
  process.exit(1);
}
// Secret used to sign the auth cookie. Falls back to a random per-boot value
// (which just means everyone re-enters the password after a restart).
const COOKIE_SECRET =
  config.cookieSecret || crypto.randomBytes(24).toString('base64url');

const channelById = new Map(config.channels.map((c) => [c.id, c]));

// --- resolve ffmpeg ---------------------------------------------------------
function resolveFfmpeg() {
  if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) return config.ffmpegPath;
  // On PATH?
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  if (probe.status === 0) {
    const first = String(probe.stdout).split(/\r?\n/).find(Boolean);
    if (first && fs.existsSync(first.trim())) return first.trim();
  }
  // winget install location
  const base = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft/WinGet/Packages'
  );
  try {
    for (const d of fs.readdirSync(base)) {
      if (!d.startsWith('Gyan.FFmpeg')) continue;
      const inner = path.join(base, d);
      for (const v of fs.readdirSync(inner)) {
        const exe = path.join(inner, v, 'bin', 'ffmpeg.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (_) {}
  return 'ffmpeg'; // last resort: hope it's on PATH
}
const FFMPEG = resolveFfmpeg();

// --- HLS session manager ----------------------------------------------------
const HLS_ROOT = path.join(os.tmpdir(), 'channel-gateway-hls');
fs.rmSync(HLS_ROOT, { recursive: true, force: true });
fs.mkdirSync(HLS_ROOT, { recursive: true });

const IDLE_MS = 30000; // stop ffmpeg this long after the last request
const sessions = new Map(); // channelId -> { proc, dir, lastAccess }

function ensureSession(ch) {
  let s = sessions.get(ch.id);
  if (s) {
    s.lastAccess = Date.now();
    return s;
  }
  const dir = path.join(HLS_ROOT, ch.id);
  fs.mkdirSync(dir, { recursive: true });

  // Per-channel override falls back to the global config flag.
  const lowLatency =
    ch.lowLatency !== undefined ? ch.lowLatency : !!config.lowLatency;

  // DEFAULT (recommended): copy the video untouched — zero CPU, no frame
  // dup/drop, no timestamp drift. Segments land on the source's keyframes
  // (~10s here) so live delay is higher, but playback is rock-solid.
  //
  // lowLatency:true re-encodes to force 2s keyframes for lower delay. On this
  // box (1080p25 over RDP, iGPU Quick Sync throttled) the software encode runs
  // below real time and causes the audio delay + freezing — leave it off
  // unless you have a machine that can encode faster than real time.
  const videoArgs = lowLatency
    ? [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-fps_mode', 'cfr', // avoid frame duplication churn
        '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
      ]
    : ['-c:v', 'copy'];
  const hlsTime = '2';
  const hlsList = lowLatency ? '5' : '6';

  const args = [
    '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-rw_timeout', '15000000', // 15s upstream read timeout (microseconds)
    '-i', ch.url,
    ...videoArgs,
    // MP3 -> AAC for iOS; aresample keeps audio locked to the video clock so it
    // can't drift out of sync over a long session.
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k',
    '-af', 'aresample=async=1:min_hard_comp=0.100:first_pts=0',
    '-max_muxing_queue_size', '1024',
    '-f', 'hls',
    '-hls_time', hlsTime,
    '-hls_list_size', hlsList,
    '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg_%d.ts'),
    path.join(dir, 'index.m3u8'),
  ];

  const proc = spawn(FFMPEG, args, { windowsHide: true });
  let errBuf = '';
  proc.stderr.on('data', (d) => {
    errBuf = (errBuf + d).slice(-2000);
  });
  proc.on('exit', (code) => {
    const cur = sessions.get(ch.id);
    if (cur && cur.proc === proc) sessions.delete(ch.id);
    if (code) console.error(`[ffmpeg ${ch.id}] exited ${code}: ${errBuf.trim()}`);
  });

  s = { proc, dir, lastAccess: Date.now() };
  sessions.set(ch.id, s);
  console.log(`[hls] started ffmpeg for ${ch.id}`);
  return s;
}

// Reap idle ffmpeg processes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastAccess > IDLE_MS) {
      console.log(`[hls] stopping idle ffmpeg for ${id}`);
      try { s.proc.kill('SIGKILL'); } catch (_) {}
      sessions.delete(id);
      fs.rm(s.dir, { recursive: true, force: true }, () => {});
    }
  }
}, 10000).unref();

// Wait (up to timeoutMs) for ffmpeg to produce a file on first hit.
function waitForFile(fp, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    (function check() {
      if (fs.existsSync(fp)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 150);
    })();
  });
}

// --- auth (password-only, cookie session) -----------------------------------
const COOKIE_NAME = 'cg_auth';
// The cookie value is an HMAC of the password, so it stays valid until the
// password (or secret) changes, and the plaintext password is never stored
// client-side.
const AUTH_VALUE = crypto
  .createHmac('sha256', COOKIE_SECRET)
  .update(String(config.password))
  .digest('base64url');

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const v = parseCookies(req)[COOKIE_NAME];
  if (!v) return false;
  const a = Buffer.from(v);
  const b = Buffer.from(AUTH_VALUE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function passwordOk(supplied) {
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(String(config.password));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  // For media/API requests answer with a status; for pages, show the login form.
  if (req.path.startsWith('/hls/')) return res.status(401).end();
  return res.status(401).type('html').send(loginPage(req.query.e === '1'));
}

// --- app --------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind Cloudflare Tunnel
app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  res.type('html').send(loginPage(req.query.e === '1'));
});

app.post('/login', (req, res) => {
  if (!passwordOk(req.body && req.body.password)) {
    return res.redirect('/login?e=1');
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${AUTH_VALUE}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${
      60 * 60 * 24 * 30
    }${secure ? '; Secure' : ''}`
  );
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`);
  res.redirect('/login');
});

app.get('/', requireAuth, (_req, res) => {
  res.type('html').send(pickerPage());
});

app.get('/play/:channelId', requireAuth, (req, res) => {
  const ch = channelById.get(req.params.channelId);
  if (!ch) return res.status(404).send('Unknown channel');
  res.type('html').send(playerPage(ch));
});

app.get('/hls/:channelId/:file', requireAuth, async (req, res) => {
  const ch = channelById.get(req.params.channelId);
  if (!ch) return res.status(404).end();

  const file = req.params.file;
  if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.includes('..')) {
    return res.status(400).end();
  }

  const s = ensureSession(ch);
  s.lastAccess = Date.now();
  const fp = path.join(s.dir, file);

  const isPlaylist = file.endsWith('.m3u8');
  // The playlist needs a moment on cold start; segments should already exist.
  const ok = await waitForFile(fp, isPlaylist ? 16000 : 6000);
  if (!ok) return res.status(504).send('Stream warming up, retry');

  res.setHeader(
    'Content-Type',
    isPlaylist ? 'application/vnd.apple.mpegurl' : 'video/mp2t'
  );
  res.setHeader('Cache-Control', isPlaylist ? 'no-cache, no-store' : 'public, max-age=10');
  fs.createReadStream(fp).pipe(res);
});

app.listen(config.port, () => {
  console.log(`Channel Gateway listening on http://localhost:${config.port}`);
  console.log(`ffmpeg: ${FFMPEG}`);
  console.log(`Open locally:  http://localhost:${config.port}/  (password protected)`);
});

process.on('SIGINT', () => {
  for (const s of sessions.values()) try { s.proc.kill('SIGKILL'); } catch (_) {}
  process.exit(0);
});

// --- HTML -------------------------------------------------------------------
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function loginPage(error) {
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.title)}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font:16px/1.4 system-ui,sans-serif;background:#0d1117;color:#e6edf3}
  form{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px;width:300px;
       display:flex;flex-direction:column;gap:14px}
  h1{font-size:18px;font-weight:600;margin:0}
  input{padding:11px 12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:15px}
  input:focus{outline:none;border-color:#58a6ff}
  button{padding:11px;border:0;border-radius:8px;background:#238636;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#2ea043}
  .err{color:#f85149;font-size:13px;margin:0}
</style></head><body>
<form method="POST" action="/login">
  <h1>${esc(config.title)}</h1>
  ${error ? '<p class="err">Wrong password. Try again.</p>' : ''}
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
  <button type="submit">Watch</button>
</form>
</body></html>`;
}

function pickerPage() {
  const items = config.channels
    .map(
      (c) =>
        `<a class="card" href="/play/${encodeURIComponent(c.id)}">
           <div class="dot"></div><span>${esc(c.name)}</span>
         </a>`
    )
    .join('\n');
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(config.title)}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#0d1117;color:#e6edf3;padding:24px}
  header{display:flex;align-items:center;margin:0 0 20px}
  h1{font-size:20px;font-weight:600;margin:0;flex:1}
  .out{color:#8b949e;font-size:13px;text-decoration:none}
  .out:hover{color:#e6edf3}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
  .card{display:flex;align-items:center;gap:10px;padding:16px;background:#161b22;border:1px solid #30363d;
        border-radius:10px;text-decoration:none;color:inherit;transition:.15s}
  .card:hover{border-color:#58a6ff;background:#1c2330}
  .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;flex:none}
</style></head><body>
<header><h1>${esc(config.title)}</h1><a class="out" href="/logout">Log out</a></header>
<div class="grid">${items}</div>
</body></html>`;
}

function playerPage(ch) {
  const src = `/hls/${encodeURIComponent(ch.id)}/index.m3u8`;
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ch.name)}</title>
<style>
  :root{color-scheme:dark}
  html,body{margin:0;height:100%;background:#000;color:#e6edf3;font:15px system-ui,sans-serif}
  #wrap{position:fixed;inset:0;display:flex;flex-direction:column}
  video{flex:1;width:100%;height:100%;background:#000;object-fit:contain}
  #bar{display:flex;align-items:center;gap:12px;padding:8px 14px;background:#0d1117cc;
       position:absolute;top:0;left:0;right:0;transition:opacity .3s;z-index:5}
  #bar.hide{opacity:0;pointer-events:none}
  a,button{color:#e6edf3;background:#21262d;border:1px solid #30363d;border-radius:8px;
           padding:6px 12px;font-size:14px;text-decoration:none;cursor:pointer}
  button:hover,a:hover{border-color:#58a6ff}
  #name{font-weight:600;margin-right:auto}
  #msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
       text-align:center;padding:24px;color:#8b949e;pointer-events:none}
</style></head><body>
<div id="wrap">
  <div id="bar">
    <span id="name">${esc(ch.name)}</span>
    <a href="/">All channels</a>
    <button id="fs">Full screen</button>
  </div>
  <video id="v" autoplay muted playsinline controls></video>
  <div id="msg">Loading…</div>
</div>
<script src="${HLS_JS}"></script>
<script>
(function(){
  var video=document.getElementById('v'), msg=document.getElementById('msg'),
      bar=document.getElementById('bar'), wrap=document.getElementById('wrap');
  var url='${src}';
  function show(t){ msg.textContent=t; msg.style.display=t?'flex':'none'; }
  video.addEventListener('playing',function(){ show(''); });

  function startNative(){ video.src=url; video.play().catch(function(){}); }

  if(window.Hls && Hls.isSupported()){
    var hls=new Hls({lowLatencyMode:false,liveSyncDurationCount:3,liveDurationInfinity:true,
                     maxBufferLength:30,manifestLoadingMaxRetry:6,fragLoadingMaxRetry:6});
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED,function(){ video.play().catch(function(){}); });
    hls.on(Hls.Events.ERROR,function(e,data){
      if(data.fatal){
        show('Reconnecting…');
        if(data.type===Hls.ErrorTypes.NETWORK_ERROR){ hls.startLoad(); }
        else if(data.type===Hls.ErrorTypes.MEDIA_ERROR){ hls.recoverMediaError(); }
        else { try{hls.destroy();}catch(_){} setTimeout(function(){location.reload();},2000); }
      }
    });
  } else if(video.canPlayType('application/vnd.apple.mpegurl')){
    // iOS Safari: native HLS
    startNative();
  } else {
    show('This browser cannot play video. Please update your browser.');
  }

  document.getElementById('fs').onclick=function(){
    if(document.fullscreenElement){ document.exitFullscreen(); }
    else if(wrap.requestFullscreen){ wrap.requestFullscreen(); }
    else if(video.webkitEnterFullscreen){ video.webkitEnterFullscreen(); } // iOS
  };
  video.addEventListener('dblclick',function(){ document.getElementById('fs').click(); });

  var hideT; function poke(){ bar.classList.remove('hide'); clearTimeout(hideT);
    hideT=setTimeout(function(){ if(!video.paused) bar.classList.add('hide'); },2500); }
  ['mousemove','touchstart','keydown'].forEach(function(e){document.addEventListener(e,poke);});
  poke();
})();
</script>
</body></html>`;
}
