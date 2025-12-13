const { app, BrowserWindow, session, net, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { promises: fsPromises } = require('fs');
const { spawn } = require('child_process');

// --- Configuration ---
const CONFIG = {
    // Paths
    OUTPUT_DIR: path.resolve(process.customData?.path || path.join('.', 'grok-favorites')),
    
    // Switches
    DOWNLOAD_ALL_VARIANTS: false,   // true = download all generated video versions; false = only the latest
    PREFER_HD_VIDEO: true,         // true = try to download hdMediaUrl if available
    EMBED_METADATA: true,          // true = use ffmpeg/exiftool to embed prompts/dates (Requires tools in PATH)
    
    // API Settings
    BATCH_SIZE: 100,               // <--- UPDATED: Items per API request
    
    // Throttling
    CONCURRENT_DOWNLOADS: 5,
    DOWNLOAD_RETRIES: 3,
    API_DELAY_MS: 1500,            // Wait between API pages
};

const TEMP_DIR = path.join(CONFIG.OUTPUT_DIR, '.grok-dl-tmp');

// --- Global State ---
let win;
let authHeaders = null;
let downloadQueue = [];
let activeDownloads = 0;
let isScraping = false;
let processedIds = new Set();
let harvestStats = { found: 0, downloaded: 0, skipped: 0, errors: 0 };
let canStartDownloads = false; // <-- NEW: Gate for starting downloads
let downloadsHaveStarted = false; // <-- NEW: Prevent multiple starts

// --- Main Electron Setup ---
app.whenReady().then(async () => {
    if (process.customData?.autostart) {
        console.log('🏁 Autostart detected. Downloads will begin automatically.');
        canStartDownloads = true;
    }

    // Ensure output directory exists
    await fsPromises.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
    
    // Clean and create temp directory
    try {
        await fsPromises.rm(TEMP_DIR, { recursive: true, force: true });
        await fsPromises.mkdir(TEMP_DIR, { recursive: true });
    } catch (err) {
        console.error('❌ Error initializing temp directory:', err);
        // If we can't create the temp dir, we should probably exit.
        app.quit();
        return;
    }

    console.log(`\n📂 Output Directory: ${CONFIG.OUTPUT_DIR}`);
    console.log(`   Temp Directory: ${TEMP_DIR}`);
    console.log(`🔧 Metadata Embedding: ${CONFIG.EMBED_METADATA ? 'ON (Ensure ffmpeg/exiftool are in PATH)' : 'OFF'}`);
    console.log(`⚙️  API Batch Size: ${CONFIG.BATCH_SIZE}`);

    createWindow();

    // 1. INTERCEPTOR: Listen for the legitimate API call to steal headers
    session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: ['https://grok.com/rest/media/post/list'] },
        (details, callback) => {
            if (!downloadsHaveStarted) {
                const wasCapturedBefore = !!authHeaders;
                authHeaders = details.requestHeaders;

                if (!wasCapturedBefore) {
                    console.log('🔐 Authentication captured!');
                } else {
                    console.log('🔄 Authentication updated!');
                }
                
                if (canStartDownloads && !downloadsHaveStarted) {
                    downloadsHaveStarted = true;
                    console.log('🚀 Starting harvest automatically...');
                    startApiHarvest();
                } else if (!downloadsHaveStarted) {
                    console.log('\n\n>>> PRESS F7 to start downloading... <<<\n\n');
                }
            }
            callback({ requestHeaders: details.requestHeaders });
        }
    );

    // 2. SHORTCUT: Register F7 to start the download process
    globalShortcut.register('F7', () => {
        if (downloadsHaveStarted) {
            console.log('ℹ️ Downloads have already started.');
            return;
        }
        if (!authHeaders) {
            console.log('⚠️ Please log in first. Authentication not yet captured.');
            return;
        }
        
        console.log('🚀 F7 pressed! Starting harvest...');
        canStartDownloads = true;
        downloadsHaveStarted = true;
        startApiHarvest();
    });
});

app.on('will-quit', () => {
    // Unregister all shortcuts.
    globalShortcut.unregisterAll();
    // Clean up temp directory
    try {
        if (fs.existsSync(TEMP_DIR)) {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
            console.log('🗑️  Cleaned up temp directory.');
        }
    } catch (err) {
        console.error('❌ Error cleaning up temp directory:', err);
    }
});

function createWindow() {
    win = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: { contextIsolation: false, nodeIntegration: true }
    });
    
    win.loadURL('https://grok.com/imagine/favorites');
    
    win.webContents.on('did-finish-load', () => {
        if (!authHeaders) {
            console.log('⏳ Waiting for you to log in or for the page to make an API request...');
        }
    });
}

// --- Core Logic: API Harvesting ---

