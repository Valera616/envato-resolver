import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream, existsSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

const LOGIN_TOKEN = process.env.LOGIN_TOKEN;
const ENVATO_EMAIL = process.env.ENVATO_EMAIL;
const ENVATO_PASSWORD = process.env.ENVATO_PASSWORD;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

let browser = null;
let savedCookies = null; // Куки в памяти (не на диске)

// ─────────────────────────────────────────
// BROWSER INIT
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// ПРОВЕРКА: живы ли куки (по envatoid JWT)
// ─────────────────────────────────────────
function areCookiesValid(cookies) {
  if (!cookies || cookies.length === 0) return false;
  const envatoid = cookies.find(c => c.name === 'envatoid');
  if (!envatoid) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(envatoid.value.split('.')[1], 'base64').toString()
    );
    const expiresAt = payload.exp * 1000;
    const isValid = Date.now() < expiresAt - 60_000; // 1 мин запас
    console.log(`[auth] envatoid expires at ${new Date(expiresAt).toISOString()}, valid: ${isValid}`);
    return isValid;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────
// ЛОГИН через Puppeteer → сохраняем куки в память
// ─────────────────────────────────────────
async function login() {
  console.log('[auth] Logging in...');
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto('https://elements.envato.com/sign-in', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.screenshot({ path: '/tmp/login-debug.png', fullPage: true });
    console.log('[auth] Screenshot saved to /tmp/login-debug.png');

// Закрываем cookie banner если есть
    await new Promise(r => setTimeout(r, 2000));
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const accept = btns.find(b => b.textContent.trim() === 'Accept Cookies');
      if (accept) accept.click();
}).catch(() => {});

await new Promise(r => setTimeout(r, 1000));

// Вводим логин и пароль
await page.waitForSelector('input[name="username"]', { timeout: 30000 });
await page.type('input[name="username"]', ENVATO_EMAIL, { delay: 40 });
await page.type('input[name="password"]', ENVATO_PASSWORD, { delay: 40 });

await page.screenshot({ path: '/tmp/login-debug.png', fullPage: true });

// Нажимаем Sign in
await Promise.all([
  page.click('button[type="submit"]'),
  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
]);

    await new Promise(r => setTimeout(r, 3000));

    // Envato показывает промежуточную страницу "Great to have you back!" с кнопкой Sign in
    const confirmBtn = await page.$('button, a').catch(() => null);
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('[auth] Intermediate page text:', pageText.substring(0, 100));

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

// ─────────────────────────────────────────
// ПОЛУЧИТЬ КУКИ (из памяти или залогиниться)
// ─────────────────────────────────────────
async function getCookies(forceRelogin = false) {
  if (!forceRelogin && areCookiesValid(savedCookies)) {
    return savedCookies;
  }
  return await login();
}

