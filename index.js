import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import { execSync, spawn } from 'child_process';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { spawn } from 'child_process';
import fs, { createReadStream, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
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
    const payload = JSON.parse(
      Buffer.from(envatoid.value.split('.')[1], 'base64').toString()
    );
    const expiresAt = payload.exp * 1000;
    const isValid = Date.now() < expiresAt - 60_000;
    console.log(`[auth] envatoid expires at ${new Date(expiresAt).toISOString()}, valid: ${isValid}`);
    return isValid;
  } catch {
    return false;
  }
}

async function login() {
  console.log('[auth] Logging in...');
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto('https://elements.envato.com/sign-in', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Закрываем cookie banner если есть
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const accept = btns.find(b => b.textContent.trim() === 'Accept Cookies');
      if (accept) accept.click();
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 1000));

    // Ждём поле username
    await page.waitForSelector('input[name="username"]', { timeout: 30000 });

    // Вводим через React-совместимый способ (nativeInputValueSetter)
    await page.evaluate((email, password) => {
      const setReactValue = (el, val) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        nativeSetter.set.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const usernameEl = document.querySelector('input[name="username"]');
      const passwordEl = document.querySelector('input[name="password"]');
      if (usernameEl) setReactValue(usernameEl, email);
      if (passwordEl) setReactValue(passwordEl, password);
    }, ENVATO_EMAIL, ENVATO_PASSWORD);

    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: '/tmp/login-debug.png', fullPage: true });

    // Нажимаем Sign in
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    ]);

    await new Promise(r => setTimeout(r, 3000));

    // Промежуточная страница "Great to have you back!"
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('[auth] Page after submit:', pageText.substring(0, 150));

    if (pageText.includes('Great to have you back') || pageText.includes('Sign in')) {
      console.log('[auth] Found intermediate page, clicking Sign in...');
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, a')];
        const signIn = btns.find(b => b.textContent.trim() === 'Sign in');
        if (signIn) signIn.click();
      });
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));
    }

    await page.screenshot({ path: '/tmp/login-after.png', fullPage: true });
    console.log('[auth] Post-login URL:', page.url());

    const cookies = await page.cookies('https://elements.envato.com', 'https://app.envato.com');

    if (!areCookiesValid(cookies)) {
      throw new Error('Login succeeded but envatoid cookie is missing or invalid');
    }

    savedCookies = cookies;
    console.log(`[auth] Login OK, got ${cookies.length} cookies`);
    return cookies;
  } finally {
    await page.close();
  }
}

async function getCookies(forceRelogin = false) {
  if (!forceRelogin && areCookiesValid(savedCookies)) {
    return savedCookies;
  }
  return await login();
}

function selectBestAsset(assets) {
  const priority = ['2k', '2048', '1080p', '1080', 'hd'];
  const non4k = assets.filter(a => {
    const label = (a.label || a.resolution || '').toLowerCase();
    return !label.includes('4k') && !label.includes('3840') && !label.includes('uhd');
  });
  if (non4k.length === 0) {
    console.log('[quality] Only 4K available, using it');
    return assets[0];
  }
  for (const p of priority) {
    const match = non4k.find(a => {
      const label = (a.label || a.resolution || '').toLowerCase();
      return label.includes(p);
    });
    if (match) {
      console.log(`[quality] Selected: ${match.label || match.resolution}`);
      return match;
    }
  }
  return non4k[0];
}

