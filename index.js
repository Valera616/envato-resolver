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

async function getDownloadUrl(envatoUrl, cookies) {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Шаг 1: Открываем домен (без куков) чтобы браузер знал домен
    console.log('[step1] Opening domain...');
    await page.goto('https://elements.envato.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1000));

    // Шаг 2: Устанавливаем куки на правильные домены
    for (const cookie of cookies) {
      for (const domain of ['elements.envato.com', 'app.envato.com', '.envato.com']) {
        try {
          await page.setCookie({ ...cookie, domain, path: '/' });
        } catch(e) {}
      }
    }
    console.log('[step2] Cookies set');

    // Шаг 3: Перехватываем download.data
    let downloadUrl = null;
    page.on('response', async (response) => {
      if (response.url().includes('download.data') && !downloadUrl) {
        try {
          const text = await response.text();
          console.log('[intercept] download.data:', text.substring(0, 150));
          const find = (arr) => {
            if (!Array.isArray(arr)) return null;
            for (let i = 0; i < arr.length; i++) {
              if (arr[i] === 'downloadUrl' && typeof arr[i+1] === 'string') return arr[i+1];
              if (Array.isArray(arr[i])) { const f = find(arr[i]); if (f) return f; }
              if (arr[i] && typeof arr[i] === 'object') { const f = find(Object.values(arr[i])); if (f) return f; }
            }
            return null;
          };
          downloadUrl = find(JSON.parse(text));
          if (downloadUrl) console.log('[intercept] downloadUrl found!');
        } catch(e) { console.error('[intercept] error:', e.message); }
      }
    });

    // Шаг 4: Теперь открываем целевую страницу — с куками уже в браузере
    console.log('[step3] Navigating to:', envatoUrl);
    await page.goto(envatoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const finalUrl = page.url();
    console.log('[step3] Final URL:', finalUrl);
    console.log('[step3] Title:', await page.title());

    // Шаг 5: Извлекаем itemUuid из URL
    const itemUuid = finalUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
    console.log('[step3] itemUuid:', itemUuid);

    if (!itemUuid) {
      // Делаем скриншот для дебага
      await page.screenshot({ path: '/tmp/debug-page.png', fullPage: true });
      throw new Error('No UUID in URL: ' + finalUrl + ' | Title: ' + await page.title());
    }

    // Шаг 6: Нажимаем Download (не Download preview!)
    const btnText = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      // Ищем кнопку Download (зелёная, с иконкой скачивания)
      // Избегаем "Download preview"
      const btn = btns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t.startsWith('download') && !t.includes('preview') && !t.includes('free');
      });
      if (btn) { btn.click(); return btn.textContent.trim(); }
      return null;
    });
    console.log('[step4] Clicked:', btnText);
    await new Promise(r => setTimeout(r, 4000));

    if (downloadUrl) return { downloadUrl, appUrl: finalUrl, itemUuid };

    // Шаг 7: Прямой API запрос
    console.log('[step5] Direct API call...');
    const itemType = finalUrl.includes('stock-video') ? 'stock-video' :
                     finalUrl.includes('music') ? 'music' :
                     finalUrl.includes('sound-effects') ? 'sound-effects' : 'stock-video';

    const apiUrl = `https://app.envato.com/download.data?itemUuid=${itemUuid}&itemType=${itemType}&_routes=routes%2Fdownload%2Froute`;
    console.log('[step5] API URL:', apiUrl);

    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(apiUrl, {
      headers: {
        'accept': '*/*', 'cookie': cookieStr, 'referer': finalUrl,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
      },
    });

    const text = await resp.text();
    console.log('[step5] status:', resp.status, '| response:', text.substring(0, 300));

    const find = (arr) => {
      if (!Array.isArray(arr)) return null;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === 'downloadUrl' && typeof arr[i+1] === 'string') return arr[i+1];
        if (Array.isArray(arr[i])) { const f = find(arr[i]); if (f) return f; }
        if (arr[i] && typeof arr[i] === 'object') { const f = find(Object.values(arr[i])); if (f) return f; }
      }
      return null;
    };

    try { downloadUrl = find(JSON.parse(text)); } catch(e) {
      throw new Error('API parse error: ' + text.substring(0, 300));
    }

    if (!downloadUrl) throw new Error('downloadUrl not found. API response: ' + text.substring(0, 300));

    return { downloadUrl, appUrl: finalUrl, itemUuid };

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

app.get('/', (req, res) => res.json({ ok: true, status: 'running' }));

app.get('/screenshot', (req, res) => {
  if (!existsSync('/tmp/debug-page.png')) return res.status(404).json({ error: 'No screenshot' });
  res.setHeader('Content-Type', 'image/png');
  createReadStream('/tmp/debug-page.png').pipe(res);
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
    console.error('[get-download-url] Error:', e.message);
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
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] Running on port ${PORT}`);
  await getBrowser();
  console.log('[server] Ready. Use /set-cookie-string to set session.');
});
