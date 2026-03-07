const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// User-agent rotation to avoid detection
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await sleep(1000 + Math.random() * 1000);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
          'Referer': 'https://www.coupang.com/'
        },
        timeout: 15000,
        maxRedirects: 5,
        responseType: 'arraybuffer'
      });
      const iconv = require('iconv-lite');
      const html = iconv.decode(Buffer.from(response.data), 'utf-8');
      return html;
    } catch (err) {
      console.error(`Attempt ${i + 1} failed:`, err.message);
      if (i === retries - 1) throw err;
      await sleep(2000 * (i + 1));
    }
  }
}

function extractProductData(html, url) {
  const $ = cheerio.load(html);

  // Product name
  let productName = '';
  productName = $('h1.prod-buy-header__title').text().trim() ||
    $('h2.prod-buy-header__title').text().trim() ||
    $('[class*="prod-title"]').first().text().trim() ||
    $('title').text().replace('| Coupang', '').trim();

  // Price
  let priceKRW = 0;
  const priceText = $('.total-price strong').text().trim() ||
    $('[class*="price-value"]').first().text().trim() ||
    $('.prod-sale-price .total-price').text().trim();
  const priceMatch = priceText.replace(/[^0-9]/g, '');
  if (priceMatch) priceKRW = parseInt(priceMatch, 10);

  // Description text
  let description = '';
  const descParts = [];
  $('[class*="prod-attr"] .prod-attr-item').each((i, el) => {
    const text = $(el).text().trim();
    if (text) descParts.push(text);
  });
  $('[class*="item-summary"]').each((i, el) => {
    const text = $(el).text().trim();
    if (text) descParts.push(text);
  });
  description = descParts.join(' | ');
  if (!description) {
    description = $('[class*="prod-description"]').text().trim().substring(0, 1000);
  }

  // Main product images (carousel)
  const mainImages = [];
  $('[class*="prod-image__detail"] img, [class*="prod-carousel"] img, .prod-image img').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src && src.startsWith('http') && !mainImages.includes(src)) {
      mainImages.push(src);
    }
  });

  // Detail/description images (the crafted infographic images unique to Korean products)
  const detailImages = [];
  $('[class*="detail-item"] img, [class*="prod-detail"] img, [id*="adItems"] img, .detail-content img').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-original');
    if (src && src.startsWith('http') && !detailImages.includes(src)) {
      detailImages.push(src);
    }
  });

  // Also grab images from description iframe/script if present
  const scriptImages = [];
  const htmlContent = $.html();
  const imgRegex = /https:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s]*)?/gi;
  const allImgMatches = htmlContent.match(imgRegex) || [];
  allImgMatches.forEach(src => {
    if (
      (src.includes('thumbnail') || src.includes('detail') || src.includes('vendor')) &&
      !mainImages.includes(src) &&
      !detailImages.includes(src) &&
      !scriptImages.includes(src)
    ) {
      scriptImages.push(src);
    }
  });

  // Ratings
  const ratingText = $('[class*="rating"]').first().text().trim();
  const rating = parseFloat(ratingText) || 0;

  // Review count
  const reviewText = $('[class*="count"]').first().text().replace(/[^0-9]/g, '');
  const reviewCount = parseInt(reviewText, 10) || 0;

  return {
    url,
    productName,
    priceKRW,
    description,
    mainImages: mainImages.slice(0, 10),
    detailImages: detailImages.slice(0, 30),
    allDetailImages: [...new Set([...detailImages, ...scriptImages])].slice(0, 50),
    rating,
    reviewCount,
    scrapedAt: new Date().toISOString()
  };
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'coupang-scraper', version: '1.0.0' });
});

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  if (!url.includes('coupang.com')) {
    return res.status(400).json({ error: 'Only Coupang URLs are supported' });
  }

  console.log(`[${new Date().toISOString()}] Scraping: ${url}`);

  try {
    const html = await fetchWithRetry(url);
    const data = extractProductData(html, url);

    console.log(`[${new Date().toISOString()}] Success - Product: ${data.productName.substring(0, 50)}`);
    res.json({ success: true, data });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error scraping ${url}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      url
    });
  }
});

// GET endpoint for testing
app.get('/scrape', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url query param required' });
  req.body = { url };

  try {
    const html = await fetchWithRetry(url);
    const data = extractProductData(html, url);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Coupang scraper running on port ${PORT}`);
});