// ─────────────────────────────────────────
// СДЕЛАТЬ ЗАПРОС С КУКАМИ
// ─────────────────────────────────────────
async function envatoFetch(url, cookies) {
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(url, {
    headers: {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'cookie': cookieStr,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  });
  return res;
}

// ─────────────────────────────────────────
// ПАРСИНГ СТРАНИЦЫ ENVATO → список качеств
// ─────────────────────────────────────────
async function getAvailableQualities(itemUrl, cookies) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Устанавливаем куки в браузер
    await page.setCookie(...cookies);

    // Перехватываем network запросы чтобы поймать список assets
    const qualityData = [];

    page.on('response', async (response) => {
      const url = response.url();
      // Ищем запрос который возвращает данные о файле (обычно это JSON с assets)
      if (url.includes('app.envato.com') && url.includes('stock-video')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json') || ct.includes('x-script')) {
            const text = await response.text().catch(() => '');
            if (text.includes('assetUuid') || text.includes('resolution')) {
              console.log('[parse] Found asset data in:', url);
              qualityData.push(text);
            }
          }
        } catch {}
      }
    });

    await page.goto(itemUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Ищем данные прямо в DOM — Remix/React apps обычно хранят state в __remixContext
    const remixData = await page.evaluate(() => {
      try {
        return JSON.stringify(window.__remixContext || window.__INITIAL_DATA__ || null);
      } catch {
        return null;
      }
    });

    // Также ищем кнопку download и dropdown
    const downloadOptions = await page.evaluate(() => {
      const options = [];
      // Ищем все варианты качества в dropdown
      document.querySelectorAll('[data-testid*="quality"], [class*="quality"], [class*="resolution"]').forEach(el => {
        options.push(el.textContent.trim());
      });
      return options;
    });

    console.log('[parse] Download options found in DOM:', downloadOptions);

    // Нажимаем на стрелку dropdown чтобы получить все варианты
    const dropdownBtn = await page.$('[aria-haspopup="listbox"], [class*="dropdown"] button, button[class*="chevron"], .download-dropdown, [class*="DownloadDropdown"]');
    if (dropdownBtn) {
      await dropdownBtn.click();
      await new Promise(r => setTimeout(r, 1000));
    }

    // Получаем все варианты после открытия dropdown
    const allOptions = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('li[role="option"], [role="listbox"] li, [class*="dropdown"] li, [class*="DropdownItem"]').forEach(el => {
        items.push(el.textContent.trim());
      });
      return items;
    });

    console.log('[parse] All dropdown options:', allOptions);

    return {
      remixData: remixData ? JSON.parse(remixData) : null,
      qualityOptions: allOptions.length > 0 ? allOptions : downloadOptions,
      rawData: qualityData,
    };

  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────
// ВЫБОР ЛУЧШЕГО КАЧЕСТВА (не 4K, предпочитаем 2K/1080P)
// ─────────────────────────────────────────
function selectBestAsset(assets) {
  // assets = [{assetUuid, resolution, label, sizeBytes}, ...]
  // Приоритет: 2K > 1080P > всё остальное кроме 4K
  const priority = ['2k', '2160p_2k', '2048', '1080p', '1080', 'hd'];

  // Сортируем: сначала исключаем 4K
  const non4k = assets.filter(a => {
    const label = (a.label || a.resolution || '').toLowerCase();
    return !label.includes('4k') && !label.includes('3840') && !label.includes('uhd');
  });

  if (non4k.length === 0) {
    // Только 4K доступен — берём его
    console.log('[quality] Only 4K available, using it');
    return assets[0];
  }

  // Ищем по приоритету
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

  // Берём первый не-4K вариант
  return non4k[0];
}

