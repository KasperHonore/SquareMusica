import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { get } from 'https';
import { createWriteStream } from 'fs';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');
const isWin = process.platform === 'win32';
const ytDlpPath = join(binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp');

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        file.close();
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error('Redirect with no location'));
          return;
        }
        downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

async function setup() {
  console.log('Setting up yt-dlp...');

  // Create bin directory if it doesn't exist
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  // Check if yt-dlp already exists
  if (existsSync(ytDlpPath)) {
    console.log('yt-dlp already exists at:', ytDlpPath);
    console.log('To update, delete the binary and run this script again.');
    return;
  }

  // Determine the correct binary for the platform
  let binaryName;
  if (isWin) {
    binaryName = 'yt-dlp.exe';
  } else if (process.platform === 'darwin') {
    binaryName = 'yt-dlp_macos';
  } else {
    binaryName = 'yt-dlp';
  }

  const version = process.env.YTDLP_VERSION;
  const url = version
    ? `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${binaryName}`
    : `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`;

  try {
    console.log('Downloading yt-dlp from:', url);
    await downloadFile(url, ytDlpPath);

    const expectedSha256 = process.env.YTDLP_SHA256;
    if (expectedSha256) {
      const { createReadStream } = await import('fs');
      const hash = createHash('sha256');
      await new Promise((resolve, reject) => {
        const stream = createReadStream(ytDlpPath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const actual = hash.digest('hex');
      if (actual.toLowerCase() !== String(expectedSha256).toLowerCase()) {
        throw new Error(`SHA256 mismatch for yt-dlp (expected ${expectedSha256}, got ${actual})`);
      }
      console.log('yt-dlp SHA256 verified');
    } else {
      console.warn(
        'Warning: yt-dlp download was not checksum-verified. Set YTDLP_SHA256 to verify.'
      );
    }

    // Make executable on Unix systems
    if (!isWin) {
      chmodSync(ytDlpPath, 0o755);
    }

    console.log('yt-dlp downloaded successfully to:', ytDlpPath);
    console.log('\nAdd this to your .env file:');
    console.log(`YT_DLP_PATH=./bin/${isWin ? 'yt-dlp.exe' : 'yt-dlp'}`);
  } catch (error) {
    console.error('Failed to download yt-dlp:', error.message);
    process.exit(1);
  }
}

setup();
