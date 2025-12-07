const { app, BrowserWindow, session, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { existsSync } = require('fs');
const https = require('https');

// --- Configuration Constants ---
const DOWNLOAD_TIMEOUT_MS = 120000;        // For downloads in main process
const RENDERER_POLL_TIMEOUT_MS = 123000;   // For finding elements in renderer
const DELAY_BETWEEN_ACTIONS_MS = 2000;    // For waiting between scrolls
const SCROLL_ATTEMPTS_BEFORE_EXIT = 5;    // For giving up on scrolling
const MAX_CONCURRENT_DOWNLOADS = 25;      // Pause scrolling when active downloads exceed this
const DOWNLOAD_RESUME_THRESHOLD = 10;     // Resume scrolling when active downloads drop below this
const MAX_DOWNLOAD_RETRIES = 3;           // Max number of times to retry a failed download

const SELECTORS = {
  ITEM_CONTAINER: 'div[role="listitem"]',
  ITEM_IMAGE: 'img',
  ITEM_VIDEO: 'video',
  ITEM_PLAY_BUTTON: 'button:has(svg.lucide-play)',
};


let win;

const activeDownloads = new Map();

let scrapingFinished = false;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  win = new BrowserWindow({
    width,
    height,
    webPreferences: { contextIsolation: true, audio: false }
  });

  // Listen for console messages from the renderer process
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // In Chromium, 1 = warning, 2 = error.
    if (message.startsWith('__DOWNLOAD_URL__')) {
      try {
        const { url, filename } = JSON.parse(message.substring('__DOWNLOAD_URL__'.length));
        // Only queue if it's not already active
        if (!activeDownloads.has(url)) {
            activeDownloads.set(url, {
                baseFilename: filename,
                retriesLeft: MAX_DOWNLOAD_RETRIES,
                isRetry: false,
                item: null, // Will be populated by 'will-download'
                finalFilename: null, // Will be populated by 'will-download'
                status: 'pending'
            });
        }
        console.log(`Trying download: ${filename} (from ${url})`);
        win.webContents.downloadURL(url);
      } catch (e) {
        console.error('Failed to parse download request from renderer:', e);
      }
    } else if (message.startsWith('__SCRAPING_COMPLETE__')) {
      handleScrapingComplete();
    } else if (level === 1) {
      console.warn(`[Renderer Process Warning] ${message}`);
    } else if (level === 2) {
      console.error(`[Renderer Process Error] ${message}`);
    }
  });
  win.loadURL('https://grok.com/imagine/favorites');
}

/**
 * This function is executed in the renderer process to scrape media items.
 * It's defined here and converted to a string for injection.
 */
