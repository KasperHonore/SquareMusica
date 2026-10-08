import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

// Fake child processes: the first spawn is yt-dlp, the second is ffmpeg.
const children = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.exitCode = null;
      child.kill = vi.fn(() => {
        child.killed = true;
      });
      children.push(child);
      return child;
    })
  };
});

import { getPcmStream } from '../../src/integrations/youtube.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  children.length = 0;
});

describe('getPcmStream teardown', () => {
  it('an ffmpeg spawn error tears down both children without an unhandled error', async () => {
    const result = await getPcmStream('https://youtube.com/watch?v=a');
    const [ytdlp, ffmpeg] = children;
    const outputErrors = [];
    result.stream.on('error', (err) => outputErrors.push(err));

    const spawnError = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    ffmpeg.emit('error', spawnError);
    await tick();
    await tick();

    expect(outputErrors).toEqual([spawnError]);
    expect(ytdlp.kill).toHaveBeenCalled();
    expect(ffmpeg.kill).toHaveBeenCalled();
    expect(result.stream.destroyed).toBe(true);
  });

  it('an output stream error tears down without an unhandled error', async () => {
    const result = await getPcmStream('https://youtube.com/watch?v=a');
    const [ytdlp] = children;
    const outputErrors = [];
    result.stream.on('error', (err) => outputErrors.push(err));

    result.stream.destroy(new Error('consumer failed'));
    await tick();
    await tick();

    expect(outputErrors).toHaveLength(1);
    expect(ytdlp.kill).toHaveBeenCalled();
  });
});
