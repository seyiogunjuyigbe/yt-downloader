const ytdl = require("@distube/ytdl-core");
const fs = require("fs").promises;
const path = require("path");
const sanitize = require("sanitize-filename");
const pLimit = require("p-limit");
const lockfile = require("proper-lockfile");

// Configuration
const URLS_FILE = path.join(__dirname, "urls.txt");
const OUTPUT_DIR = path.join(__dirname, "videos");
const CONCURRENCY_LIMIT = 4; // Max concurrent downloads
const MAX_RETRIES = 3; // Retry attempts for failed downloads
const RETRY_DELAY_BASE = 2000; // Base delay for retries (ms)

// Create output directory
async function ensureOutputDir() {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
  } catch (err) {
    console.error("Error creating output directory:", err.message);
    process.exit(1);
  }
}

// Read URLs from file
async function readUrls() {
  try {
    const data = await fs.readFile(URLS_FILE, "utf8");
    return data
      .split("\n")
      .map((url) => url.trim())
      .filter((url) => url && ytdl.validateURL(url)); // Keep valid YouTube URLs
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("urls.txt not found, creating empty file.");
      await fs.writeFile(URLS_FILE, "");
      return [];
    }
    console.error("Error reading urls.txt:", err.message);
    return [];
  }
}

// Update URLs file by removing a specific URL
async function removeUrlFromFile(urlToRemove) {
  const release = await lockfile.lock(URLS_FILE, { retries: 5 });
  try {
    const urls = await readUrls();
    const updatedUrls = urls.filter((url) => url !== urlToRemove);
    await fs.writeFile(
      URLS_FILE,
      updatedUrls.join("\n") + (updatedUrls.length ? "\n" : "")
    );
    console.log(`Removed ${urlToRemove} from urls.txt`);
  } catch (err) {
    console.error(`Error updating urls.txt for ${urlToRemove}:`, err.message);
  } finally {
    await release();
  }
}

// Download a single video with retries
async function downloadVideo(url, attempt = 1) {
  let info;
  try {
    // Get video info
    info = await ytdl.getInfo(url);
    const videoTitle = sanitize(info.videoDetails.title);
    const outputPath = path.join(OUTPUT_DIR, `${videoTitle}.mp4`);

    // Skip if file exists
    try {
      await fs.access(outputPath);
      console.log(`Video "${videoTitle}" already downloaded, skipping.`);
      await removeUrlFromFile(url);
      return true;
    } catch (err) {
      // File doesn't exist, proceed
    }

    // Download 360p (itag 18 or fallback to 360p MP4)
    const video = ytdl(url, {
      filter: (format) =>
        format.itag === 18 ||
        (format.container === "mp4" &&
          format.height === 360 &&
          format.hasVideo &&
          format.hasAudio),
    });

    // Create write stream
    const writeStream = fs.createWriteStream(outputPath);

    // Pipe video to file
    video.pipe(writeStream);

    // Track progress
    video.on("progress", (chunkLength, downloaded, total) => {
      const percent = ((downloaded / total) * 100).toFixed(2);
      console.log(
        `Downloading "${videoTitle}" (attempt ${attempt}): ${percent}%`
      );
    });

    // Handle completion
    return new Promise((resolve, reject) => {
      writeStream.on("finish", async () => {
        console.log(`Finished downloading "${videoTitle}"`);
        await removeUrlFromFile(url);
        resolve(true);
      });

      writeStream.on("error", reject);
      video.on("error", reject);
    });
  } catch (err) {
    console.error(
      `Error downloading ${url} (attempt ${attempt}):`,
      err.message
    );
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
      console.log(`Retrying ${url} in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return downloadVideo(url, attempt + 1);
    } else {
      console.error(`Max retries reached for ${url}, skipping.`);
      return false; // Don't remove URL on failure
    }
  }
}

// Main function to process all URLs
async function downloadAllVideos() {
  await ensureOutputDir();
  const urls = await readUrls();

  if (urls.length === 0) {
    console.log("No valid URLs found in urls.txt.");
    return;
  }

  console.log(`Starting download of ${urls.length} videos...`);

  // Limit concurrency
  const limit = pLimit(CONCURRENCY_LIMIT);
  const tasks = urls.map((url) =>
    limit(async () => {
      console.log(`Processing: ${url}`);
      const success = await downloadVideo(url);
      if (!success) {
        console.log(`Failed to download ${url}, keeping in urls.txt`);
      }
    })
  );

  await Promise.all(tasks);
  console.log("All downloads complete!");
}

// Run the process
downloadAllVideos().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