async function rendererEntryPoint(existingFileBases, config) {
  // This entire function runs in the renderer process.

  const { SELECTORS } = config;

  // --- Helper functions ---
  const overlay = {
    element: null,
    activeMessages: [], // Use an array to preserve insertion order
    init() {
      if (this.element) return;
      const el = document.createElement('div');
      el.id = '__scraper_overlay__';
      Object.assign(el.style, {
        position: 'fixed',
        top: '20px',
        left: '20px',
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        color: '#FF69B4', // Hot Pink
        padding: '10px 20px',
        borderRadius: '8px',
        zIndex: '999999',
        fontSize: '16px',
        fontFamily: 'monospace',
        display: 'none', // Initially hidden
        pointerEvents: 'none'
      });
      document.body.appendChild(el);
      this.element = el;
    },
    add(message) {
      this.init();
      this.activeMessages.push(message);
      this.update();
    },
    remove(message) {
      const index = this.activeMessages.lastIndexOf(message);
      if (index > -1) {
        this.activeMessages.splice(index, 1);
      }
      this.update();
    },
    update() {
      if (this.activeMessages.length > 0) {
        // Always show the most recently added message
        this.element.textContent = this.activeMessages[this.activeMessages.length - 1];
        this.element.style.display = 'block';
      } else if (this.element) {
        this.element.style.display = 'none';
      }
    }
  };
  const logAndWait = async (promise, message) => {
    overlay.add(message);
    try { return await promise; } finally { overlay.remove(message); }
  };

  const downloadedFileBases = new Set(existingFileBases);
  const processedPostIds = new Set(); // Keep track of posts processed in this session

  const poll = (conditionFn, timeout) => new Promise(resolve => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (conditionFn()) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });

  const scrollDown = () => {
    // Find all items that haven't scrolled completely past the top of the viewport.
    const potentialTargets = [...document.querySelectorAll(SELECTORS.ITEM_CONTAINER)]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > 0; // Exclude items that are fully above the screen
      });

    if (potentialTargets.length > 0) {
      // Find the item whose top is closest to the bottom edge of the viewport.
      // This will be the item just above or just below the "fold".
      const closestToBottomEdge = potentialTargets.reduce((a, b) =>
        Math.abs(a.getBoundingClientRect().top - window.innerHeight) < Math.abs(b.getBoundingClientRect().top - window.innerHeight) ? a : b
      );
      closestToBottomEdge.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  };

  const requestDownload = (url, filename) => {
    console.log('__DOWNLOAD_URL__' + JSON.stringify({ url, filename }));
  };

  // --- Core scraping logic for a single item ---
  const dealWithItem = async (itemEl) => {
    const getPosId = () => {
      const rect = itemEl.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return '[oob]';
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const x = (centerX / window.innerWidth).toFixed(2);
      const y = (centerY / window.innerHeight).toFixed(2);
      return `[${x},${y}]`;
    };
    const posId = getPosId();

    const hasImage = await logAndWait(poll(() => itemEl.querySelector(SELECTORS.ITEM_IMAGE)?.src, config.POLL_TIMEOUT), `${posId} Waiting for image to load...`);
    if (!hasImage) {
      console.warn(`Card at ${posId} timed out waiting for an image.`);
      itemEl.style.filter = 'sepia(1) saturate(4) hue-rotate(320deg)'; // Red tint
      return;
    }

    const img = itemEl.querySelector(SELECTORS.ITEM_IMAGE);
    const hasVideoOrButton = await logAndWait(poll(() => itemEl.querySelector(SELECTORS.ITEM_VIDEO)?.src || itemEl.querySelector(SELECTORS.ITEM_PLAY_BUTTON), config.POLL_TIMEOUT), `${posId} Waiting for video/button...`);
    if (!hasVideoOrButton) {
      console.warn(`Card at ${posId} has an image but timed out waiting for a video or button.`);
      itemEl.style.filter = 'sepia(1) saturate(5) hue-rotate(350deg)';
    }

    const video = itemEl.querySelector(SELECTORS.ITEM_VIDEO);
    const match = new URL(img.src).pathname.match(/.*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    const postId = match ? match[1] : null;

    if (!postId || processedPostIds.has(postId)) return;
    processedPostIds.add(postId); // Mark as processed for this session

    itemEl.dataset.postId = postId;

    // Define all potential downloads and filter out those that already exist.
    const potentialDownloads = [
        { url: img.src, baseName: `grok-image-${postId}`, suffix: '.tmp' }
    ];
    if (video?.src) {
        potentialDownloads.push(
            { url: video.src, baseName: `grok-video-${postId}`, suffix: '.mp4' },
            { url: video.src.replace(/\.mp4\b/, '_hd.mp4'), baseName: `grok-video-hd-${postId}`, suffix: '.mp4' }
        );
    }

    const downloadsToRequest = potentialDownloads.filter(dl => !downloadedFileBases.has(dl.baseName));
    const isAnythingCached = potentialDownloads.length > downloadsToRequest.length;

    // Tint purple if at least one file was already cached.
    // The main process will tint it blue as downloads complete, overwriting this.
    if (isAnythingCached) {
        itemEl.style.filter = 'sepia(1) saturate(8) hue-rotate(240deg)';
    } else if (hasVideoOrButton) {
        itemEl.style.filter = 'sepia(1) saturate(6) hue-rotate(60deg)';
    }

    // Request all downloads that are not cached.
    downloadsToRequest.forEach(dl => requestDownload(dl.url, `${dl.baseName}${dl.suffix}`));
  };

  // --- Main loop ---
  let consecutiveEmptyScrolls = 0;

  while (consecutiveEmptyScrolls < config.SCROLL_ATTEMPTS_BEFORE_EXIT) {
    // Find all items on the page, but only work with the ones we haven't seen before.
    const allItemElements = Array.from(document.querySelectorAll(`${SELECTORS.ITEM_CONTAINER}:not([data-scraper-seen])`));

    const visibleItems = allItemElements.filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.height === 0) return false; // Avoid division by zero

      // Calculate how much of the element is visible vertically
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      const visiblePercentage = visibleHeight / rect.height;

      // Only consider it visible if 20% or more is on screen
      return visiblePercentage >= 0.2;
    });

    const hasNewItems = visibleItems.length > 0;

    if (!hasNewItems) {
      consecutiveEmptyScrolls++;
    } else {
      consecutiveEmptyScrolls = 0;
    }

    visibleItems.forEach(el => {
      el.dataset.scraperSeen = 'true';
      if (!el.style.filter) el.style.filter = 'grayscale(1) brightness(1.2)';
    });

    const promises = visibleItems.map(el => dealWithItem(el));
    await Promise.all(promises);

    // Pause scrolling if the main process has set the flag due to too many active downloads.
    if (window.__SCRAPING_PAUSED) {
      // This loop will effectively halt the 'while' loop until the flag is cleared by the main process.
      while (window.__SCRAPING_PAUSED) {
        await logAndWait(new Promise(r => setTimeout(r, 2000)), 'Download queue full. Pausing discovery...');
      }
    }

    if (consecutiveEmptyScrolls < config.SCROLL_ATTEMPTS_BEFORE_EXIT) {
      await logAndWait(new Promise(r => { scrollDown(); setTimeout(r, config.DELAY_BETWEEN_ACTIONS); }), 'Scrolling down...');
    }
  }

  // Signal to the main process that scraping is complete.
  console.log('__SCRAPING_COMPLETE__');
}

