const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TNB_URL = 'https://portal.tnb.org.tr/Sayfalar/NobetciNoterBul.aspx';

function normalizeText(value = '') {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function normalizeCity(value = '') {
  return normalizeText(value).toLocaleUpperCase('tr-TR');
}

function parseDateInput(dateStr) {
  if (!dateStr) return null;

  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;

  const [year, month, day] = parts;
  if (!year || !month || !day) return null;

  return {
    iso: `${year}-${month}-${day}`,
    trSlash: `${day}/${month}/${year}`,
  };
}

function extractPhone(text = '') {
  const match = text.match(
    /(\+90[\s(]*\d{3}[\s)]*\d{3}[\s]*\d{2}[\s]*\d{2}|0[\s(]*\d{3}[\s)]*\d{3}[\s]*\d{2}[\s]*\d{2})/
  );
  return match ? normalizeText(match[0]) : '';
}

function extractHours(text = '') {
  const match = text.match(/(\d{2}[:.]\d{2}\s*[-–]\s*\d{2}[:.]\d{2})/);
  return match ? normalizeText(match[1].replace(/\./g, ':')) : '';
}

function collectCandidateBlocks($) {
  const blocks = [];

  $('table tr').each((_, el) => {
    const lines = [];
    $(el)
      .find('td')
      .each((__, td) => {
        const txt = normalizeText($(td).text());
        if (txt) lines.push(txt);
      });

    if (lines.length >= 2) {
      blocks.push(lines.join(' | '));
    }
  });

  $('div, li').each((_, el) => {
    const txt = normalizeText($(el).text());
    if (!txt) return;
    if (!/noter/i.test(txt)) return;
    if (txt.length < 20 || txt.length > 1500) return;
    blocks.push(txt);
  });

  return blocks;
}

function parseNotaryBlock(rawText, city) {
  const text = normalizeText(rawText);
  if (!text) return null;

  const lines = text
    .split(/\||\n/)
    .map((x) => normalizeText(x))
    .filter(Boolean);

  const title =
    lines.find((x) => /noter/i.test(x)) ||
    '';

  if (!title) return null;

  const phone = extractPhone(text);
  const hours = extractHours(text);
  const isOpen = /açık/i.test(text)
    ? true
    : /kapalı/i.test(text)
    ? false
    : null;

  const addressParts = lines.filter(
    (x) =>
      x !== title &&
      !/açık|kapalı/i.test(x) &&
      !/\d{2}[:.]\d{2}\s*[-–]\s*\d{2}[:.]\d{2}/.test(x) &&
      !/^\+?90/.test(x) &&
      !/^0\d{3}/.test(x)
  );

  const address = normalizeText(addressParts.join(' '));

  const haystack = normalizeCity(`${title} ${address} ${text}`);
  if (city && !haystack.includes(normalizeCity(city))) {
    return null;
  }

  return {
    title,
    city,
    address,
    phone,
    hours,
    isOpen,
    source: 'TNB',
    rawText: text,
  };
}

function uniqueNotaries(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    if (!item || !item.title) continue;

    const key = `${normalizeCity(item.title)}|${normalizeCity(item.address || '')}`;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(item);
  }

  return result;
}

async function fetchTnbPage() {
  const response = await axios.get(TNB_URL, {
    timeout: 25000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    },
  });

  return response.data;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'noter-duty-service',
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

    const html = await fetchTnbPage();

    const $ = cheerio.load(html);
    const blocks = collectCandidateBlocks($);

    const parsed = uniqueNotaries(
      blocks
        .map((block) => parseNotaryBlock(block, city))
        .filter(Boolean)
    ).map((item) => ({
      title: item.title,
      city: item.city,
      address: item.address,
      phone: item.phone,
      hours: item.hours,
      isOpen: item.isOpen,
      source: item.source,
    }));

    return res.json({
      ok: true,
      city,
      date: date.iso,
      requestedDateDisplay: date.trSlash,
      source: TNB_URL,
      count: parsed.length,
      data: parsed,
      note:
        'Bu sürüm şehir+tarih parametresiyle çalışır. TNB sayfa yapısı değişirse parser güncellenmelidir.',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'TNB verisi alınamadı.',
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
