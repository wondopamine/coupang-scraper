const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
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

async function scrapeViaHTML(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) await sleep(2000 * i);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
          'Referer': 'https://www.coupang.com/'
        },
        timeout: 30000,
        maxRedirects: 5
      });

      const $ = cheerio.load(response.data);

      // Extract product name
      const productName = $('h1.prod-buy-header__title').text().trim() ||
        $('[class*="prod-title"]').first().text().trim() ||
        $('title').text().replace(' : 쿠팡', '').trim();

      // Extract price
      const priceText = $('[class*="price-value"]').first().text().trim() ||
        $('[class*="total-price"]').first().text().trim() ||
        $('strong.price').first().text().trim();
      const priceKRW = parseInt(priceText.replace(/[^0-9]/g, '')) || 0;

      // Extract description
      const description = $('[class*="prod-description"]').text().trim() ||
        $('meta[name="description"]').attr('content') || '';

      // Extract main images
      const mainImages = [];
      $('[class*="prod-image"] img, [class*="thumbnail"] img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && src.includes('coupang') && !mainImages.includes(src)) {
          mainImages.push(src.startsWith('//') ? 'https:' + src : src);
        }
      });

      // Extract detail images (product description images)
      const detailImages = [];
      $('[class*="detail"] img, #productDetailContent img, .product-content img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && !detailImages.includes(src)) {
          detailImages.push(src.startsWith('//') ? 'https:' + src : src);
        }
      });

      // Extract rating
      const ratingText = $('[class*="rating"] span').first().text().trim();
      const rating = parseFloat(ratingText) || 0;

      // Extract review count
      const reviewText = $('[class*="review-count"]').first().text().trim();
      const reviewCount = parseInt(reviewText.replace(/[^0-9]/g, '')) || 0;

      // Extract all images from page for detail scraping
      const allDetailImages = [];
      $('img').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src && (src.includes('thumbnail') || src.includes('detail') || src.includes('prod-img'))) {
          const fullSrc = src.startsWith('//') ? 'https:' + src : src;
          if (!allDetailImages.includes(fullSrc)) allDetailImages.push(fullSrc);
        }
      });

      return {
        url,
        productName,
        priceKRW,
        description,
        mainImages,
        detailImages,
        allDetailImages,
        rating,
        reviewCount,
        scrapedAt: new Date().toISOString(),
        rawHtmlLength: response.data.length
      };
    } catch (err) {
      if (i === retries - 1) throw err;
    }
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  if (!url.includes('coupang.com')) {
    return res.status(400).json({ success: false, error: 'Only Coupang URLs are supported' });
  }

  try {
    const data = await scrapeViaHTML(url);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Scrape error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      data: {
        url,
        productName: '',
        priceKRW: 0,
        description: '',
        mainImages: [],
        detailImages: [],
        allDetailImages: [],
        rating: 0,
        reviewCount: 0,
        scrapedAt: new Date().toISOString()
      }
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Coupang scraper running on port ${PORT}`);
});
