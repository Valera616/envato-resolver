import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn } from 'child_process';
import fs, { createReadStream, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

const LOGIN_TOKEN = process.env.LOGIN_TOKEN;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

let browser = null;
let savedCookies = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    console.log('[browser] Started');
  }
  return browser;
}

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

// Главная функция — получить downloadUrl через Puppeteer
async function getDownloadUrl(envatoUrl, cookies) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Устанавливаем куки
    for (const cookie of cookies) {
      for (const domain of ['.envato.com', 'elements.envato.com', 'app.envato.com']) {
        try { await page.setCookie({ ...cookie, domain }); } catch {}
      }
    }

    // Перехватываем download.data ответы
    let downloadUrl = null;
    page.on('response', async (response) => {
      if (response.url().includes('download.data') && !downloadUrl) {
        try {
          const text = await response.text();
          console.log('[intercept] download.data:', text.substring(0, 200));
          const parsed = JSON.parse(text);
          const find = (arr) => {
            if (!Array.isArray(arr)) return null;
            for (let i = 0; i < arr.length; i++) {
              if (arr[i] === 'downloadUrl' && typeof arr[i+1] === 'string') return arr[i+1];
              if (Array.isArray(arr[i])) { const f = find(arr[i]); if (f) return f; }
              if (arr[i] && typeof arr[i] === 'object') { const f = find(Object.values(arr[i])); if (f) return f; }
            }
            return null;
          };
          downloadUrl = find(parsed);
        } catch(e) { console.error('[intercept] parse error:', e.message); }
      }
    });

    // Шаг 1: Открываем elements.envato.com — он редиректит на app.envato.com
    console.log('[step1] Navigating to:', envatoUrl);
    await page.goto(envatoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    const appUrl = page.url();
    console.log('[step1] Redirected to:', appUrl);

    // Шаг 2: Нажимаем кнопку Download чтобы вызвать download.data
    const clicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a')];
      // Ищем зелёную кнопку Download
      const btn = btns.find(b => {
        const text = b.textContent.trim().toLowerCase();
        return (text.startsWith('download') || text === 'download 1080p' || text === 'download 4k' || text === 'download 2k');
      });
      if (btn) {
        console.log('Clicking:', btn.textContent.trim());
        btn.click();
        return btn.textContent.trim();
      }
      return null;
    });

    console.log('[step2] Clicked button:', clicked);
    await new Promise(r => setTimeout(r, 4000));

    if (downloadUrl) {
      console.log('[result] downloadUrl found via intercept');
      return { downloadUrl, appUrl };
    }

    // Шаг 3: Если перехват не сработал — пробуем прямой API запрос
    console.log('[step3] Trying direct API...');
    const itemUuid = appUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
    console.log('[step3] itemUuid:', itemUuid);

    if (!itemUuid) throw new Error('Could not extract itemUuid from URL: ' + appUrl);

    const itemType = appUrl.includes('stock-video') ? 'stock-video' :
                     appUrl.includes('music') ? 'music' :
                     appUrl.includes('sound-effects') ? 'sound-effects' : 'stock-video';

    const apiUrl = `https://app.envato.com/download.data?itemUuid=${itemUuid}&itemType=${itemType}&_routes=routes%2Fdownload%2Froute`;
    console.log('[step3] API URL:', apiUrl);

    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(apiUrl, {
      headers: {
        'accept': '*/*',
        'cookie': cookieStr,
        'referer': appUrl,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
    });

    const text = await resp.text();
    console.log('[step3] API status:', resp.status, '| response:', text.substring(0, 300));

    const find = (arr) => {
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === 'downloadUrl' && typeof arr[i+1] === 'string') return arr[i+1];
        if (Array.isArray(arr[i])) { const f = find(arr[i]); if (f) return f; }
        if (arr[i] && typeof arr[i] === 'object') { const f = find(Object.values(arr[i])); if (f) return f; }
      }
      return null;
    };

    try {
      downloadUrl = find(JSON.parse(text));
    } catch(e) {
      throw new Error('API parse error: ' + e.message + ' | raw: ' + text.substring(0, 200));
    }

    if (!downloadUrl) throw new Error('downloadUrl not found in API response: ' + text.substring(0, 200));

    return { downloadUrl, appUrl };

  } finally {
    await page.close();
  }
}

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

async function convertToMp4IfNeeded(filePath, sizeMB) {
  if (sizeMB <= 1024) return { filePath, converted: false };
  const outPath = filePath.replace(/\.[^.]+$/, '_compressed.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-i', filePath, '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outPath]);
    proc.stderr.on('data', d => process.stdout.write(d));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
  });
  const newSize = fs.statSync(outPath).size / 1024 / 1024;
  fs.unlinkSync(filePath);
  return { filePath: outPath, converted: true, sizeMB: newSize };
}

// ═══════════ ROUTES ═══════════

app.get('/', (req, res) => res.json({ ok: true, status: 'running' }));

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
  res.json({ ok: true, sessionValid: valid, expiresAt, cookiesCount: savedCookies?.length || 0 });
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

// Только получить downloadUrl (без скачивания) — для отладки
app.get('/get-download-url', async (req, res) => {
  if (req.query.token !== LOGIN_TOKEN) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { url } = req.query;
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  if (!areCookiesValid(savedCookies)) return res.status(401).json({ ok: false, error: 'No valid session. Call /set-cookie-string first.' });

  try {
    const result = await getDownloadUrl(url, savedCookies);
    res.json({ ok: true, ...result });
  } catch(e) {
    console.error('[get-download-url] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Скачать файл
app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
  if (!areCookiesValid(savedCookies)) return res.status(401).json({ ok: false, error: 'No valid session. Call /set-cookie-string first.' });

  console.log('[/download]', url);
  let filePath = null;

  try {
    const { downloadUrl } = await getDownloadUrl(url, savedCookies);

    const urlObj = new URL(downloadUrl);
    const filename = decodeURIComponent(urlObj.pathname.split('/').pop() || `envato-${Date.now()}.mov`);
    filePath = path.join(DOWNLOAD_DIR, filename);

    console.log('[/download] Downloading:', filename);
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status}`);
    fs.writeFileSync(filePath, Buffer.from(await fileResp.arrayBuffer()));

    const sizeMB = fs.statSync(filePath).size / 1024 / 1024;
    console.log(`[/download] Done: ${sizeMB.toFixed(1)} MB`);

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
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Running on port ${PORT}`);
  await getBrowser();
  console.log('[server] Ready. Use /set-cookie-string to set session.');
});
