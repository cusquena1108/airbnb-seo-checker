const express = require('express');
const path    = require('path');
const { getListingInfo, checkRankingAll } = require('./scraper');

const app  = express();
const PORT = 3458;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let isRunning = false;

// リスティング情報取得（JSON）
app.get('/listing-info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URLを指定してください' });
  try {
    const info = await getListingInfo(url);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 順位チェック（SSE）
app.get('/check', async (req, res) => {
  if (isRunning) {
    res.status(429).json({ error: '既に検索中です。しばらくお待ちください。' });
    return;
  }

  const { area, checkin, checkout, listingUrl } = req.query;
  if (!area || !checkin || !checkout || !listingUrl) {
    return res.status(400).json({ error: '全ての項目を入力してください。' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 5000);

  isRunning = true;
  const t0 = Date.now();
  try {
    send({ type: 'start' });
    const result = await checkRankingAll({ area, checkin, checkout, listingUrl }, p => send(p));
    send({ type: 'result', ...result, elapsed: Math.round((Date.now() - t0) / 1000) });
  } catch (err) {
    send({ type: 'error', message: err.message });
  } finally {
    clearInterval(keepalive);
    isRunning = false;
    if (!res.writableEnded) res.end();
  }
});

app.get('/status', (req, res) => res.json({ running: isRunning }));

app.listen(PORT, () => console.log(`起動: http://localhost:${PORT}`));