// ─────────────────────────────────────────
// СКАЧАТЬ ФАЙЛ ЧЕРЕЗ PUPPETEER (перехват download URL)
// ─────────────────────────────────────────
async function downloadEnvatoFile(itemUrl, cookies) {
  const b = await getBrowser();
  const page = await b.newPage();
  let downloadUrl = null;
  let selectedAssetUuid = null;

  try {
    await page.setCookie(...cookies);

    // Перехватываем ответы чтобы поймать download.data
    const downloadDataResponses = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('download.data')) {
        try {
          const text = await response.text();
          downloadDataResponses.push({ url, text });
          console.log('[intercept] Caught download.data response');
        } catch {}
      }
    });

    await page.goto(itemUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Парсим страницу чтобы найти itemUuid и все assetUuid
    // Envato использует Remix framework — данные в window.__remixContext
    const pageData = await page.evaluate(() => {
      try {
        const ctx = window.__remixContext;
        return JSON.stringify(ctx);
      } catch {
        return null;
      }
    });

    let itemUuid = null;
    let assets = [];

    if (pageData) {
      const parsed = JSON.parse(pageData);
      // Рекурсивно ищем itemUuid и assets
      const findAssets = (obj, depth = 0) => {
        if (!obj || depth > 10) return;
        if (typeof obj === 'object') {
          if (obj.itemUuid) itemUuid = obj.itemUuid;
          if (obj.assets && Array.isArray(obj.assets)) {
            assets = obj.assets;
          }
          if (obj.videoAssets && Array.isArray(obj.videoAssets)) {
            assets = obj.videoAssets;
          }
          Object.values(obj).forEach(v => findAssets(v, depth + 1));
        }
      };
      findAssets(parsed);
    }

    // Fallback: достаём itemUuid из URL страницы
    if (!itemUuid) {
      const match = page.url().match(/([0-9a-f-]{36})/);
      if (match) itemUuid = match[1];
    }

    console.log('[parse] itemUuid:', itemUuid);
    console.log('[parse] assets found:', assets.length);

    // Если не нашли assets через remixContext — пробуем через DOM/network
    if (assets.length === 0 && downloadDataResponses.length > 0) {
      // Уже есть перехваченный ответ — парсим его
      const firstResp = downloadDataResponses[0];
      const parsed = JSON.parse(firstResp.text);
      // Найти downloadUrl в структуре
      const findUrl = (arr) => {
        if (!Array.isArray(arr)) return null;
        for (let i = 0; i < arr.length; i++) {
          if (typeof arr[i] === 'string' && arr[i].startsWith('https://video-downloads')) {
            return arr[i];
          }
          if (Array.isArray(arr[i])) {
            const found = findUrl(arr[i]);
            if (found) return found;
          }
        }
        return null;
      };
      downloadUrl = findUrl(parsed);
    }

    // Если нашли assets — выбираем лучшее качество
    let chosenAsset = null;
    if (assets.length > 0) {
      chosenAsset = selectBestAsset(assets);
      selectedAssetUuid = chosenAsset.assetUuid || chosenAsset.uuid || chosenAsset.id;
      console.log('[quality] Chosen asset UUID:', selectedAssetUuid);
    }

    // Если downloadUrl ещё не получен — делаем запрос к download.data
    if (!downloadUrl && itemUuid) {
      // Определяем itemType из URL
      const itemType = itemUrl.includes('stock-video') ? 'stock-video' : 
                       itemUrl.includes('music') ? 'music' :
                       itemUrl.includes('sound-effects') ? 'sound-effects' : 'stock-video';

      let apiUrl = `https://app.envato.com/download.data?itemUuid=${itemUuid}&itemType=${itemType}&_routes=routes%2Fdownload%2Froute`;
      if (selectedAssetUuid) {
        apiUrl += `&assetUuid=${selectedAssetUuid}`;
      }

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

      // Парсим downloadUrl из ответа (структура: [..., "downloadUrl", "https://..."])
      const findUrl = (arr) => {
        if (!Array.isArray(arr)) return null;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === 'downloadUrl' && typeof arr[i + 1] === 'string') {
            return arr[i + 1];
          }
          if (Array.isArray(arr[i]) || (arr[i] && typeof arr[i] === 'object')) {
            const found = findUrl(Array.isArray(arr[i]) ? arr[i] : Object.values(arr[i]));
            if (found) return found;
          }
        }
        return null;
      };

      try {
        const parsed = JSON.parse(text);
        downloadUrl = findUrl(parsed);
      } catch (e) {
        console.error('[download.data] Parse error:', e.message);
      }
    }

    if (!downloadUrl) {
      throw new Error('Could not obtain download URL');
    }

    console.log('[download] Got URL:', downloadUrl.substring(0, 80) + '...');

    // Качаем файл
    const urlObj = new URL(downloadUrl);
    const rawFilename = urlObj.pathname.split('/').pop() || `envato-${Date.now()}.mov`;
    const filename = decodeURIComponent(rawFilename);
    const filePath = path.join(DOWNLOAD_DIR, filename);

    console.log('[download] Downloading to:', filePath);

    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`Download failed: ${fileResp.status}`);

    const buffer = Buffer.from(await fileResp.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const sizeBytes = fs.statSync(filePath).size;
    const sizeMB = sizeBytes / 1024 / 1024;
    console.log(`[download] Done: ${sizeMB.toFixed(1)} MB`);

    return { filePath, filename, sizeMB };

  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────
// FFMPEG: конвертация в MP4 если > 1GB
// ─────────────────────────────────────────
async function convertToMp4IfNeeded(filePath, sizeMB) {
  const LIMIT_MB = 1024; // 1 GB

  if (sizeMB <= LIMIT_MB) {
    console.log('[ffmpeg] File is under 1GB, skipping conversion');
    return { filePath, converted: false };
  }

  console.log(`[ffmpeg] File is ${sizeMB.toFixed(0)}MB > 1GB, converting to mp4...`);

  const outPath = filePath.replace(/\.[^.]+$/, '_compressed.mp4');

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', filePath,
      '-c:v', 'libx264',
      '-crf', '23',          // качество (18=лучше, 28=хуже)
      '-preset', 'fast',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',                   // перезаписать если есть
      outPath,
    ]);

    proc.stderr.on('data', d => process.stdout.write(d));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });

  const newSize = fs.statSync(outPath).size / 1024 / 1024;
  console.log(`[ffmpeg] Done: ${newSize.toFixed(1)} MB`);

  // Удаляем оригинал
  fs.unlinkSync(filePath);

  return { filePath: outPath, converted: true, sizeMB: newSize };
}