function handleScrapingComplete() {
  console.log('Finished discovering all media. Waiting for downloads to complete...');
  scrapingFinished = true;
  // If there were no downloads to begin with, or they are already done, quit now.
  if (activeDownloads.size === 0) {
    console.log('No active downloads. Exiting.');
    app.quit();
  }
}

async function startScraping(destDir) {
    // Wait for the initial page content to load before starting the loop.
    await waitForPageReady(win);

  await fs.mkdir(destDir, { recursive: true });
  console.log(`Downloads will be saved to: ${destDir}`);
  
  // Get the basenames of already downloaded files to avoid re-downloading.
  const existingFileNames = await fs.readdir(destDir);
  console.log(`Found ${existingFileNames.length} existing files in destination. They will be checked individually.`);
  const existingFileBases = new Set();
  existingFileNames.forEach(file => {
    // Remove extension, e.g., "grok-image-abc.jpg" -> "grok-image-abc"
    existingFileBases.add(file.replace(/\.[^/.]+$/, ""));
  });
  console.log(`Found ${existingFileBases.size} unique file bases to check against.`);

  const rendererConfig = {
    DELAY_BETWEEN_ACTIONS: DELAY_BETWEEN_ACTIONS_MS,
    SCROLL_ATTEMPTS_BEFORE_EXIT: SCROLL_ATTEMPTS_BEFORE_EXIT,
    POLL_TIMEOUT: RENDERER_POLL_TIMEOUT_MS,
    SELECTORS: SELECTORS
  };

  // Inject and run the main renderer script, passing the set of existing file bases.
  const script = `(${rendererEntryPoint.toString()})(${JSON.stringify(Array.from(existingFileBases))}, ${JSON.stringify(rendererConfig)})`;
  win.webContents.executeJavaScript(script).catch(err => console.error('Failed to execute renderer entry point:', err));
}

/**
 * Waits for the page to be ready by polling for the existence of list items.
 * @param {BrowserWindow} browserWin The browser window to check.
 * @param {number} timeoutMs The maximum time to wait in milliseconds.
 */
async function waitForPageReady(browserWin, timeoutMs = 30000) {
  console.log('Waiting for page to be ready...');
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const isReady = await browserWin.webContents.executeJavaScript(
        `document.querySelector('${SELECTORS.ITEM_CONTAINER}') !== null`
      );
      if (isReady) {
        console.log('Page is ready. Starting scraper...');
        return;
      }
    } catch (e) { /* Ignore errors during polling, page might be reloading */ }
    await new Promise(resolve => setTimeout(resolve, 500)); // Poll every 500ms
  }
  throw new Error(`Page did not become ready within ${timeoutMs / 1000} seconds.`);
}

/**
 * Maps a MIME type string to a file extension.
 * @param {string} mimeType The MIME type (e.g., 'image/jpeg').
 * @returns {string|null} The corresponding file extension (e.g., 'jpg') or null.
 */
function getExtensionFromMimeType(mimeType) {
  const mimeMap = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'video/mp4': 'mp4',
  };
  return mimeMap[mimeType.toLowerCase()] || null;
}


