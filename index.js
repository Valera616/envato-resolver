import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '2mb' }));

const LOGIN_TOKEN = process.env.LOGIN_TOKEN;

let browser;

// --- INIT BROWSER ---
async function init() {
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: './user-data',
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--remote-debugging-port=9222'
    ]
  });

  console.log('Browser started');
}

// --- HEALTH ---
app.get('/', (req, res) => {
  res.send('ok auth');
});

// --- LOGIN (ручной через токен) ---
app.get('/login', async (req, res) => {
  const token = req.query.token;

  if (token !== LOGIN_TOKEN) {
    return res.status(403).send('Forbidden');
  }

  const page = await browser.newPage();

  try {
    await page.goto('https://elements.envato.com/sign-in', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForSelector('input[name="username"]', { timeout: 60000 });
    await page.waitForSelector('input[name="password"]', { timeout: 60000 });

    await page.type('input[name="username"]', process.env.ENVATO_EMAIL, { delay: 30 });
    await page.type('input[name="password"]', process.env.ENVATO_PASSWORD, { delay: 30 });

    await Promise.all([
      page.click('button[type="submit"], input[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null)
    ]);

    await new Promise(r => setTimeout(r, 5000));

    res.json({
      ok: true,
      finalUrl: page.url(),
      title: await page.title()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// --- RESOLVE ---
app.post('/resolve', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: 'url is required'
    });
  }

  const page = await browser.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 5000));

    console.log('RESOLVE URL:', page.url());
    console.log('RESOLVE TITLE:', await page.title());

    return res.json({
      ok: true,
      originalUrl: url,
      finalUrl: page.url(),
      title: await page.title()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  await init();
  console.log('Server running on', PORT);
});