// ─────────────────────────────────────────
// CLEANUP: удалить файл после отправки
// ─────────────────────────────────────────
function cleanup(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('[cleanup] Deleted:', filePath);
    }
  } catch (e) {
    console.error('[cleanup] Error:', e.message);
  }
}

// ═══════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════

// Health check
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

// Ручной логин (для первичной авторизации или сброса)
app.get('/login', async (req, res) => {
  if (req.query.token !== LOGIN_TOKEN) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  try {
    const cookies = await login();
    res.json({ ok: true, cookiesCount: cookies.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Статус сессии
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

// ─────────────────────────────────────────
// ГЛАВНЫЙ ENDPOINT: скачать файл с Envato
// POST /download
// Body: { "url": "https://elements.envato.com/..." }
// ─────────────────────────────────────────
app.post('/download', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }

  // Конвертируем elements.envato.com → app.envato.com если нужно
  let itemUrl = url;
  if (itemUrl.includes('elements.envato.com')) {
    itemUrl = itemUrl.replace('elements.envato.com', 'app.envato.com');
  }

  console.log('[/download] Request for:', itemUrl);

  let filePath = null;

  try {
    // 1. Получаем куки (или логинимся)
    let cookies = await getCookies();

    // 2. Скачиваем файл
    let result;
    try {
      result = await downloadEnvatoFile(itemUrl, cookies);
    } catch (e) {
      // Если ошибка — возможно куки протухли, пробуем перелогиниться
      if (e.message.includes('401') || e.message.includes('403') || e.message.includes('sign-in')) {
        console.log('[/download] Auth error, re-logging in...');
        cookies = await getCookies(true); // force relogin
        result = await downloadEnvatoFile(itemUrl, cookies);
      } else {
        throw e;
      }
    }

    filePath = result.filePath;

    // 3. Конвертация если нужно
    const converted = await convertToMp4IfNeeded(result.filePath, result.sizeMB);
    filePath = converted.filePath;

    const finalSize = fs.statSync(filePath).size;

    // 4. Отдаём файл клиенту (n8n скачает его)
    const filename = path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', finalSize);
    res.setHeader('X-Converted', converted.converted ? 'true' : 'false');
    res.setHeader('X-File-Size-MB', (finalSize / 1024 / 1024).toFixed(1));

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => cleanup(filePath));
    stream.on('error', (e) => {
      console.error('[stream] Error:', e);
      cleanup(filePath);
    });

  } catch (e) {
    console.error('[/download] Error:', e.message);
    if (filePath) cleanup(filePath);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Running on port ${PORT}`);
  await getBrowser(); // Запускаем браузер заранее
  // Автологин при старте
  try {
    await getCookies();
    console.log('[server] Auto-login on startup: OK');
  } catch (e) {
    console.error('[server] Auto-login failed:', e.message);
  }
});
