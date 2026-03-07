const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractProductId(url) {
  const coupangMatch = url.match(/\/products\/(\d+)/);
  if (coupangMatch) return coupangMatch[1];
  const amazonMatch = url.match(/\/dp\/([A-Z0-9]+)/);
  return amazonMatch ? amazonMatch[1] : null;
}

async function scrapeAmazon(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.amazon.com/'
      },
      timeout: 30000
    });

    const $ = cheerio.load(response.data);

    // Extract product name
    const productName = $('#productTitle').text().trim() ||
      $('h1.product-title').text().trim() ||
      $('meta[property="og:title"]').attr('content') || '';

    // Extract price
    let priceUSD = 0;
    const priceText = $('.a-price .a-offscreen').first().text().trim() ||
      $('#priceblock_ourprice').text().trim() ||
      $('#priceblock_dealprice').text().trim();
    if (priceText) {
      priceUSD = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
    }

    // Extract description
    const description = $('#feature-bullets').text().trim().slice(0, 500) ||
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') || '';

    // Extract main images
    const mainImages = [];
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) mainImages.push(ogImage);

    $('#altImages img, #imageBlock img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !src.includes('1x1_transparent') && !mainImages.includes(src)) {
        // Get high-res version by modifying Amazon image URL
        const highRes = src.replace(/_\w+\.\./, '.');
        mainImages.push(highRes);
      }
    });

    // Extract detail images
    const detailImages = [];
    $('#aplus img, #product-description img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !detailImages.includes(src)) {
        detailImages.push(src);
      }
    });

    // Extract rating
    const ratingText = $('#acrPopover').attr('title') || '';
    const rating = parseFloat(ratingText) || 0;

    // Extract review count
    const reviewText = $('#acrCustomerReviewText').text().trim();
    const reviewCount = parseInt(reviewText.replace(/[^0-9]/g, '')) || 0;

    return {
      url,
      productId: extractProductId(url),
      productName,
      priceKRW: Math.round(priceUSD * 1350), // Convert USD to KRW approx
      priceUSD,
      description,
      mainImages: mainImages.slice(0, 10),
      detailImages: detailImages.slice(0, 20),
      allDetailImages: [...mainImages, ...detailImages].slice(0, 30),
      rating,
      reviewCount,
      htmlLength: response.data.length,
      scrapedAt: new Date().toISOString(),
      source: 'amazon'
    };
  } catch (err) {
    throw new Error(`Amazon scrape failed: ${err.message}`);
  }
}

async function scrapeCoupang(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) await sleep(3000 * i);

      let cookies = '';
      try {
        const homeResp = await axios.get('https://www.coupang.com/', {
          headers: {
            'User-Agent': getRandomUA(),
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'ko-KR,ko;q=0.9'
          },
          timeout: 10000,
          maxRedirects: 3
        });
        const setCookie = homeResp.headers['set-cookie'];
        if (setCookie) {
          cookies = setCookie.map(c => c.split(';')[0]).join('; ');
        }
      } catch (e) {}

      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://www.coupang.com/',
          'Cookie': cookies || ''
        },
        timeout: 30000
      });

      const $ = cheerio.load(response.data);
      let productName = '';
      const nameSelectors = [
        'h1.prod-buy-header__title',
        '.prod-buy-header__title',
        '[class*="prod-title"]',
        'h1',
        'meta[property="og:title"]'
      ];
      for (const sel of nameSelectors) {
        const val = sel.includes('meta') ? $(sel).attr('content') : $(sel).first().text().trim();
        if (val && val.length > 2) {
          productName = val.replace(' : 쿠팡', '').trim();
          break;
        }
      }

      let priceKRW = 0;
      const priceSelectors = ['[class*="price-value"]', '[class*="total-price"]', 'strong.price'];
      for (const sel of priceSelectors) {
        const text = $(sel).first().text().trim();
        const num = parseInt(text.replace(/[^0-9]/g, ''));
        if (num > 0) { priceKRW = num; break; }
      }

      const description = $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') || '';

      const mainImages = [];
      const ogImage = $('meta[property="og:image"]').attr('content');
      if (ogImage) mainImages.push(ogImage);

      const detailImages = [];
      const allDetailImages = [];

      $('img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src) {
          const full = src.startsWith('//') ? 'https:' + src : src;
          if (!allDetailImages.includes(full)) allDetailImages.push(full);
        }
      });

      return {
        url,
        productId: extractProductId(url),
        productName,
        priceKRW,
        priceUSD: Math.round(priceKRW / 1350 * 100) / 100,
        description,
        mainImages: allDetailImages.slice(0, 10),
        detailImages: allDetailImages.slice(10, 30),
        allDetailImages: allDetailImages.slice(0, 30),
        rating: 0,
        reviewCount: 0,
        htmlLength: response.data.length,
        scrapedAt: new Date().toISOString(),
        source: 'coupang'
      };
    } catch (err) {
      if (i === retries - 1) {
        return {
          url,
          productId: extractProductId(url),
          productName: '',
          priceKRW: 0,
          priceUSD: 0,
          description: '',
          mainImages: [],
          detailImages: [],
          allDetailImages: [],
          rating: 0,
          reviewCount: 0,
          htmlLength: 0,
          error: err.message,
          scrapedAt: new Date().toISOString(),
          source: 'coupang'
        };
      }
    }
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  try {
    let data;
    if (url.includes('amazon.com') || url.includes('amazon.sg')) {
      data = await scrapeAmazon(url);
    } else if (url.includes('coupang.com')) {
      data = await scrapeCoupang(url);
    } else {
      return res.status(400).json({ success: false, error: 'Only Amazon and Coupang URLs are supported' });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Scrape error:', error.message);
    res.json({
      success: true,
      data: {
        url,
        productId: extractProductId(url),
        productName: '',
        priceKRW: 0,
        priceUSD: 0,
        description: '',
        mainImages: [],
        detailImages: [],
        allDetailImages: [],
        rating: 0,
        reviewCount: 0,
        htmlLength: 0,
        error: error.message,
        scrapedAt: new Date().toISOString()
      }
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Product scraper running on port ${PORT}`);
});
