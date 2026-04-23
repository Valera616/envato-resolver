import express from 'express';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json({ limit: '2mb' }));

const COOKIES_FILE = './cookies.json';
const DEBUG_DIR = './debug';

if (!fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

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

async function saveDebug(page, name = 'debug') {
  try {
    const safeName = `${Date.now()}-${name}`;
    const screenshotPath = path.join(DEBUG_DIR, `${safeName}.png`);
    const htmlPath = path.join(DEBUG_DIR, `${safeName}.html`);

    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    });

    const html = await page.content();
    fs.writeFileSync(htmlPath, html, 'utf8');

    return {
      screenshotPath,
      htmlPath
    };
  } catch (e) {
    return {
      screenshotPath: null,
      htmlPath: null,
      debugError: e.message
    };
  }
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
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
    );

    page.on('console', msg => {
      console.log('[PAGE LOG]', msg.text());
    });

    page.on('response', response => {
      const status = response.status();
      const url = response.url();

      if (status >= 400) {
        console.log('[HTTP ERROR]', status, url);
      }
    });

    console.log('OPEN LOGIN PAGE...');
    await page.goto('https://elements.envato.com/sign-in', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('LOGIN PAGE URL:', page.url());
    console.log('LOGIN PAGE TITLE:', await page.title());

    await page.waitForSelector('input[name="username"]', { timeout: 60000 });
    await page.waitForSelector('input[name="password"]', { timeout: 60000 });

    await page.click('input[name="username"]', { clickCount: 3 }).catch(() => {});
    await page.type('input[name="username"]', email, { delay: 30 });

    await page.click('input[name="password"]', { clickCount: 3 }).catch(() => {});
    await page.type('input[name="password"]', password, { delay: 30 });

    await Promise.all([
      page.click('button[type="submit"], input[type="submit"]'),
      page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch(() => null)
    ]);

    await new Promise(resolve => setTimeout(resolve, 7000));

    console.log('AFTER LOGIN URL:', page.url());
    console.log('AFTER LOGIN TITLE:', await page.title());

    const cookies = await page.cookies();
    saveCookies(cookies);

    const loggedIn =
      !page.url().includes('/sign-in') &&
      !(await page.title()).toLowerCase().includes('sign in');

    return res.json({
      ok: true,
      loggedIn,
      title: await page.title(),
      finalUrl: page.url(),
      cookiesSaved: cookies.length
    });
  } catch (e) {
    let debugInfo = {};

    try {
      const pages = browser ? await browser.pages() : [];
      const page = pages.length ? pages[0] : null;

      if (page) {
        debugInfo = await saveDebug(page, 'login-error');
      }
    } catch {}

    return res.status(500).json({
      error: true,
      message: e.message,
      ...debugInfo
    });
  } finally {
    // ВАЖНО:
    // пока тестируем логин визуально, браузер НЕ закрываем сразу
    // чтобы ты мог увидеть что реально произошло
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
      headless: false,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
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
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('RESOLVE URL:', page.url());
    console.log('RESOLVE TITLE:', await page.title());

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
    // пока не закрываем для отладки
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('server running on', PORT);
});
