const { app, BrowserWindow, session, screen } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { readdirSync, existsSync } = require('fs');
const DELAY_BETWEEN_FILES = 1.5;
const DOWNLOAD_TIMEOUT_SECONDS = 30; // Timeout if no progress for this many seconds
const NUM_WINDOWS = 4;

let windows = [];

async function getTargets(rootDir) {
  const targets = [];
  const jsonPaths = [];

  const walk = async dir => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.json')) jsonPaths.push(full);
    }
  };
  await walk(rootDir);

  for (const jsonPath of jsonPaths) {
    try {
      const data = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
      // A valid target must have a title and a URL.
      if (data.url && data.title) {
        const mediaFilePath = path.join(path.dirname(jsonPath), data.title);
        // If the corresponding media file does NOT exist, it's an orphan.
        if (!existsSync(mediaFilePath)) {
          // Use photoTakenTime for logging if it exists, but don't require it.
          const mediaDate = data.photoTakenTime?.formatted;
          targets.push({ jsonPath, url: data.url, title: data.title, mediaDate });
        }
      }
    } catch { /* Ignore JSON files that are malformed or unreadable */ }
  }
  return targets;
}

function createWindows() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const winWidth = Math.floor(width / 2);
  const winHeight = Math.floor(height / 2);

  for (let i = 0; i < NUM_WINDOWS; i++) {
    const x = (i % 2) * winWidth;
    const y = Math.floor(i / 2) * winHeight;
    const win = new BrowserWindow({ x, y, width: winWidth, height: winHeight, webPreferences: { contextIsolation: true, audio: false } });
    win.loadURL('https://photos.google.com/');
    windows.push(win);
  }
}

async function openUrl(win, url) {
  await win.loadURL(url);
  await new Promise(r => setTimeout(r, 1000));
  win.focus();
}

async function pressShiftD(win) {
  // Use sendInputEvent for more reliable keyboard simulation. It's less likely
  // to be ignored by the web page than a dispatched JavaScript event.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['shift'] });
  await new Promise(r => setTimeout(r, 50)); // Brief pause between keydown and keyup
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['shift'] });
}

async function hideFile(filePath) {
  if (process.platform === 'win32') require('child_process').exec(`attrib +H "${filePath}"`);
  else await fs.rename(filePath, path.join(path.dirname(filePath), '.'+path.basename(filePath)));
}

async function triggerDownload(win, destDir) {
  // This promise will be resolved or rejected by the 'will-download' event handler
  const downloadPromise = new Promise((resolve, reject) => {
    // Attach the promise handlers to the specific window's webContents
    win.webContents.downloadContext = { resolve, reject, destDir };
  });
  await pressShiftD(win);
  try { return await downloadPromise; } finally {
    if (win.webContents.downloadContext) {
      win.webContents.downloadContext = null; // Clean up
    }
  }
}

async function main(rootDir) {
  const targets = await getTargets(rootDir);
  console.log(`Found ${targets.length} orphan JSON files to process`);

  const processTarget = async (target, win, index) => {
    const { jsonPath, url, title, mediaDate } = target;
    const logDate = mediaDate ? ` (${mediaDate})` : '';
    console.log(`[${index + 1}/${targets.length}] Downloading in window ${windows.indexOf(win) + 1}: ${title}${logDate}`);
    await openUrl(win, url);
    let downloaded = null;
    try {
      const destDir = path.dirname(jsonPath);
      await fs.mkdir(destDir, { recursive: true }); // Ensure destination directory exists
      downloaded = await triggerDownload(win, destDir);
    } catch (e) {
      console.log(`   Download failed: ${e.message}`);
    }
    if (downloaded) {
      console.log(`   Saved → ${downloaded}`);
      await hideFile(jsonPath);
      console.log('   Hidden JSON');
    } else {
      console.log(`   FAILED/TIMEOUT — ${title}`);
    }
    await new Promise(r => setTimeout(r, DELAY_BETWEEN_FILES * 1000));
  };

  const queue = [...targets.entries()]; // [index, target]
  const workers = windows.map(win => (async () => {
    while (queue.length > 0) {
      const [index, target] = queue.shift();
      await processTarget(target, win, index);
    }
  })());

  await Promise.all(workers);
  console.log('Finished!');
}

app.whenReady().then(async () => {
  createWindows();
  session.defaultSession.on('will-download', (event, item, webContents) => {
    if (!webContents || !webContents.downloadContext) return;

    const { resolve, reject, destDir } = webContents.downloadContext;
    let timeoutId = null;

    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        item.cancel(); // Stop the download
        reject(new Error(`Download stalled for ${DOWNLOAD_TIMEOUT_SECONDS} seconds`));
      }, DOWNLOAD_TIMEOUT_SECONDS * 1000);
    };

    const savePath = path.join(destDir, item.getFilename());
    item.setSavePath(savePath);
    resetTimeout(); // Start the initial timeout

    item.on('updated', (e, state) => {
      if (state === 'progressing') resetTimeout();
    });

    item.on('done', (e, state) => {
      clearTimeout(timeoutId);
      if (state === 'completed') resolve(savePath);
      else if (state === 'cancelled') { /* The reject() in resetTimeout already handled this */ }
      else reject(new Error(`Download failed with state: ${state}`));
    });
  });
  const rootDir = path.resolve(process.customData?.path || '.');
  await main(rootDir);
  app.quit();
});