app.whenReady().then(async () => {
  // Use the path provided from the main script, or default to the current directory
  const destDir = path.resolve(process.customData?.path || path.join('.', 'grok-favorites'));

  createWindow();

  
  session.defaultSession.on('will-download', (event, item, webContents) => {
    let timeoutId = null;
    let lastBytes = 0;
    const url = item.getURL();
    
    const downloadInfo = activeDownloads.get(url);

    if (!downloadInfo) {
      // This can happen if a download is triggered by something other than our script
      console.warn(`WARN: Untracked download started for ${url}. Cancelling.`);
      item.cancel();
      return;
    }

    // Attach the item to its state object and update status
    downloadInfo.item = item;
    downloadInfo.status = 'downloading';

    // Determine the final filename if it hasn't been determined yet (i.e., on the first attempt)
    let finalFilename = downloadInfo.finalFilename || downloadInfo.baseFilename;
    if (finalFilename.endsWith('.tmp') && !downloadInfo.isRetry) {
      const mimeType = item.getMimeType();
      let extension = getExtensionFromMimeType(mimeType);
      if (!extension) extension = '.jpg'; // Default to jpg if unknown
      finalFilename = finalFilename.replace('.tmp', `.${extension}`);
      downloadInfo.finalFilename = finalFilename; // Store the resolved name
    }
    const savePath = path.join(destDir, finalFilename);

    console.log(`- Started download: ${finalFilename} (from ${url})`);

    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        item.cancel(); // Stop the download
        console.error(`   ERROR: Download for ${finalFilename} stalled and was cancelled.`);
      }, DOWNLOAD_TIMEOUT_MS);
    };

    item.setSavePath(savePath);
    
    // If we've exceeded the download limit, tell the renderer to pause scrolling.
    if (activeDownloads.size > MAX_CONCURRENT_DOWNLOADS && win && !win.isDestroyed()) {
      win.webContents.executeJavaScript('window.__SCRAPING_PAUSED = true;').catch(() => {});
    }

    resetTimeout(); // Start the initial timeout

    item.on('updated', (e, state) => {
      if (state === 'progressing' && item.getReceivedBytes() > lastBytes) {
        lastBytes = item.getReceivedBytes();
        resetTimeout();
      }
    });

    item.on('done', (e, state) => {
      clearTimeout(timeoutId);
      
      // The downloadInfo object is from the parent scope and is still in the activeDownloads map.
      if (state === 'completed') {
        console.log(`   SUCCESS: Saved ${finalFilename}`);
        activeDownloads.delete(url); // COMPLETELY finished, remove from tracking.

        // Find the post ID from the filename
        const match = finalFilename.match(/grok-(?:image|video|video-hd)-([a-f0-9-]+)\./);
        if (match && win && !win.isDestroyed()) {
          const postId = match[1];
          // Execute script in renderer to tint the completed item blue
          win.webContents.executeJavaScript(`
            (() => {
              const itemEl = document.querySelector('div[data-post-id="${postId}"]');
              if (itemEl) itemEl.style.filter = 'sepia(1) saturate(8) hue-rotate(180deg)';
            })();
          `).catch(err => console.error('Failed to execute tint script:', err));
        }

      } else if (state !== 'cancelled') {
        console.error(`   ERROR: Download for ${finalFilename} failed with state: ${state}`);
        
        if (downloadInfo.retriesLeft > 0) {
            downloadInfo.retriesLeft--;
            console.log(`   Retrying download for ${finalFilename}... (${downloadInfo.retriesLeft} attempts left)`);
            
            // Update state for the retry, but keep it in the activeDownloads map.
            downloadInfo.isRetry = true;
            downloadInfo.status = 'pending';
            downloadInfo.item = null; // The old item is dead.

            webContents.downloadURL(url);
            return; // Return early to prevent the finished checks from running on a retry.
        } else {
            console.error(`   Gave up on ${finalFilename} after multiple retries.`);
            activeDownloads.delete(url); // All retries failed, remove from tracking.
        }
      }

      // If the number of downloads has dropped below the resume threshold, tell the renderer it can continue.
      if (activeDownloads.size < DOWNLOAD_RESUME_THRESHOLD && win && !win.isDestroyed()) {
        win.webContents.executeJavaScript('window.__SCRAPING_PAUSED = false;').catch(() => {});
      }

      // If scraping is done and there are no more active downloads, we can quit.
      if (scrapingFinished && activeDownloads.size === 0) {
        console.log('All downloads have finished. Exiting.');
        app.quit();
      }
    });
  });

  try {
    await startScraping(destDir);
  } catch (error) {
    // The specific renderer error is already logged by the 'console-message' listener.
    // This catch block now handles the fallout of that error in the main process.
    console.error("A critical error occurred in the main process, likely due to a renderer error (see above).");
    console.error("The application will now exit.");
    if (win && !win.isDestroyed()) {
      // Give a moment for the user to see the error in the console if running with dev tools.
      setTimeout(() => app.quit(), 10000);
    } else {
      app.quit();
    }
  }
});
