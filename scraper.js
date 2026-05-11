const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth());

const ITEMS_PER_PAGE  = 18;
const MAX_PAGES_MAIN  = 10;
const MAX_PAGES_REF   = 5;

// ─── ユーティリティ ────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractListingId(url) {
  const m = url.match(/rooms\/(\d+)/);
  return m ? m[1] : null;
}

function newContext(browser) {
  return browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ja-JP',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
}

async function scrollSlow(page, steps = 8) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      window.scrollBy(0, 600);
      await new Promise(r => setTimeout(r, 300));
    }
    window.scrollTo(0, 0);
  }, steps);
  await sleep(600);
}

async function collectIds(page) {
  return page.evaluate(() => {
    const seen = new Set(), out = [];
    document.querySelectorAll('a[href*="/rooms/"]').forEach(el => {
      const m = el.href.match(/rooms\/(\d+)/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    });
    return out;
  });
}

// ─── リスティング情報取得 ───────────────────────────────────────

const CHROMIUM_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

async function getListingInfo(listingUrl) {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  try {
    const ctx  = await newContext(browser);
    const page = await ctx.newPage();
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    await scrollSlow(page, 6);

    const info = await page.evaluate(() => {
      const h1El = document.querySelector('h1');
      const title = h1El ? h1El.textContent.trim() : document.title.split('|')[0].trim();

      // ページ冒頭3000文字のみを対象にする（おすすめリスティングのタイトル混入を防止）
      const topText = document.body.innerText.slice(0, 3000);

      // サブタイトル行「ゲストX名 · ベッドルームY室...」から取得（最優先）
      // 区切り文字の前にある数字を狙う
      let maxGuests = null;
      const subtitlePatterns = [
        /ゲスト\s*(\d+)\s*[名人]\s*[·・•]/,   // "ゲスト11名 ·" / "ゲスト11人・"
        /ゲスト\s*[·・•]\s*(\d+)\s*[名人]/,   // "ゲスト · 11名"
        /(\d+)\s*[名人]のゲスト/,              // "11名のゲスト"
        /ゲスト\s*(\d+)\s*[名人]/,             // "ゲスト11名" / "ゲスト11人" — 区切りなし
        /最大\s*(\d+)\s*[名人]/,              // "最大11名" — 冒頭3000字内のみ
      ];
      for (const re of subtitlePatterns) {
        const m = topText.match(re);
        if (m) { maxGuests = parseInt(m[1], 10); break; }
      }

      // 場所も冒頭テキストから
      let location = null;
      for (const re of [/東京都\s*([^\s,、\n]+区)/, /([^\s,、\n]+区)/, /([^\s,、\n]+市)/]) {
        const m = topText.match(re);
        if (m) { location = m[1]; break; }
      }

      return { title, maxGuests, location };
    });

    return {
      title:    info.title,
      maxGuests: info.maxGuests,
      location:  info.location,
    };
  } finally {
    await browser.close();
  }
}

// ─── 検索順位チェック ──────────────────────────────────────────

function buildCursor(pageNum) {
  if (pageNum === 1) return null;
  return Buffer.from(JSON.stringify({ section_offset: 0, items_offset: (pageNum - 1) * ITEMS_PER_PAGE, version: 1 })).toString('base64');
}

function buildSearchUrl(area, checkin, checkout, adults, pageNum) {
  const base   = `https://www.airbnb.jp/s/${encodeURIComponent(area)}/homes`;
  const params = new URLSearchParams({ checkin, checkout, adults: String(adults), children: '0', infants: '0', pets: '0' });
  const cursor = buildCursor(pageNum);
  if (cursor) { params.set('pagination_search', 'true'); params.set('cursor', cursor); }
  return `${base}?${params.toString()}`;
}

async function scanOneGuestCount({ area, checkin, checkout, adults, targetId, isMax, browser, onProgress }) {
  const maxPages = isMax ? MAX_PAGES_MAIN : MAX_PAGES_REF;
  const ctx  = await newContext(browser);
  const page = await ctx.newPage();
  let totalScanned = 0;

  try {
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (onProgress) onProgress({ type: 'page_scan', adults, pageNum, maxPages });
      await page.goto(buildSearchUrl(area, checkin, checkout, adults, pageNum), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(1800 + Math.random() * 1000);

      try {
        const btn = page.locator('button[data-testid="accept-btn"]');
        if (await btn.isVisible({ timeout: 1000 })) { await btn.click(); await sleep(600); }
      } catch {}

      await scrollSlow(page, 8);
      const ids = await collectIds(page);

      // 1ページ目のみ総件数を取得
      let searchTotal = null;
      if (pageNum === 1) {
        searchTotal = await page.evaluate(() => {
          const text = document.body.innerText;
          // 「にある1,000件を超える」→ 1001
          if (/にある.{0,10}1[,，]000件を超える/.test(text)) return 1001;
          // 「にある●●件の宿泊」「にある●●件を超える」→ 件数
          const m = text.match(/にある.{0,10}?([0-9,，]+)\s*件(?:の宿泊|を超える)/);
          return m ? parseInt(m[1].replace(/[,，]/g, ''), 10) : null;
        });
      }

      if (ids.length === 0) return { found: false, totalScanned, reason: '最終ページに達しました', searchTotal };

      const pos = ids.indexOf(targetId);
      if (pos !== -1) return { found: true, page: pageNum, positionInPage: pos + 1, totalPosition: totalScanned + pos + 1, totalScanned: totalScanned + ids.length, searchTotal };

      totalScanned += ids.length;
      if (pageNum < maxPages) await sleep(1200 + Math.random() * 800);
    }
    return { found: false, totalScanned, reason: `${maxPages}ページ以内に見つかりませんでした` };
  } finally {
    await ctx.close();
  }
}

function buildGuestCounts(maxGuests) {
  const refs = [2, 4, 6, 8, 10].filter(n => n <= maxGuests);
  if (!refs.includes(maxGuests)) refs.push(maxGuests);
  return [...new Set(refs)].sort((a, b) => a - b);
}

async function checkRankingAll({ area, checkin, checkout, listingUrl }, onProgress) {
  const targetId = extractListingId(listingUrl);
  if (!targetId) throw new Error('リスティングURLからIDを取得できませんでした。');

  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  try {
    if (onProgress) onProgress({ type: 'fetching_listing', message: 'リスティング情報を取得中...' });
    const maxGuests = await (async () => {
      const ctx  = await newContext(browser);
      const page = await ctx.newPage();
      try {
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(2500);
        return await page.evaluate(() => {
          const top = document.body.innerText.slice(0, 3000);
          for (const re of [/ゲスト\s*(\d+)\s*[名人]\s*[·・•]/, /ゲスト\s*[·・•]\s*(\d+)\s*[名人]/, /(\d+)\s*[名人]のゲスト/, /ゲスト\s*(\d+)\s*[名人]/, /最大\s*(\d+)\s*[名人]/]) {
            const m = top.match(re); if (m) return parseInt(m[1], 10);
          }
          return null;
        });
      } finally { await ctx.close(); }
    })();

    if (!maxGuests) throw new Error('最大人数を取得できませんでした。');

    const guestCounts = buildGuestCounts(maxGuests);
    if (onProgress) onProgress({ type: 'listing_info', maxGuests, guestCounts, total: guestCounts.length });

    const results = await Promise.all(
      guestCounts.map((adults) =>
        scanOneGuestCount({ area, checkin, checkout, adults, targetId, isMax: adults === maxGuests, browser, onProgress: p => onProgress && onProgress(p) })
          .then(r => ({ adults, isMax: adults === maxGuests, ...r }))
      )
    );

    return { maxGuests, guestCounts, results };
  } finally {
    await browser.close();
  }
}

module.exports = { getListingInfo, checkRankingAll, extractListingId };
