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
  const match = url.match(/\/products\/(\d+)/);
  return match ? match[1] : null;
}

async function scrapeWithRetry(url, retries = 2) {
  // Try with cookies session first
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) await sleep(3000 * i);

      // First get a session cookie from the homepage
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
      } catch (e) {
        // ignore cookie prefetch error
      }

      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Referer': 'https://www.coupang.com/',
          'Cookie': cookies || '',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Upgrade-Insecure-Requests': '1',
          'Connection': 'keep-alive'
        },
        timeout: 30000,
        maxRedirects: 5
      });

      const html = response.data;
      const $ = cheerio.load(html);
      const htmlLen = html.length;

      // Extract product name - multiple selectors
      let productName = '';
      const nameSelectors = [
        'h1.prod-buy-header__title',
        '.prod-buy-header__title',
        '[class*="prod-title"]',
        'h1',
        'meta[property="og:title"]'
      ];
      for (const sel of nameSelectors) {
        const val = sel.includes('meta') 
          ? $(sel).attr('content') 
          : $(sel).first().text().trim();
        if (val && val.length > 2) {
          productName = val.replace(' : 쿠팡', '').trim();
          break;
        }
      }

      // Extract price
      const priceSelectors = [
        '[class*="price-value"]',
        '[class*="total-price"]',
        '.prod-coupon-price',
        '[class*="prod-price"]',
        'strong.price'
      ];
      let priceKRW = 0;
      for (const sel of priceSelectors) {
        const text = $(sel).first().text().trim();
        const num = parseInt(text.replace(/[^0-9]/g, ''));
        if (num > 0) { priceKRW = num; break; }
      }

      // Extract meta description
      const description = $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') || '';

      // Main product images from og:image and product thumbnails
      const mainImages = [];
      const ogImage = $('meta[property="og:image"]').attr('content');
      if (ogImage) mainImages.push(ogImage);

      $('[class*="prod-image"] img, [class*="thumbnail"] img, .prod-img img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && !mainImages.includes(src)) {
          mainImages.push(src.startsWith('//') ? 'https:' + src : src);
        }
      });

      // Detail images
      const detailImages = [];
      $('[id*="detail"] img, [class*="detail"] img, #productDetailContent img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src) {
          const full = src.startsWith('//') ? 'https:' + src : src;
          if (!detailImages.includes(full)) detailImages.push(full);
        }
      });

      // All images on page (for fallback)
      const allDetailImages = [];
      $('img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src) {
          const full = src.startsWith('//') ? 'https:' + src : src;
          if (!allDetailImages.includes(full)) allDetailImages.push(full);
        }
      });

      // Rating and reviews
      const ratingText = $('[class*="rating"] span, .rating').first().text().trim();
      const rating = parseFloat(ratingText) || 0;
      const reviewText = $('[class*="review-count"], [class*="count-area"]').first().text().trim();
      const reviewCount = parseInt(reviewText.replace(/[^0-9]/g, '')) || 0;

      return {
        url,
        productId: extractProductId(url),
        productName,
        priceKRW,
        description,
        mainImages,
        detailImages,
        allDetailImages,
        rating,
        reviewCount,
        htmlLength: htmlLen,
        scrapedAt: new Date().toISOString()
      };

    } catch (err) {
      console.error(`Attempt ${i + 1} failed:`, err.message);
      if (i === retries - 1) {
        // Return structured error response with what we know
        return {
          url,
          productId: extractProductId(url),
          productName: '',
          priceKRW: 0,
          description: '',
          mainImages: [],
          detailImages: [],
          allDetailImages: [],
          rating: 0,
          reviewCount: 0,
          htmlLength: 0,
          error: err.message,
          scrapedAt: new Date().toISOString()
        };
      }
    }
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scrape endpoint - returns success:true even with partial data
app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  if (!url.includes('coupang.com')) {
    return res.status(400).json({ success: false, error: 'Only Coupang URLs are supported' });
  }

  try {
    const data = await scrapeWithRetry(url);
    // Always return 200 with success:true so n8n workflow continues
    // The workflow can check if productName is empty
    res.json({ success: true, data });
  } catch (error) {
    console.error('Unhandled scrape error:', error.message);
    res.json({
      success: true,
      data: {
        url,
        productId: extractProductId(url),
        productName: '',
        priceKRW: 0,
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
  console.log(`Coupang scraper running on port ${PORT}`);
});
