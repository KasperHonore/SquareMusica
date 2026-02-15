import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { get } from 'https';
import { createWriteStream } from 'fs';

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
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
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

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`;

  try {
    console.log('Downloading yt-dlp from:', url);
    await downloadFile(url, ytDlpPath);

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
