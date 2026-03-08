const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractProductId(url) {
  const coupangMatch = url.match(/\/products\/(\d+)/);
  if (coupangMatch) return coupangMatch[1];
  const amazonMatch = url.match(/\/dp\/([A-Z0-9]+)/);
  return amazonMatch ? amazonMatch[1] : null;
}

// Launch browser once and reuse
let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080'
      ]
    });
  }
  return browser;
}

async function scrapeCoupangWithPuppeteer(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    
    // Navigate to the page
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    // Wait for key elements to load
    await page.waitForSelector('body', { timeout: 10000 });
    await sleep(2000); // Additional wait for dynamic content
    
    // Extract product data
    const data = await page.evaluate(() => {
      // Product name
      let productName = '';
      const nameSelectors = [
        'h1.prod-buy-header__title',
        '.prod-buy-header__title',
        '[class*="prod-title"]',
        'h1',
        document.querySelector('meta[property="og:title"]')?.content
      ];
      
      for (const sel of nameSelectors) {
        if (typeof sel === 'string') {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 2) {
            productName = el.textContent.trim().replace(' : 쿠팡', '');
            break;
          }
        } else if (sel && sel.length > 2) {
          productName = sel;
          break;
        }
      }
      
      // Price
      let priceKRW = 0;
      const priceSelectors = [
        '.total-price strong',
        '.price-value',
        '[class*="price-value"]',
        '[class*="total-price"]',
        'strong.price'
      ];
      
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent.trim();
          const num = parseInt(text.replace(/[^0-9]/g, ''));
          if (num > 0) {
            priceKRW = num;
            break;
          }
        }
      }
      
      // Description
      const description = document.querySelector('meta[name="description"]')?.content ||
                         document.querySelector('meta[property="og:description"]')?.content || '';
      
      // Images
      const mainImages = [];
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      if (ogImage) mainImages.push(ogImage);
      
      // Get all images
      const allImages = [];
      document.querySelectorAll('img').forEach(img => {
        let src = img.src || img.dataset.src || img.getAttribute('data-src');
        if (src && src.startsWith('//')) src = 'https:' + src;
        if (src && src.startsWith('http') && !allImages.includes(src)) {
          // Filter out tiny icons and logos
          if (!src.includes('1x1') && !src.includes('blank')) {
            allImages.push(src);
          }
        }
      });
      
      return {
        productName,
        priceKRW,
        description: description.slice(0, 500),
        mainImages: allImages.slice(0, 10),
        detailImages: allImages.slice(10, 30),
        allDetailImages: allImages.slice(0, 30)
      };
    });
    
    await page.close();
    
    return {
      url,
      productId: extractProductId(url),
      productName: data.productName || '',
      priceKRW: data.priceKRW || 0,
      priceUSD: Math.round(data.priceKRW / 1350 * 100) / 100,
      description: data.description || '',
      mainImages: data.mainImages || [],
      detailImages: data.detailImages || [],
      allDetailImages: data.allDetailImages || [],
      rating: 0,
      reviewCount: 0,
      scrapedAt: new Date().toISOString(),
      source: 'coupang'
    };
    
  } catch (error) {
    await page.close();
    throw new Error(`Coupang scrape failed: ${error.message}`);
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
    
    if (url.includes('coupang.com')) {
      data = await scrapeCoupangWithPuppeteer(url);
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Only Coupang URLs are supported' 
      });
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
        error: error.message,
        scrapedAt: new Date().toISOString(),
        source: 'coupang'
      }
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Product scraper with Puppeteer running on port ${PORT}`);
});
