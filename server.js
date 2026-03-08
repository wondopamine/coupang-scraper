const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const MOBILE_UAS = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36'
    ];

const DESKTOP_UAS = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'
    ];

function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function extractProductId(url) {
      const m = url.match(/\/products\/(\d+)/);
      return m ? m[1] : null;
}

function parseHtml(html, url) {
      const $ = cheerio.load(html);
      const len = html.length;
      const body = $('body').text().toLowerCase();
      const blocked = body.includes('access denied') || body.includes('robot') || len < 3000;

  let name = '';
      for (const s of ['h1.prod-buy-header__title', '.prod-buy-header__title', 'h1', 'title']) {
              const v = $(s).first().text().trim();
              if (v && v.length > 2 && !v.toLowerCase().includes('access denied')) {
                        name = v.replace(/ : 쿠팡$/, '').replace(/ - 쿠팡!$/, '').trim();
                        break;
              }
      }
      if (!name) {
              const og = $('meta[property="og:title"]').attr('content') || '';
              if (og && !og.toLowerCase().includes('access')) name = og.replace(/ : 쿠팡$/, '').trim();
      }

  let price = 0;
      for (const s of ['.total-price strong', '[class*="price-value"]', '[class*="total-price"]', 'strong.price', 'meta[property="product:price:amount"]']) {
              if (s.includes('meta')) {
                        const c = $(s).attr('content');
                        if (c) { const n = parseInt(c.replace(/[^0-9]/g, '')); if (n > 0) { price = n; break; } }
              } else {
                        const t = $(s).first().text().trim();
                        const n = parseInt(t.replace(/[^0-9]/g, ''));
                        if (n > 100) { price = n; break; }
              }
      }

  const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
      const imgs = [];
      const og = $('meta[property="og:image"]').attr('content');
      if (og) imgs.push(og.startsWith('//') ? 'https:' + og : og);
      $('img').each((i, el) => {
              const src = $(el).attr('src') || $(el).attr('data-src');
              if (src) {
                        const f = src.startsWith('//') ? 'https:' + src : src;
                        if (f.includes('http') && !f.includes('icon') && !f.includes('logo') && !imgs.includes(f)) imgs.push(f);
              }
      });

  return { name, price, desc: desc.slice(0, 500), imgs: imgs.slice(0, 30), len, blocked };
}

async function tryMobile(url) {
      const mUrl = url.replace('www.coupang.com', 'm.coupang.com');
      console.log('[S1] Mobile:', mUrl);
      const r = await axios.get(mUrl, {
              headers: { 'User-Agent': getRandom(MOBILE_UAS), 'Accept-Language': 'ko-KR,ko;q=0.9', 'Accept': 'text/html', 'Sec-Fetch-Site': 'none' },
              timeout: 20000, maxRedirects: 5, validateStatus: s => s < 500
      });
      return parseHtml(r.data, url);
}

async function tryDesktop(url) {
      console.log('[S2] Desktop with cookies');
      const ua = getRandom(DESKTOP_UAS);
      let ck = '';
      try {
              const h = await axios.get('https://www.coupang.com/', { headers: { 'User-Agent': ua, 'Accept-Language': 'ko-KR' }, timeout: 8000, validateStatus: () => true });
              if (h.headers['set-cookie']) ck = h.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      } catch(e) {}
      await sleep(1500);
      const r = await axios.get(url, {
              headers: { 'User-Agent': ua, 'Accept-Language': 'ko-KR,ko;q=0.9', 'Referer': 'https://www.coupang.com/', 'Cookie': ck,
                              'Sec-Ch-Ua': '"Chromium";v="122"', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' },
              timeout: 20000, maxRedirects: 5, validateStatus: s => s < 500
      });
      return parseHtml(r.data, url);
}

async function tryGoogleCache(url) {
      const pid = extractProductId(url);
      console.log('[S3] Google cache for:', pid);
      const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
      const r = await axios.get(cacheUrl, {
              headers: { 'User-Agent': getRandom(DESKTOP_UAS), 'Accept-Language': 'ko-KR,ko;q=0.9' },
              timeout: 15000, validateStatus: s => s < 500
      });
      return parseHtml(r.data, url);
}

async function scrapeCoupang(url) {
      const pid = extractProductId(url);
      const strategies = [tryMobile, tryDesktop, tryGoogleCache];
      for (let i = 0; i < strategies.length; i++) {
              try {
                        const r = await strategies[i](url);
                        if (r.name && !r.blocked) {
                                    console.log(`Strategy ${i+1} OK: ${r.name}`);
                                    return { url, productId: pid, productName: r.name, priceKRW: r.price, priceUSD: Math.round(r.price/1350*100)/100,
                                                      description: r.desc, mainImages: r.imgs.slice(0,10), detailImages: r.imgs.slice(10,30), allDetailImages: r.imgs,
                                                      rating: 0, reviewCount: 0, htmlLength: r.len, scrapedAt: new Date().toISOString(), source: 'coupang', strategy: i+1 };
                        }
                        console.log(`Strategy ${i+1} blocked`);
                        if (i < strategies.length-1) await sleep(1500);
              } catch(e) {
                        console.error(`Strategy ${i+1} err:`, e.message);
                        if (i < strategies.length-1) await sleep(1500);
              }
      }
      return { url, productId: pid, productName: '', priceKRW: 0, priceUSD: 0, description: '', mainImages: [], detailImages: [],
                  allDetailImages: [], rating: 0, reviewCount: 0, htmlLength: 0, error: 'All strategies failed',
                  scrapedAt: new Date().toISOString(), source: 'coupang' };
}

// Health
app.get('/', (req, res) => res.json({ status: 'ok', version: '4.0', timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Auto scrape
app.post('/scrape', async (req, res) => {
      const { url } = req.body;
      if (!url || !url.includes('coupang.com')) return res.status(400).json({ success: false, error: 'Valid Coupang URL required' });
      try {
              const data = await scrapeCoupang(url);
              res.json({ success: true, data });
      } catch(e) {
              res.json({ success: true, data: { url, productId: extractProductId(url), productName: '', priceKRW: 0, priceUSD: 0,
                                                     description: '', mainImages: [], detailImages: [], allDetailImages: [], error: e.message, scrapedAt: new Date().toISOString(), source: 'coupang' }});
      }
});

// Manual data input - bypasses scraping entirely
app.post('/manual', (req, res) => {
      const { url, productName, priceKRW, description, mainImages, detailImages } = req.body;
      if (!productName) return res.status(400).json({ success: false, error: 'productName is required' });
      const pid = url ? extractProductId(url) : 'manual';
      res.json({
              success: true,
              data: {
                        url: url || '',
                        productId: pid,
                        productName,
                        priceKRW: priceKRW || 0,
                        priceUSD: Math.round((priceKRW || 0) / 1350 * 100) / 100,
                        description: description || '',
                        mainImages: mainImages || [],
                        detailImages: detailImages || [],
                        allDetailImages: [...(mainImages || []), ...(detailImages || [])],
                        rating: 0,
                        reviewCount: 0,
                        scrapedAt: new Date().toISOString(),
                        source: 'manual'
              }
      });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Scraper v4.0 on port ${PORT}`));
