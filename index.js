import express from 'express';
import { spawn } from 'child_process';
import fs, { createReadStream, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

const LOGIN_TOKEN = process.env.LOGIN_TOKEN;
const PROXY_URL = process.env.PROXY_URL;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

let savedCookies = null;

function areCookiesValid(cookies) {
  if (!cookies || cookies.length === 0) return false;
  const envatoid = cookies.find(c => c.name === 'envatoid');
  if (!envatoid) return false;
  try {
    const payload = JSON.parse(Buffer.from(envatoid.value.split('.')[1], 'base64').toString());
    const isValid = Date.now() < payload.exp * 1000 - 60_000;
    console.log(`[auth] valid: ${isValid}, expires: ${new Date(payload.exp * 1000).toISOString()}`);
    return isValid;
  } catch { return false; }
}

function parseCookieString(cookieStr) {
  return cookieStr.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return { name: name.trim(), value: rest.join('=').trim(), domain: '.envato.com' };
  }).filter(c => c.name);
}

function getCookieStr(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function proxyFetch(url, options = {}) {
  const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
  return fetch(url, { ...options, agent });
}

async function getDownloadUrl(envatoUrl, cookies) {
  const cookieStr = getCookieStr(cookies);
  const baseHeaders = {
    'accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
    'accept-language': 'en-US,en;q=0.9',
    'cookie': cookieStr,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'cache-control': 'no-cache',
  };

  console.log('[step1] Following redirect:', envatoUrl);
  const redirectResp = await proxyFetch(envatoUrl, { headers: baseHeaders, redirect: 'follow' });
  const finalUrl = redirectResp.url;
  console.log('[step1] Final URL:', finalUrl, 'Status:', redirectResp.status);

  let itemUuid = finalUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];

  if (!itemUuid) {
    const html = await redirectResp.text();
    itemUuid = html.match(/itemUuid["s:]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
    console.log('[step1] UUID from HTML:', itemUuid);
  }

  if (!itemUuid) throw new Error('Could not extract itemUuid from: ' + finalUrl);
  console.log('[step1] itemUuid:', itemUuid);

  const itemType = finalUrl.includes('stock-video') ? 'stock-video' :
                   finalUrl.includes('music') ? 'music' :
                   finalUrl.includes('sound-effects') ? 'sound-effects' : 'stock-video';

  const apiUrl = `https://app.envato.com/download.data?itemUuid=${itemUuid}&itemType=${itemType}&_routes=routes%2Fdownload%2Froute`;
  console.log('[step2] API:', apiUrl);

  const apiResp = await proxyFetch(apiUrl, {
    headers: {
      'accept': '*/*',
      'cookie': cookieStr,
      'referer': finalUrl,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  });

  const text = await apiResp.text();
  console.log('[step2] Status:', apiResp.status, '| Response:', text.substring(0, 300));

  const findUrl = (arr) => {
    if (!Array.isArray(arr)) return null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === 'downloadUrl' && typeof arr[i+1] === 'string') return arr[i+1];
      if (Array.isArray(arr[i])) { const f = findUrl(arr[i]); if (f) return f; }
      if (arr[i] && typeof arr[i] === 'object') { const f = findUrl(Object.values(arr[i])); if (f) return f; }
    }
    return null;
  };

  let downloadUrl = null;
  try { downloadUrl = findUrl(JSON.parse(text)); }
  catch(e) { throw new Error('Parse error: ' + text.substring(0, 200)); }

  if (!downloadUrl) throw new Error('downloadUrl not found. Response: ' + text.substring(0, 200));
  console.log('[step2] downloadUrl found!');
  return { downloadUrl, itemUuid, appUrl: finalUrl };
}

async function convertToMp4IfNeeded(filePath, sizeMB) {
  if (sizeMB <= 1024) return { filePath, converted: false };
  const outPath = filePath.replace(/\.[^.]+$/, '_compressed.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-i', filePath, '-c:v', 'libx264', '-crf', '23',
      '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outPath]);
    proc.stderr.on('data', d => process.stdout.write(d));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
  });
  const newSize = fs.statSync(outPath).size / 1024 / 1024;
  fs.unlinkSync(filePath);
  return { filePath: outPath, converted: true, sizeMB: newSize };
}

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

app.get('/', (req, res) => res.json({ ok: true, status: 'running', proxy: !!PROXY_URL }));

app.get('/status', (req, res) => {
  const valid = areCookiesValid(savedCookies);
  const envatoid = savedCookies?.find(c => c.name === 'envatoid');
  let expiresAt = null;
  if (envatoid) {
    try {
      const p = JSON.parse(Buffer.from(envatoid.value.split('.')[1], 'base64').toString());
      expiresAt = new Date(p.exp * 1000).toISOString();
    } catch {}
  }
  res.json({ ok: true, sessionValid: valid, expiresAt, cookiesCount: savedCookies?.length || 0, proxy: !!PROXY_URL });
});

app.post('/set-cookie-string', (req, res) => {
  if (req.query.token !== LOGIN_TOKEN) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { cookieString } = req.body;
  if (!cookieString) return res.status(400).json({ ok: false, error: 'cookieString required' });
  savedCookies = parseCookieString(cookieString);
  const valid = areCookiesValid(savedCookies);
  console.log(`[cookies] ${savedCookies.length} set, valid: ${valid}`);
  res.json({ ok: true, sessionValid: valid, cookiesCount: savedCookies.length });
});

app.get('/get-download-url', async (req, res) => {
  if (req.query.token !== LOGIN_TOKEN) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  if (!areCookiesValid(savedCookies)) return res.status(401).json({ ok: false, error: 'No valid session' });
  try {
    const result = await getDownloadUrl(url, savedCookies);
    res.json({ ok: true, ...result });
  } catch(e) {
    console.error('[get-download-url]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  if (!areCookiesValid(savedCookies)) return res.status(401).json({ ok: false, error: 'No valid session' });
  let filePath = null;
  try {
    const { downloadUrl } = await getDownloadUrl(url, savedCookies);
    const urlObj = new URL(downloadUrl);
    const filename = decodeURIComponent(urlObj.pathname.split('/').pop() || `envato-${Date.now()}.mov`);
    filePath = path.join(DOWNLOAD_DIR, filename);
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status}`);
    fs.writeFileSync(filePath, Buffer.from(await fileResp.arrayBuffer()));
    const sizeMB = fs.statSync(filePath).size / 1024 / 1024;
    const converted = await convertToMp4IfNeeded(filePath, sizeMB);
    filePath = converted.filePath;
    const finalSize = fs.statSync(filePath).size;
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', finalSize);
    res.setHeader('X-File-Size-MB', (finalSize / 1024 / 1024).toFixed(1));
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => cleanup(filePath));
    stream.on('error', () => cleanup(filePath));
  } catch(e) {
    console.error('[/download] Error:', e.message);
    if (filePath) cleanup(filePath);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Running on port ${PORT}`);
  console.log(`[server] Proxy: ${PROXY_URL ? 'configured ✓' : 'NOT configured ✗'}`);
});
