import express from 'express';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '2mb' }));

let browser;

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    userDataDir: './user-data',
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

app.get('/', (req, res) => {
  res.json({ ok: true, status: 'running' });
});

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

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    await new Promise(r => setTimeout(r, 5000));

    const finalUrl = page.url();
    const html = await page.content();

    const uuid = extractUuid(finalUrl) || extractUuid(html);

    res.json({
      ok: true,
      originalUrl: url,
      finalUrl,
      uuid,
      title: await page.title(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  } finally {
    await page.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  await initBrowser();
  console.log(`[server] running on ${PORT}`);
});
