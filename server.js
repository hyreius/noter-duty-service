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
  return normalizeText(value)
    .toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I');
}

function extractPhone(text = '') {
  const match = text.match(/(\+90[\s(]*\d{3}[\s)]*\d{3}[\s]*\d{2}[\s]*\d{2}|0[\s(]*\d{3}[\s)]*\d{3}[\s]*\d{2}[\s]*\d{2})/);
  return match ? normalizeText(match[0]) : '';
}

function extractHours(text = '') {
  const match = text.match(/(\d{2}[:.]\d{2}\s*[-–]\s*\d{2}[:.]\d{2})/);
  return match ? normalizeText(match[1].replace(/\./g, ':')) : '';
}

function cleanupLines(lines) {
  return lines
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .filter((line) => line.length > 1);
}

function parseRowLikeText(lines) {
  const cleaned = cleanupLines(lines);

  if (!cleaned.length) return null;

  const joined = cleaned.join(' | ');
  const title =
    cleaned.find((line) => /noter/i.test(line)) ||
    cleaned[0] ||
    '';

  const addressCandidates = cleaned.filter(
    (line) =>
      line !== title &&
      !/açık|kapalı/i.test(line) &&
      !/\d{2}[:.]\d{2}\s*[-–]\s*\d{2}[:.]\d{2}/.test(line) &&
      !/^\+?90/.test(line)
  );

  const address = addressCandidates.join(' ');
  const phone = extractPhone(joined);
  const hours = extractHours(joined);

  const isOpen = /açık/i.test(joined)
    ? true
    : /kapalı/i.test(joined)
    ? false
    : null;

  return {
    title,
    address,
    phone,
    hours,
    isOpen,
    rawText: joined
  };
}

function parseDutyNotariesFromHtml(html, city) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  const cityNorm = normalizeCity(city);

  function pushResult(item) {
    if (!item || !item.title) return;

    const haystack = normalizeCity(
      `${item.title} ${item.address} ${item.rawText || ''}`
    );

    if (cityNorm && !haystack.includes(cityNorm)) {
      return;
    }

    const key = normalizeCity(`${item.title}|${item.address}`);
    if (seen.has(key)) return;

    seen.add(key);

    results.push({
      title: item.title,
      city,
      address: item.address || '',
      phone: item.phone || '',
      hours: item.hours || '',
      isOpen: item.isOpen,
      source: 'TNB'
    });
  }

  // 1) tablo satırlarını dene
  $('table tr').each((_, el) => {
    const lines = [];
    $(el)
      .find('td')
      .each((__, td) => {
        const txt = normalizeText($(td).text());
        if (txt) lines.push(txt);
      });

    if (lines.length >= 2) {
      pushResult(parseRowLikeText(lines));
    }
  });

  // 2) kart/div/list item yapıları dene
  $('div, li').each((_, el) => {
    const text = normalizeText($(el).text());
    if (!text) return;
    if (!/noter/i.test(text)) return;
    if (text.length < 20) return;
    if (text.length > 1200) return;

    const lines = cleanupLines(
      text
        .split(/\n|\|/)
        .map((s) => s.trim())
        .filter(Boolean)
    );

    if (lines.length) {
      pushResult(parseRowLikeText(lines));
    }
  });

  return results;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'noter-duty-service',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/duty-notaries', async (req, res) => {
  try {
    const city = normalizeText(req.query.city || 'İSTANBUL');

    const response = await axios.get(TNB_URL, {
      timeout: 20000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
      }
    });

    const data = parseDutyNotariesFromHtml(response.data, city);

    res.json({
      ok: true,
      source: TNB_URL,
      city,
      count: data.length,
      data
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: 'TNB verisi alınamadı.',
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