async function downloadEnvatoFile(itemUrl, cookies) {
  const b = await getBrowser();
  const page = await b.newPage();
  let downloadUrl = null;

  try {
    await page.setCookie(...cookies);

    const downloadDataResponses = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('download.data')) {
        try {
          const text = await response.text();
          downloadDataResponses.push(text);
          console.log('[intercept] Caught download.data response');
        } catch {}
      }
    });

    await page.goto(itemUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Парсим itemUuid и assets из window.__remixContext
    const pageData = await page.evaluate(() => {
      try { return JSON.stringify(window.__remixContext); } catch { return null; }
    });

    let itemUuid = null;
    let assets = [];

    if (pageData) {
      const parsed = JSON.parse(pageData);
      const findAssets = (obj, depth = 0) => {
        if (!obj || depth > 10) return;
        if (typeof obj === 'object') {
          if (obj.itemUuid) itemUuid = obj.itemUuid;
          if (obj.assets && Array.isArray(obj.assets)) assets = obj.assets;
          if (obj.videoAssets && Array.isArray(obj.videoAssets)) assets = obj.videoAssets;
          Object.values(obj).forEach(v => findAssets(v, depth + 1));
        }
      };
      findAssets(parsed);
    }

    if (!itemUuid) {
      const match = page.url().match(/([0-9a-f-]{36})/);
      if (match) itemUuid = match[1];
    }

    console.log('[parse] itemUuid:', itemUuid, '| assets:', assets.length);

    // Если уже поймали ответ от download.data
    if (downloadDataResponses.length > 0) {
      const findUrl = (arr) => {
        if (!Array.isArray(arr)) return null;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === 'downloadUrl' && typeof arr[i + 1] === 'string') return arr[i + 1];
          if (Array.isArray(arr[i])) { const f = findUrl(arr[i]); if (f) return f; }
          if (arr[i] && typeof arr[i] === 'object') { const f = findUrl(Object.values(arr[i])); if (f) return f; }
        }
        return null;
      };
      try { downloadUrl = findUrl(JSON.parse(downloadDataResponses[0])); } catch {}
    }

    // Если нет — запрашиваем download.data вручную
    if (!downloadUrl && itemUuid) {
      let selectedAssetUuid = null;
      if (assets.length > 0) {
        const chosen = selectBestAsset(assets);
        selectedAssetUuid = chosen.assetUuid || chosen.uuid || chosen.id;
      }

      const itemType = itemUrl.includes('stock-video') ? 'stock-video' :
                       itemUrl.includes('music') ? 'music' :
                       itemUrl.includes('sound-effects') ? 'sound-effects' : 'stock-video';

      let apiUrl = `https://app.envato.com/download.data?itemUuid=${itemUuid}&itemType=${itemType}&_routes=routes%2Fdownload%2Froute`;
      if (selectedAssetUuid) apiUrl += `&assetUuid=${selectedAssetUuid}`;

      console.log('[download] Requesting:', apiUrl);
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const resp = await fetch(apiUrl, {
        headers: {
          'accept': '*/*',
          'cookie': cookieStr,
          'referer': itemUrl,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
        },
      });

      const text = await resp.text();
      console.log('[download.data] Response:', text.substring(0, 200));

      const findUrl = (arr) => {
        if (!Array.isArray(arr)) return null;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === 'downloadUrl' && typeof arr[i + 1] === 'string') return arr[i + 1];
          if (Array.isArray(arr[i])) { const f = findUrl(arr[i]); if (f) return f; }
          if (arr[i] && typeof arr[i] === 'object') { const f = findUrl(Object.values(arr[i])); if (f) return f; }
        }
        return null;
      };

      try { downloadUrl = findUrl(JSON.parse(text)); } catch (e) {
        console.error('[download.data] Parse error:', e.message);
      }
    }

    if (!downloadUrl) throw new Error('Could not obtain download URL');

    console.log('[download] Got URL:', downloadUrl.substring(0, 80) + '...');

    const urlObj = new URL(downloadUrl);
    const rawFilename = urlObj.pathname.split('/').pop() || `envato-${Date.now()}.mov`;
    const filename = decodeURIComponent(rawFilename);
    const filePath = path.join(DOWNLOAD_DIR, filename);

    console.log('[download] Downloading to:', filePath);
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const sizeMB = fs.statSync(filePath).size / 1024 / 1024;
    console.log(`[download] Done: ${sizeMB.toFixed(1)} MB`);

    return { filePath, filename, sizeMB };

  } finally {
    await page.close();
  }
}

async function convertToMp4IfNeeded(filePath, sizeMB) {
  if (sizeMB <= 1024) {
    console.log('[ffmpeg] File is under 1GB, skipping conversion');
    return { filePath, converted: false };
  }

  console.log(`[ffmpeg] File is ${sizeMB.toFixed(0)}MB > 1GB, converting...`);
  const outPath = filePath.replace(/\.[^.]+$/, '_compressed.mp4');

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', filePath, '-c:v', 'libx264', '-crf', '23',
      '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', '-y', outPath,
    ]);
    proc.stderr.on('data', d => process.stdout.write(d));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
  });

  const newSize = fs.statSync(outPath).size / 1024 / 1024;
  console.log(`[ffmpeg] Done: ${newSize.toFixed(1)} MB`);
  fs.unlinkSync(filePath);
  return { filePath: outPath, converted: true, sizeMB: newSize };
}

function cleanup(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('[cleanup] Error:', e.message);
  }
}

// ═══════════ ROUTES ═══════════

app.get('/', (req, res) => res.json({ ok: true, status: 'running' }));

app.get('/screenshot', (req, res) => {
  const p = '/tmp/login-debug.png';
  if (!existsSync(p)) return res.status(404).json({ error: 'No screenshot' });
  res.setHeader('Content-Type', 'image/png');
  createReadStream(p).pipe(res);
});

app.get('/screenshot2', (req, res) => {
  const p = '/tmp/login-after.png';
  if (!existsSync(p)) return res.status(404).json({ error: 'No screenshot' });
  res.setHeader('Content-Type', 'image/png');
  createReadStream(p).pipe(res);
});

app.get('/login', async (req, res) => {
  if (req.query.token !== LOGIN_TOKEN) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const cookies = await login();
    res.json({ ok: true, cookiesCount: cookies.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/status', (req, res) => {
  const valid = areCookiesValid(savedCookies);
  const envatoid = savedCookies?.find(c => c.name === 'envatoid');
  let expiresAt = null;
  if (envatoid) {
    try {
      const payload = JSON.parse(Buffer.from(envatoid.value.split('.')[1], 'base64').toString());
      expiresAt = new Date(payload.exp * 1000).toISOString();
    } catch {}
  }
  res.json({ ok: true, sessionValid: valid, expiresAt, cookiesCount: savedCookies?.length || 0 });
});

app.post('/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url is required' });

  let itemUrl = url.includes('elements.envato.com')
    ? url.replace('elements.envato.com', 'app.envato.com')
    : url;

  console.log('[/download] Request for:', itemUrl);
  let filePath = null;

  try {
    let cookies = await getCookies();
    let result;
    try {
      result = await downloadEnvatoFile(itemUrl, cookies);
    } catch (e) {
      if (e.message.includes('401') || e.message.includes('403') || e.message.includes('sign-in')) {
        cookies = await getCookies(true);
        result = await downloadEnvatoFile(itemUrl, cookies);
      } else throw e;
    }

    filePath = result.filePath;
    const converted = await convertToMp4IfNeeded(result.filePath, result.sizeMB);
    filePath = converted.filePath;

    const finalSize = fs.statSync(filePath).size;
    const filename = path.basename(filePath);

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
  try {
    await getCookies();
    console.log('[server] Auto-login on startup: OK');
  } catch (e) {
    console.error('[server] Auto-login failed:', e.message);
  }
});
