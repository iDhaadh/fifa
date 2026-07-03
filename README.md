# Channel Gateway

Make in-house HTTP-FLV channels (e.g. `http://192.168.40.65:8080`) watchable in
full screen from any browser on the internet, behind a single unguessable URL.

```
Browser ──► Cloudflare Tunnel (https) ──► this app (LAN box) ──► 192.168.40.65:8080 (FLV)
  HLS            public hostname        ffmpeg FLV→HLS + token      in-house channel
```

Plays on **iPhone, Android, and desktop**. A per-channel ffmpeg process remuxes
the live FLV (H.264 video copied, MP3 audio → AAC) into HLS, which iOS Safari
plays natively and every other browser plays via hls.js. ffmpeg starts when the
first viewer opens a channel and stops ~30s after the last viewer leaves.

**Requires ffmpeg.** Install once: `winget install Gyan.FFmpeg` (Windows) or
`apt install ffmpeg` (Linux). The app auto-detects it on PATH.

> **Network requirement:** the machine running this app must be able to reach the
> channels' private IPs (`192.168.40.x`). A cloud VM cannot reach your LAN — run
> it on a box inside the office network (or one joined to it via VPN).

## Deploy on Linux (recommended — always-on via systemd)

On a Linux box **that can reach the channel IPs**:

```bash
# 1. Get the code + deps + systemd service in one shot (Debian/Ubuntu):
sudo APP_DIR=/opt/channel-gateway bash -c \
  'git clone https://github.com/iDhaadh/fifa.git /opt/channel-gateway && \
   bash /opt/channel-gateway/deploy/install-linux.sh'

# 2. Set your password + channels:
sudo nano /opt/channel-gateway/config.json      # edit "password" and "channels"
sudo systemctl restart channel-gateway

# 3. Check it:
systemctl status channel-gateway
curl -I http://localhost:8090/login              # expect HTTP 401 (login page)
```

`config.json` is **not** in the repo (it holds your password) — the installer
copies `config.example.json` to `config.json` with a random `cookieSecret`; you
fill in the password and channels. systemd keeps it running across crashes and
reboots — no login required, unlike the Windows Startup-folder method.

### Expose it publicly (Cloudflare Tunnel on Linux)

```bash
# install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# point your existing named tunnel's public hostname at http://localhost:8090
# (same as the Windows setup: service HTTP, URL http://localhost:8090, empty path)
```

## 1. Run the app (on a machine inside the LAN)

```powershell
npm install
npm start
```

Open `http://localhost:8090` — you get a **password prompt**. Viewers enter the
shared `password` from `config.json` (no username); the login is remembered for
30 days per device via a signed cookie.

## 2. Add / edit channels

Copy `config.example.json` to `config.json` and edit:

```json
{
  "port": 8090,
  "password": "your-shared-password",
  "cookieSecret": "a-long-random-string",
  "title": "In-House Channels",
  "lowLatency": false,
  "channels": [
    { "id": "ch1", "name": "Channel 1", "url": "http://192.168.40.65:8080" },
    { "id": "ch2", "name": "Channel 2", "url": "http://192.168.40.66:8080" }
  ]
}
```

Restart after editing. `id` must be URL-safe and unique; `url` is the raw FLV
stream. Changing `password` instantly logs everyone out (the cookie is an HMAC
of the password).

## 3. Expose it publicly with Cloudflare Tunnel

Install cloudflared (one-time):

```powershell
winget install --id Cloudflare.cloudflared
```

Quick tunnel (no Cloudflare account, random temporary hostname — good for testing):

```powershell
cloudflared tunnel --url http://localhost:8090
```

It prints a public URL like `https://random-words.trycloudflare.com` — that's
your shareable link. Visitors open it and enter the password.

Named tunnel (stable hostname, needs a free Cloudflare account + a domain):

```powershell
cloudflared tunnel login
cloudflared tunnel create channels
cloudflared tunnel route dns channels channels.yourdomain.com
cloudflared tunnel run --url http://localhost:8090 channels
```

## Keeping it always-on

The app is installed to auto-start and auto-restart:

- **`run-server.bat`** — runs `node server.js` in a loop, restarting it 3s after
  any crash. All output goes to `server.log`.
- **`start-hidden.vbs`** — launches that loop with no visible console window.
- A copy of `start-hidden.vbs` lives in the user's Startup folder
  (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ChannelGateway.vbs`),
  so it starts automatically **when this user logs in** and survives reboots.

Manual control:

```powershell
# Start (hidden):
wscript "D:\Claud\FIFA\start-hidden.vbs"

# Stop everything:
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'"  | ? { $_.CommandLine -like '*run-server.bat*' } | % { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*server.js*' }      | % { Stop-Process -Id $_.ProcessId -Force }
```

> Starts at **login**, not at the Windows boot screen before anyone logs in. For
> a true headless boot service (no login required) we'd register a Scheduled
> Task running as SYSTEM/at-startup, which needs Administrator rights once.

## Notes & limits

- **Browser support:** universal — iPhone (Safari), Android, and all desktop
  browsers, via HLS.
- **Latency vs. stability:** default is `"lowLatency": false` — video is copied
  untouched (no CPU, no frame drops, no audio drift), but segments fall on the
  source's ~10s keyframes so live delay is ~20–30s. This is the stable mode.
  `"lowLatency": true` re-encodes to force 2s keyframes for lower delay, but it
  only works on a machine that can encode **faster than real time**. On this box
  (1080p25 over RDP, with Quick Sync throttled) the encode runs below real time,
  which causes audio delay and freezing — so it's left off.
- **Security:** anyone with the link can watch. Treat the URL as a password.
  Rotate it with `npm run new-token` (then update `config.json` and restart).
  For real logins instead of a shared link, that's a small add-on.
- **Keep it running:** for an always-on setup, run the app and cloudflared as
  Windows services (e.g. with `nssm`) so they survive reboots.
```
