import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, existsSync } from 'fs';

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '2mb' }));

const COOKIES_FILE = './cookies.json';

let browser;
let storedCookies = '';

// Load cookies from file on startup
function loadCookies() {
  if (existsSync(COOKIES_FILE)) {
    try {
      storedCookies = readFileSync(COOKIES_FILE, 'utf-8').trim();
      console.log('[cookies] loaded from file');
    } catch (e) {
      console.warn('[cookies] failed to load from file:', e.message);
    }
  }
}

function saveCookies(cookieString) {
  storedCookies = cookieString;
  try {
    writeFileSync(COOKIES_FILE, cookieString, 'utf-8');
    console.log('[cookies] saved to file');
  } catch (e) {
    console.warn('[cookies] failed to save to file:', e.message);
  }
}

async function initBrowser() {
  const userDataDir = process.env.USER_DATA_DIR || './user-data';
  browser = await puppeteer.launch({
    headless: true,
    userDataDir,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  console.log('[browser] started');
}

function extractUuid(text) {
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, status: 'running' });
});

// Extract cookies from active Puppeteer session (use locally with user-data)
app.get('/extract-cookies', async (req, res) => {
  const page = await browser.newPage();
  try {
    // Visit both domains to collect all cookies
    await page.goto('https://elements.envato.com', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const elementsCookies = await page.cookies();

    await page.goto('https://app.envato.com', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const appCookies = await page.cookies();

    // Merge, deduplicate by name (app cookies take precedence)
    const merged = new Map();
    for (const c of [...elementsCookies, ...appCookies]) {
      merged.set(c.name, c.value);
    }

    const cookieString = Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    saveCookies(cookieString);
    res.json({ ok: true, cookie: cookieString, count: merged.size });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  } finally {
    await page.close().catch(() => {});
  }
});

// Debug: return raw __NEXT_DATA__ from a page (temporary)
app.post('/debug-page', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36');
    if (storedCookies) {
      const c = parseCookiesForPuppeteer(storedCookies, '.envato.com');
      await page.setCookie(...c);
    }
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    // Intercept network requests
    const captured = [];
    page.on('request', req => {
      const u = req.url();
      if (u.includes('download') || u.includes('license') || u.includes('api')) {
        captured.push({ method: req.method(), url: u, postData: req.postData() });
      }
    });
    page.on('response', async resp => {
      const u = resp.url();
      if (u.includes('download') || u.includes('license')) {
        try {
          const body = await resp.text();
          captured.push({ type: 'response', url: u, body: body.slice(0, 500) });
        } catch {}
      }
    });

    // Try to click download button
    const downloadSelectors = [
      '[data-testid*="download"]',
      'button[class*="download" i]',
      'button[class*="Download"]',
      'a[class*="download" i]',
      'button:has-text("Download")',
      'button:has-text("License")',
    ];
    for (const sel of downloadSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await new Promise(r => setTimeout(r, 3000));
          break;
        }
      } catch {}
    }

    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h.includes('envato'))
    );

    res.json({ ok: true, finalUrl: page.url(), captured, allEnvatoLinks: allLinks.slice(0, 20) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    await page.close().catch(() => {});
  }
});

// GET cookies
app.get('/cookies', (req, res) => {
  if (!storedCookies) {
    return res.status(404).json({ ok: false, error: 'No cookies stored. POST to /cookies first.' });
  }
  res.json({ ok: true, cookie: storedCookies });
});

// SET cookies
app.post('/cookies', (req, res) => {
  const { cookie } = req.body;
  if (!cookie) {
    return res.status(400).json({ ok: false, error: 'cookie field is required' });
  }
  saveCookies(cookie);
  res.json({ ok: true, message: 'Cookies saved' });
});

// Parse cookie string into Puppeteer cookie objects
function parseCookiesForPuppeteer(cookieString, domain) {
  return cookieString.split(';').map(c => {
    const eqIdx = c.indexOf('=');
    if (eqIdx === -1) return null;
    const name = c.slice(0, eqIdx).trim();
    const value = c.slice(eqIdx + 1).trim();
    if (!name) return null;
    return { name, value, domain, path: '/' };
  }).filter(Boolean);
}

