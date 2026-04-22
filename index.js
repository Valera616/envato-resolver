import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('ok puppeteer');
});

app.post('/resolve', async (req, res) => {
  let browser;

  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: true, message: 'url is required' });
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const finalUrl = page.url();
    const title = await page.title();

    return res.json({
      ok: true,
      finalUrl,
      title
    });
  } catch (e) {
    return res.status(500).json({
      error: true,
      message: e.message
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('server running on', PORT);
});