async function startApiHarvest() {
    isScraping = true; // Mark as scraping
    let cursor = null;
    let hasMore = true;

    console.log('🚀 Starting API Pagination Loop...');

    while (hasMore) {
        try {
            const data = await fetchPage(cursor);
            
            if (!data || !data.posts || data.posts.length === 0) {
                console.log('🏁 No more posts found. Finishing up...');
                hasMore = false;
                break;
            }

            console.log(`📄 Fetched page. Processing ${data.posts.length} posts...`);
            
            for (const post of data.posts) {
                processPost(post);
            }

            // Pagination logic
            cursor = data.nextCursor;
            if (!cursor) hasMore = false;

            // Stats update
            if (process.stdout.isTTY) {
                process.stdout.write(`\r📊 Queue: ${downloadQueue.length} | Active: ${activeDownloads} | Found: ${harvestStats.found}`);
            }

            // Be nice to the API
            await new Promise(r => setTimeout(r, CONFIG.API_DELAY_MS));

        } catch (err) {
            console.error('\n❌ Error fetching API page:', err.message);
            console.log('Retrying in 5 seconds...');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    isScraping = false; // Scraping finished
    console.log('\n✅ Discovery complete. Waiting for downloads to finish...');
    checkQueue(); // Ensure queue is flushed
}

function fetchPage(cursor) {
    return new Promise((resolve, reject) => {
        const request = net.request({
            method: 'POST',
            url: 'https://grok.com/rest/media/post/list',
        });

        // Apply captured headers
        for (const [key, value] of Object.entries(authHeaders)) {
            request.setHeader(key, value);
        }
        request.setHeader('Content-Type', 'application/json');
        
        // --- UPDATED: Conditional Cursor Inclusion ---
        const requestBody = {
            limit: CONFIG.BATCH_SIZE, // Uses the new 100 limit
            filter: { source: "MEDIA_POST_SOURCE_LIKED" }
        };

        // Only add cursor if it exists and is not empty
        if (cursor) {
            requestBody.cursor = cursor;
        }

        const body = JSON.stringify(requestBody);
        // --- END UPDATED LOGIC ---

        request.write(body);

        request.on('response', (response) => {
            let chunkData = '';
            response.on('data', (chunk) => chunkData += chunk);
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    try { resolve(JSON.parse(chunkData)); } catch (e) { reject(e); }
                } else {
                    reject(new Error(`HTTP ${response.statusCode}`));
                }
            });
        });
        
        request.on('error', reject);
        request.end();
    });
}

// --- Core Logic: Item Processing ---

function processPost(post) {
    if (processedIds.has(post.id)) return;
    processedIds.add(post.id);
    harvestStats.found++;

    const baseDate = new Date(post.createTime);

    // 1. Process Main Image
    if (post.mediaUrl) {
        const ext = getExtension(post.mimeType) || 'jpg';
        const filename = `grok-image-${post.id}.${ext}`;
        
        addToQueue({
            url: post.mediaUrl,
            filename: filename,
            date: baseDate,
            prompt: post.originalPrompt || post.prompt,
            sourceUrl: post.mediaUrl,
            type: 'image'
        });
    }

    // 2. Process Child Posts (Videos/Variants)
    if (post.childPosts && post.childPosts.length > 0) {
        // Sort by time to ensure "latest" logic works
        const sortedChildren = post.childPosts.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
        
        const childrenToDownload = CONFIG.DOWNLOAD_ALL_VARIANTS ? sortedChildren : [sortedChildren[0]];

        childrenToDownload.forEach((child, index) => {
            // Determine URL (HD vs SD)
            let videoUrl = child.mediaUrl;
            if (CONFIG.PREFER_HD_VIDEO && child.hdMediaUrl) {
                videoUrl = child.hdMediaUrl;
            }
            if (!videoUrl) return;

            const ext = getExtension(child.mimeType) || 'mp4';
            
            // Naming Logic
            let suffix = '';
            if (CONFIG.DOWNLOAD_ALL_VARIANTS && childrenToDownload.length > 1) {
                suffix = `-${index + 1}`;
            }
            const filename = `grok-video-${post.id}${suffix}.${ext}`;

            // Date logic: Parent date + 1 second per index
            const childDate = new Date(baseDate.getTime() + (index * 1000));

            addToQueue({
                url: videoUrl,
                filename: filename,
                date: childDate,
                prompt: child.originalPrompt || child.prompt || post.prompt, // Fallback to parent prompt
                sourceUrl: `https://grok.com/imagine/post/${post.id}`, // Link to web view
                type: 'video'
            });
        });
    }
    
    checkQueue();
}

function addToQueue(task) {
    const filePath = path.join(CONFIG.OUTPUT_DIR, task.filename);
    
    // Check if file exists
    if (fs.existsSync(filePath)) {
        harvestStats.skipped++;
        return;
    }

    downloadQueue.push(task);
}

function checkQueue() {
    // <-- NEW: Guard to prevent downloads from starting too early
    if (!canStartDownloads) {
        return;
    }

    if (downloadQueue.length === 0 && activeDownloads === 0 && !isScraping) {
        console.log('\n✨ All operations completed!');
        console.log(`📥 Total Downloaded: ${harvestStats.downloaded}`);
        console.log(`⏭️  Total Skipped: ${harvestStats.skipped}`);
        console.log(`❌ Errors: ${harvestStats.errors}`);
        app.quit();
        return;
    }

    while (activeDownloads < CONFIG.CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
        const task = downloadQueue.shift();
        downloadFile(task);
    }
}

