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
const ENVATO_EMAIL = process.env.ENVATO_EMAIL;
const ENVATO_PASSWORD = process.env.ENVATO_PASSWORD;
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
    const expiresAt = payload.exp * 1000;
    const isValid = Date.now() < expiresAt - 60_000;
    console.log(`[auth] envatoid valid: ${isValid}, expires: ${new Date(expiresAt).toISOString()}`);
    return isValid;
  } catch { return false; }
}

function parseCookieString(cookieStr, domain = '.envato.com') {
  return cookieStr.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return { name: name.trim(), value: rest.join('=').trim(), domain };
  }).filter(c => c.name);
}

async function getCookies() {
  if (areCookiesValid(savedCookies)) return savedCookies;
  throw new Error('No valid session. Please call /set-cookie-string first.');
}

function selectBestAsset(assets) {
  const priority = ['2k', '2048', '1080p', '1080', 'hd'];
  const non4k = assets.filter(a => {
    const label = (a.label || a.resolution || '').toLowerCase();
    return !label.includes('4k') && !label.includes('3840') && !label.includes('uhd');
  });
  if (non4k.length === 0) { console.log('[quality] Only 4K, using it'); return assets[0]; }
  for (const p of priority) {
    const match = non4k.find(a => (a.label || a.resolution || '').toLowerCase().includes(p));
    if (match) { console.log(`[quality] Selected: ${match.label || match.resolution}`); return match; }
  }
  return non4k[0];
}

async function downloadEnvatoFile(itemUrl, cookies) {
  const b = await getBrowser();
  const page = await b.newPage();
  let downloadUrl = null;

  try {
    // Устанавливаем куки для всех доменов Envato
    const domains = ['elements.envato.com', 'app.envato.com', '.envato.com'];
    for (const domain of domains) {
      for (const cookie of cookies) {
        try {
          await page.setCookie({ ...cookie, domain });
        } catch {}
      }
    }

    // Перехватываем download.data ответы
    const downloadDataResponses = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('download.data')) {
        try {
          const text = await response.text();
          downloadDataResponses.push(text);
          console.log('[intercept] download.data caught:', text.substring(0, 100));
        } catch {}
      }
    });

    // Конвертируем elements.envato.com -> app.envato.com
    const appUrl = itemUrl.includes('elements.envato.com')
      ? itemUrl.replace('elements.envato.com', 'app.envato.com')
      : itemUrl;

    console.log('[download] Navigating to:', appUrl);
    await page.goto(appUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    console.log('[download] Page URL:', page.url());
    console.log('[download] Page title:', await page.title());

    // Ищем и нажимаем кнопку Download
    const downloadBtn = await page.$('button[class*="download"], a[class*="download"], button[data-testid*="download"]')
      .catch(() => null);

    if (downloadBtn) {
      console.log('[download] Found download button, clicking...');
      await downloadBtn.click();
      await new Promise(r => setTimeout(r, 3000));
    } else {
      // Пробуем найти по тексту
      const clicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, a')];
        const btn = btns.find(b => {
          const text = b.textContent.trim().toLowerCase();
          return text.includes('download') && !text.includes('free');
        });
        if (btn) { btn.click(); return true; }
        return false;
      });
      console.log('[download] Click by text:', clicked);
      if (clicked) await new Promise(r => setTimeout(r, 3000));
    }

    // Проверяем перехваченные ответы
    const findUrl = (arr) => {
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === 'downloadUrl' && typeof arr[i+1] === 'string') return arr[i+1];
        if (Array.isArray(arr[i])) { const f = findUrl(arr[i]); if (f) return f; }
        if (arr[i] && typeof arr[i] === 'object') { const f = findUrl(Object.values(arr[i])); if (f) return f; }
      }
      return null;
    };

    if (downloadDataResponses.length > 0) {
      try { downloadUrl = findUrl(JSON.parse(downloadDataResponses[0])); } catch {}
      console.log('[download] URL from intercept:', downloadUrl ? 'found' : 'not found');
    }

    // Если клик не дал результата — пробуем прямой API вызов
    if (!downloadUrl) {
      console.log('[download] Trying direct API call...');

      // Достаём itemUuid из страницы
      const pageData = await page.evaluate(() => {
        try { return JSON.stringify(window.__remixContext); } catch { return null; }
      });

      let itemUuid = null;
      let assets = [];

      if (pageData) {
        const find = (obj, d = 0) => {
          if (!obj || d > 10) return;
          if (typeof obj === 'object') {
            if (obj.itemUuid) itemUuid = obj.itemUuid;
            if (obj.assets && Array.isArray(obj.assets)) assets = obj.assets;
            if (obj.videoAssets && Array.isArray(obj.videoAssets)) assets = obj.videoAssets;
            Object.values(obj).forEach(v => find(v, d + 1));
          }
        };
        find(JSON.parse(pageData));
      }

      // Fallback: из URL
      if (!itemUuid) {
        const m = page.url().match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        if (m) itemUuid = m[1];
      }

      console.log('[download] itemUuid:', itemUuid, '| assets:', assets.length);

      if (itemUuid) {
        let selectedAssetUuid = null;
        if (assets.length > 0) {
          const chosen = selectBestAsset(assets);
          selectedAssetUuid = chosen.assetUuid || chosen.uuid || chosen.id;
          console.log('[download] Selected asset UUID:', selectedAssetUuid);
        }

        const itemType = appUrl.includes('stock-video') ? 'stock-video' :
                         appUrl.includes('music') ? 'music' :
                         appUrl.includes('sound-effects') ? 'sound-effects' : 'stock-video';

        let apiUrl = `https://app.envato.com/download.data?itemUuid=${itemUuid}&itemType=${itemType}&_routes=routes%2Fdownload%2Froute`;
        if (selectedAssetUuid) apiUrl += `&assetUuid=${selectedAssetUuid}`;

        console.log('[download] API URL:', apiUrl);

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
        console.log('[download.data] status:', resp.status, '| response:', text.substring(0, 300));

        try { downloadUrl = findUrl(JSON.parse(text)); } catch (e) {
          console.error('[download.data] parse error:', e.message, '| raw:', text.substring(0, 200));
        }
      }
    }

    if (!downloadUrl) throw new Error('Could not obtain download URL');

    console.log('[download] Got URL:', downloadUrl.substring(0, 80) + '...');

    const urlObj = new URL(downloadUrl);
    const filename = decodeURIComponent(urlObj.pathname.split('/').pop() || `envato-${Date.now()}.mov`);
    const filePath = path.join(DOWNLOAD_DIR, filename);

    console.log('[download] Downloading file to:', filePath);
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`File download failed: ${fileResp.status}`);
    fs.writeFileSync(filePath, Buffer.from(await fileResp.arrayBuffer()));

    const sizeMB = fs.statSync(filePath).size / 1024 / 1024;
    console.log(`[download] Done: ${sizeMB.toFixed(1)} MB`);
    return { filePath, filename, sizeMB };

  } finally {
    await page.close();
  }
}