// Resolve Envato URL → finalUrl + uuid + itemType
app.post('/resolve', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
    );

    // Inject stored cookies into browser session
    if (storedCookies) {
      const envatoCookies = parseCookiesForPuppeteer(storedCookies, '.envato.com');
      const appCookies = parseCookiesForPuppeteer(storedCookies, 'app.envato.com');
      const elementsCookies = parseCookiesForPuppeteer(storedCookies, 'elements.envato.com');
      await page.setCookie(...envatoCookies, ...appCookies, ...elementsCookies);
    }

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    const finalUrl = page.url();
    const html = await page.content();

    let itemUuid = null;
    let itemType = null;

    // Case 1: redirected to app.envato.com/{itemType}/{uuid}
    const appMatch = finalUrl.match(/app\.envato\.com\/([^/]+)\/([a-f0-9-]+)/i);
    if (appMatch) {
      itemType = appMatch[1];
      itemUuid = appMatch[2];
    }

    // Case 2: stayed on elements.envato.com — try clicking Download button
    if (!itemType && finalUrl.includes('elements.envato.com')) {
      try {
        // Try to find and click download/license button
        const downloadSelectors = [
          'a[href*="app.envato.com"]',
          'button[data-testid*="download"]',
          'a[data-testid*="download"]',
          '[class*="download"] a',
          '[class*="Download"] a',
          'a[href*="/download"]',
        ];

        let clicked = false;
        for (const selector of downloadSelectors) {
          try {
            const el = await page.$(selector);
            if (el) {
              const href = await page.evaluate(el => el.href || '', el);
              if (href && href.includes('app.envato.com')) {
                // Extract directly from href
                const hrefMatch = href.match(/app\.envato\.com\/([^/]+)\/([a-f0-9-]+)/i);
                if (hrefMatch) {
                  itemType = hrefMatch[1];
                  itemUuid = hrefMatch[2];
                  clicked = true;
                  break;
                }
              }
              await el.click();
              await new Promise(r => setTimeout(r, 3000));
              const newUrl = page.url();
              const newMatch = newUrl.match(/app\.envato\.com\/([^/]+)\/([a-f0-9-]+)/i);
              if (newMatch) {
                itemType = newMatch[1];
                itemUuid = newMatch[2];
                clicked = true;
                break;
              }
            }
          } catch {}
        }

        // Fallback: look for app.envato.com links in HTML
        if (!clicked) {
          const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href*="app.envato.com"]')).map(a => a.href)
          );
          for (const link of links) {
            const m = link.match(/app\.envato\.com\/([^/]+)\/([a-f0-9-]+)/i);
            if (m) { itemType = m[1]; itemUuid = m[2]; break; }
          }
        }
      } catch (e) {
        console.warn('[resolve] click attempt error:', e.message);
      }
    }

    // Fallback uuid from HTML
    if (!itemUuid) {
      itemUuid = extractUuid(finalUrl) || extractUuid(html);
    }

    // If itemType still unknown, try HTTP redirect via app.envato.com
    if (!itemType && itemUuid && storedCookies) {
      try {
        const candidates = [
          `https://app.envato.com/elements/${itemUuid}`,
          `https://app.envato.com/stock-video/${itemUuid}`,
        ];
        for (const candidate of candidates) {
          const r = await fetch(candidate, {
            redirect: 'manual',
            headers: {
              'Cookie': storedCookies,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml',
            }
          });
          const location = r.headers.get('location') || '';
          const m = location.match(/app\.envato\.com\/([^/?\s]+)\/([a-f0-9-]+)/i);
          if (m) { itemType = m[1]; itemUuid = m[2]; break; }
          // Also check response URL after following
          const r2 = await fetch(candidate, {
            headers: {
              'Cookie': storedCookies,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': '*/*',
            }
          });
          const m2 = r2.url.match(/app\.envato\.com\/([^/?\s]+)\/([a-f0-9-]+)/i);
          if (m2) { itemType = m2[1]; itemUuid = m2[2]; break; }
        }
      } catch (e) {
        console.warn('[resolve] HTTP fallback error:', e.message);
      }
    }

    res.json({
      ok: true,
      originalUrl: url,
      finalUrl,
      itemUuid,
      itemType,
      title: await page.title(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  } finally {
    await page.close().catch(() => {});
  }
});

// Get Envato download URL using stored cookies
app.post('/get-download-url', async (req, res) => {
  const { itemUuid, itemType, referer } = req.body;

  if (!itemUuid || !itemType) {
    return res.status(400).json({ ok: false, error: 'itemUuid and itemType are required' });
  }

  const cookie = storedCookies;
  if (!cookie) {
    return res.status(401).json({ ok: false, error: 'No cookies stored. POST to /cookies first.' });
  }

  const apiUrl = `https://app.envato.com/download.data?itemUuid=${itemUuid}&itemType=${itemType}&_routes=routes%2Fdownload%2Froute`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'Cookie': cookie,
        'Referer': referer || `https://app.envato.com/${itemType}/${itemUuid}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
    });

    const text = await response.text();

    const m = text.match(/"downloadUrl","([^"]+)"/);
    const downloadUrl = m ? m[1] : null;

    if (!downloadUrl) {
      return res.status(502).json({
        ok: false,
        error: 'Could not extract downloadUrl. Cookies may be expired.',
        raw: text.slice(0, 500),
      });
    }

    res.json({ ok: true, downloadUrl });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  loadCookies();
  await initBrowser();
  console.log(`[server] running on ${PORT}`);
});
