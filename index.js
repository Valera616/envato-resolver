import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

let browser;

async function init() {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  console.log('browser started');
}

app.get('/', (req, res) => {
  res.json({ ok: true });
});

app.post('/resolve', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ ok: false, error: 'url required' });
  }

  const page = await browser.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await new Promise(r => setTimeout(r, 5000));

    const finalUrl = page.url();

    const html = await page.content();

    const uuidFromHtml = html.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    const uuid = uuidFromHtml ? uuidFromHtml[0] : null;
    
    // пробуем вытащить UUID напрямую
    const uuidMatch = finalUrl.match(/[0-9a-f-]{36}/);

    return res.json({
      ok: true,
      originalUrl: url,
      finalUrl,
      uuid,
    });

  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message,
    });
  } finally {
    await page.close();
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  await init();
  console.log('server running on', PORT);
});