// --- Core Logic: Downloading & Metadata ---

async function downloadFile(task, retryCount = 0) {
    activeDownloads++;
    const tempPath = path.join(TEMP_DIR, task.filename);
    const finalPath = path.join(CONFIG.OUTPUT_DIR, task.filename);

    console.log(`⬇️  Downloading: ${task.filename}`);

    const file = fs.createWriteStream(tempPath);

    const request = net.request({ url: task.url });

    // Apply captured headers to download request for authorization
    if (authHeaders) {
        // Per user instruction, only use the cookie header for downloads.
        const cookieHeader = Object.entries(authHeaders).find(([key]) => key.toLowerCase() === 'cookie');
        
        if (cookieHeader) {
            const [key, value] = cookieHeader;
            request.setHeader(key, value);
        }
    }

    request.on('response', (response) => {
        if (response.statusCode !== 200) {
            file.close();
            fs.unlink(tempPath, () => {});
            handleDownloadError(task, `HTTP ${response.statusCode}`, retryCount);
            return;
        }

        response.pipe(file);

        file.on('finish', async () => {
            file.close();
            
            try {
                // 1. Metadata Embedding
                if (CONFIG.EMBED_METADATA) {
                    await embedMetadata(tempPath, task);
                }

                // 2. Rename to final
                await fsPromises.rename(tempPath, finalPath);

                // 3. Set File Creation/Modification Dates
                await fsPromises.utimes(finalPath, task.date, task.date);

                harvestStats.downloaded++;
                console.log(`✅ Saved: ${task.filename}`);
            } catch (err) {
                console.error(`⚠️ Post-processing error for ${task.filename}:`, err.message);
                // If post-processing fails, try to move the raw file anyway
                if (fs.existsSync(tempPath) && !fs.existsSync(finalPath)) {
                    await fsPromises.rename(tempPath, finalPath);
                }
            } finally {
                activeDownloads--;
                checkQueue();
            }
        });
    });

    request.on('error', (err) => {
        file.close();
        fs.unlink(tempPath, () => {});
        handleDownloadError(task, err.message, retryCount);
    });

    request.end();
}

function handleDownloadError(task, msg, retryCount) {
    console.error(`❌ Fail: ${task.filename} (${msg})`);
    
    if (retryCount < CONFIG.DOWNLOAD_RETRIES) {
        console.log(`   Retrying ${task.filename}... (${retryCount + 1}/${CONFIG.DOWNLOAD_RETRIES})`);
        activeDownloads--;
        setTimeout(() => downloadFile(task, retryCount + 1), 2000);
    } else {
        // After all retries, delete the failed temporary file.
        fs.unlink(path.join(TEMP_DIR, task.filename), () => {});
        harvestStats.errors++;
        activeDownloads--;
        checkQueue();
    }
}

// --- Metadata Helper ---

async function embedMetadata(filePath, task) {
    // For ffmpeg, the temp output file needs the correct extension so the container format can be inferred.
    const ext = path.extname(task.filename); // e.g., '.mp4'
    const tempOutput = filePath + '.meta' + ext;
    const sanitizedPrompt = sanitizePrompt(task.prompt);

    try {
        if (task.type === 'image') {
            const args = [
                '-overwrite_original'
            ];
            if (sanitizedPrompt) {
                args.push(`-Comment=${sanitizedPrompt}`);
            }
            args.push(
                `-Description=${task.sourceUrl}`,
                `-DateTimeOriginal=${formatExifDate(task.date)}`,
                filePath
            );
            await runCommand('exiftool', args);
        
        } else if (task.type === 'video') {
            const args = [
                '-y', '-i', filePath
            ];
            if (sanitizedPrompt) {
                args.push('-metadata', `comment=${sanitizedPrompt}`);
            }
            args.push(
                '-metadata', `description=${task.sourceUrl}`,
                '-metadata', `creation_time=${task.date.toISOString()}`,
                '-c', 'copy',
                tempOutput
            );
            await runCommand('ffmpeg', args);
            
            await fsPromises.unlink(filePath);
            await fsPromises.rename(tempOutput, filePath);
        }
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.warn(`   ⚠️  Metadata tool not found (ffmpeg/exiftool). Skipping metadata for ${task.filename}`);
        } else {
            console.warn(`   ⚠️  Metadata error: ${e.message}`);
        }
        if (fs.existsSync(tempOutput)) await fsPromises.unlink(tempOutput);
    }
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} exited with code ${code}`));
        });
        proc.on('error', (err) => reject(err));
    });
}

// --- Utilities ---

function getExtension(mimeType) {
    const map = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'video/mp4': 'mp4'
    };
    return map[mimeType?.toLowerCase()] || null;
}

function sanitizePrompt(str) {
    if (!str) return '';

    try {
        const url = new URL(str);
        // If it's a common web URL, treat it as not being a prompt.
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return '';
        }
    } catch (_) {
        // An error indicates it's not a parseable URL, so it's probably a prompt.
        // Fall through to the default sanitization.
    }

    return str.replace(/[\r\n]+/g, ' ').substring(0, 2000);
}

function formatExifDate(date) {
    return date.toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(/-/g, ':');
}