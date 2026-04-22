import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs';

const app = express();
app.use(express.json({ limit: '2mb' }));

const COOKIES_FILE = './cookies.json';

function loadCookies() {
  try {
    if (!fs.existsSync(COOKIES_FILE)) return [];
    const raw = fs.readFileSync(COOKIES_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function saveCookies(cookies) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
}

app.get('/', (req, res) => {
  res.send('ok auth');
});

app.post('/login', async (req, res) => {
  let browser;

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: true,
        message: 'email and password are required'
      });
    }

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
    );

    await page.goto('https://elements.envato.com/sign-in', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await new Promise(r => setTimeout(r, 3000));

    await page.type('input[name="username"]', email);
    await page.type('input[name="password"]', password);

    await Promise.all([
      page.click('button[data-test-selector="sign-in-submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
    ]);

    await new Promise(r => setTimeout(r, 5000));

    const cookies = await page.cookies();
    saveCookies(cookies);

    return res.json({
      ok: true,
      title: await page.title(),
      finalUrl: page.url(),
      cookiesSaved: cookies.length
    });
  } catch (e) {
    return res.status(500).json({
      error: true,
      message: e.message
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post('/resolve', async (req, res) => {
  let browser;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: true,
        message: 'url is required'
      });
    }

    const cookies = loadCookies();

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
    );

    if (cookies.length) {
      await page.setCookie(...cookies);
    }

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await new Promise(r => setTimeout(r, 5000));

    return res.json({
      ok: true,
      finalUrl: page.url(),
      title: await page.title(),
      cookiesUsed: cookies.length
    });
  } catch (e) {
    return res.status(500).json({
      error: true,
      message: e.message
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('server running on', PORT);
});
