const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TNB_URL = 'https://portal.tnb.org.tr/Sayfalar/NobetciNoterBul.aspx';

function normalizeText(value = '') {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function parseDateInput(dateStr) {
  if (!dateStr) return null;

  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return null;

  const [year, month, day] = parts;
  if (!year || !month || !day) return null;

  return {
    iso: `${year}-${month}-${day}`,
    trInput: `${day}.${month}.${year}`,
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
  const result = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

async function clickSearchButton(page) {
  const selectors = [
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    'a',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();

    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      const text = normalizeText(await el.textContent().catch(() => ''));
      const value = normalizeText(await el.getAttribute('value').catch(() => ''));
      const combined = `${text} ${value}`.toLowerCase();

      if (
        combined.includes('ara') ||
        combined.includes('sorgula') ||
        combined.includes('listele') ||
        combined.includes('bul')
      ) {
        await el.click({ timeout: 10000 }).catch(() => {});
        return true;
      }
    }
  }

  return false;
}

async function trySelectCity(page, city) {
  const selects = page.locator('select');
  const count = await selects.count();

  for (let i = 0; i < count; i++) {
    const select = selects.nth(i);
    const options = await select.locator('option').allTextContents().catch(() => []);
    const normalizedOptions = options.map((x) => normalizeText(x).toLowerCase());

    const exact = normalizedOptions.find((x) => x === city.toLowerCase());
    if (!exact) continue;

    await select.selectOption({ label: city }).catch(async () => {
      const optionLocators = await select.locator('option').all();
      for (const opt of optionLocators) {
        const txt = normalizeText(await opt.textContent().catch(() => ''));
        if (txt.toLowerCase() === city.toLowerCase()) {
          const value = await opt.getAttribute('value');
          if (value) {
            await select.selectOption(value);
            return;
          }
        }
      }
    });

    return true;
  }

  return false;
}

async function tryFillDate(page, date) {
  const inputs = page.locator('input');
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);

    const type = (await input.getAttribute('type').catch(() => '')) || '';
    const name = (await input.getAttribute('name').catch(() => '')) || '';
    const id = (await input.getAttribute('id').catch(() => '')) || '';
    const placeholder =
      (await input.getAttribute('placeholder').catch(() => '')) || '';

    const meta = `${type} ${name} ${id} ${placeholder}`.toLowerCase();

    if (type === 'date' || meta.includes('tarih')) {
      await input.fill(date.iso).catch(async () => {
        await input.fill(date.trInput);
      });
      return true;
    }
  }

  return false;
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

    await trySelectCity(page, city);
    await tryFillDate(page, date);
    await clickSearchButton(page);

    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const rawBlocks = await page.evaluate(() => {
      const items = [];
      const selectors = ['table tr', 'div', 'li'];

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (text && /noter/i.test(text) && text.length > 20 && text.length < 2000) {
            items.push(text);
          }
        });
      });

      return items;
    });

    const parsed = rawBlocks
      .map((text) => {
        const lines = text
          .split(/\n|\|/)
          .map((x) => normalizeText(x))
          .filter(Boolean);

        const title = lines.find((x) => /noter/i.test(x)) || '';
        if (!title) return null;

        const address = normalizeText(
          lines
            .filter(
              (x) =>
                x !== title &&
                !/açık|kapalı/i.test(x) &&
                !/\d{2}[:.]\d{2}\s*[-–]\s*\d{2}[:.]\d{2}/.test(x) &&
                !/^\+?90/.test(x) &&
                !/^0\d{3}/.test(x)
            )
            .join(' ')
        );

        const lowerHaystack = `${title} ${address} ${text}`.toLowerCase();
        if (!lowerHaystack.includes(city.toLowerCase())) {
          return null;
        }

        return {
          title,
          city,
          address,
          phone: extractPhone(text),
          hours: extractHours(text),
          isOpen: /açık/i.test(text) ? true : /kapalı/i.test(text) ? false : null,
          source: 'TNB',
        };
      })
      .filter(Boolean);

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
    mode: 'playwright',
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'noter-duty-service',
    mode: 'playwright',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/duty-notaries', async (req, res) => {
  try {
    const city = normalizeText(req.query.city || '');
    const date = parseDateInput(req.query.date || '');

    if (!city) {
      return res.status(400).json({
        ok: false,
        message: 'city parametresi zorunlu.',
      });
    }

    if (!date) {
      return res.status(400).json({
        ok: false,
        message: 'date parametresi YYYY-MM-DD formatında zorunlu.',
      });
    }

    const data = await scrapeDutyNotaries({ city, date });

    res.json({
      ok: true,
      city,
      date: date.iso,
      requestedDateDisplay: date.trInput,
      source: TNB_URL,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error('Duty notaries error:', error);

    res.status(500).json({
      ok: false,
      message: 'TNB verisi alınamadı.',
      error: error.message,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