async function convertToMp4IfNeeded(filePath, sizeMB) {
  if (sizeMB <= 1024) { return { filePath, converted: false }; }
  const outPath = filePath.replace(/\.[^.]+$/, '_compressed.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-i', filePath, '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', outPath]);
    proc.stderr.on('data', d => process.stdout.write(d));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  const newSize = fs.statSync(outPath).size / 1024 / 1024;
  fs.unlinkSync(filePath);
  return { filePath: outPath, converted: true, sizeMB: newSize };
}

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

app.get('/', (req, res) => res.json({ ok: true, status: 'running' }));

app.get('/screenshot', (req, res) => {
  if (!existsSync('/tmp/login-debug.png')) return res.status(404).json({ error: 'No screenshot' });
  res.setHeader('Content-Type', 'image/png');
  createReadStream('/tmp/login-debug.png').pipe(res);
});

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

app.post('/set-cookie-string', async (req, res) => {
  if (req.query.token !== LOGIN_TOKEN) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { cookieString } = req.body;
  if (!cookieString) return res.status(400).json({ ok: false, error: 'cookieString required' });
  savedCookies = parseCookieString(cookieString);
  const valid = areCookiesValid(savedCookies);
  console.log(`[set-cookie-string] ${savedCookies.length} cookies, valid: ${valid}`);
  res.json({ ok: true, sessionValid: valid, cookiesCount: savedCookies.length });
});

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

  console.log('[/download] Request:', url);
  let filePath = null;

  try {
    const cookies = await getCookies();
    const result = await downloadEnvatoFile(url, cookies);

    filePath = result.filePath;
    const converted = await convertToMp4IfNeeded(result.filePath, result.sizeMB);
    filePath = converted.filePath;

    const finalSize = fs.statSync(filePath).size;
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', finalSize);
    res.setHeader('X-Converted', converted.converted ? 'true' : 'false');
    res.setHeader('X-File-Size-MB', (finalSize / 1024 / 1024).toFixed(1));

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => cleanup(filePath));
    stream.on('error', () => cleanup(filePath));

  } catch (e) {
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
