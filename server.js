const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TNB_URL = 'https://portal.tnb.org.tr/Sayfalar/NobetciNoterBul.aspx';

function normalizeText(value = '') {
  return String(value).replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
}

function parseDateInput(dateStr) {
  if (!dateStr) return null;

  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return null;

  const [year, month, day] = parts;
  if (!year || !month || !day) return null;

  return {
    iso: `${year}-${month}-${day}`,
    trSlash: `${day}.${month}.${year}`,
  };
}

function extractPhone(text = '') {
  const match = String(text).match(
    /(\+90[\s(]*\d{3}[\s)]*\d{3}[\s]*\d{2}[\s]*\d{2}|0[\s(]*\d{3}[\s)]*\d{3}[\s]*\d{2}[\s]*\d{2})/
  );
  return match ? normalizeText(match[0]) : '';
}

function extractHours(text = '') {
  const match = String(text).match(/(\d{2}[:.]\d{2}\s*[-–]\s*\d{2}[:.]\d{2})/);
  return match ? normalizeText(match[1].replace(/\./g, ':')) : '';
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

async function scrapeDutyNotaries({ city, date }) {
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    locale: 'tr-TR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    await page.goto(TNB_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    // Sayfada şehir / tarih alanlarını olabildiğince esnek bulmaya çalışıyoruz.
    const citySelectors = [
      'select',
      '[name*="Il"]',
      '[id*="Il"]',
      '[name*="il"]',
      '[id*="il"]'
    ];

    const dateSelectors = [
      'input[type="date"]',
      'input',
      '[name*="Tarih"]',
      '[id*="Tarih"]',
      '[name*="tarih"]',
      '[id*="tarih"]'
    ];

    // Şehir select'i bul
    let citySet = false;
    for (const selector of citySelectors) {
      const count = await page.locator(selector).count();
      for (let i = 0; i < count; i++) {
        const loc = page.locator(selector).nth(i);
        const tagName = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tagName !== 'select') continue;

        const optionsText = await loc.locator('option').allTextContents().catch(() => []);
        const hasCity = optionsText.some((x) =>
          normalizeText(x).toLowerCase().includes(city.toLowerCase())
        );

        if (hasCity) {
          await loc.selectOption({ label: city }).catch(async () => {
            const options = await loc.locator('option').all();
            for (const option of options) {
              const txt = normalizeText(await option.textContent());
              if (txt.toLowerCase() === city.toLowerCase()) {
                const value = await option.getAttribute('value');
                if (value) {
                  await loc.selectOption(value);
                  return;
                }
              }
            }
          });
          citySet = true;
          break;
        }
      }
      if (citySet) break;
    }

    // Tarih alanını bul ve doldur
    let dateSet = false;
    for (const selector of dateSelectors) {
      const count = await page.locator(selector).count();

      for (let i = 0; i < count; i++) {
        const loc = page.locator(selector).nth(i);

        const tagName = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tagName !== 'input') continue;

        const type = await loc.getAttribute('type').catch(() => '');
        const name = (await loc.getAttribute('name').catch(() => '')) || '';
        const id = (await loc.getAttribute('id').catch(() => '')) || '';
        const placeholder = (await loc.getAttribute('placeholder').catch(() => '')) || '';

        const meta = `${name} ${id} ${placeholder}`.toLowerCase();

        if (type === 'date' || meta.includes('tarih')) {
          await loc.fill(date.iso).catch(async () => {
            await loc.fill(date.trSlash);
          });
          dateSet = true;
          break;
        }
      }

      if (dateSet) break;
    }

    // Sorgula / ara butonunu bul
    const buttonCandidates = [
      'button',
      'input[type="submit"]',
      'input[type="button"]',
      'a'
    ];

    let clicked = false;

    for (const selector of buttonCandidates) {
      const count = await page.locator(selector).count();

      for (let i = 0; i < count; i++) {
        const loc = page.locator(selector).nth(i);
        const txt = normalizeText(await loc.textContent().catch(() => ''));
        const value = normalizeText(await loc.getAttribute('value').catch(() => ''));
        const allText = `${txt} ${value}`.toLowerCase();

        if (
          allText.includes('ara') ||
          allText.includes('sorgula') ||
          allText.includes('listele') ||
          allText.includes('bul')
        ) {
          await loc.click({ timeout: 10000 }).catch(() => {});
          clicked = true;
          break;
        }
      }

      if (clicked) break;
    }

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const rawBlocks = await page.evaluate(() => {
      const texts = [];
      const selectors = ['table tr', 'div', 'li'];

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (text && /noter/i.test(text) && text.length > 20 && text.length < 2000) {
            texts.push(text);
          }
        });
      });

      return texts;
    });

    const parsed = rawBlocks.map((text) => {
      const lines = text
        .split(/\n|\|/)
        .map((x) => normalizeText(x))
        .filter(Boolean);

      const title = lines.find((x) => /noter/i.test(x)) || '';
      if (!title) return null;

      const address = lines
        .filter(
          (x) =>
            x !== title &&
            !/açık|kapalı/i.test(x) &&
            !/\d{2}[:.]\d{2}\s*[-–]\s*\d{2}[:.]\d{2}/.test(x) &&
            !/^\+?90/.test(x) &&
            !/^0\d{3}/.test(x)
        )
        .join(' ');

      return {
        title,
        city,
        address: normalizeText(address),
        phone: extractPhone(text),
        hours: extractHours(text),
        isOpen: /açık/i.test(text) ? true : /kapalı/i.test(text) ? false : null,
        source: 'TNB'
      };
    }).filter(Boolean);

    return uniqueBy(parsed, (x) => `${x.title}|${x.address}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'noter-duty-service çalışıyor',
    mode: 'playwright'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'noter-duty-service',
    mode: 'playwright',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/duty-notaries', async (req, res) => {
  try {
    const city = normalizeText(req.query.city || '');
    const date = parseDateInput(req.query.date || '');

    if (!city) {
      return res.status(400).json({
        ok: false,
        message: 'city parametresi zorunlu.'
      });
    }

    if (!date) {
      return res.status(400).json({
        ok: false,
        message: 'date parametresi YYYY-MM-DD formatında zorunlu.'
      });
    }

    const data = await scrapeDutyNotaries({ city, date });

    res.json({
      ok: true,
      city,
      date: date.iso,
      requestedDateDisplay: date.trSlash,
      source: TNB_URL,
      count: data.length,
      data
    });
  } catch (error) {
    console.error('Duty notaries error:', error);

    res.status(500).json({
      ok: false,
      message: 'TNB verisi alınamadı.',
      error: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
