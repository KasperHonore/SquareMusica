import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// getPcmStream() runs for real; only the two child processes are faked, so the
// cleanup, drain and watchdog wiring between yt-dlp, FFmpeg and the output
// stream is what is under test.
const children = { ytdlp: null, ffmpeg: null };

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn((cmd, args) => {
      const child = fakeChild();
      if (args.includes('pipe:1')) children.ffmpeg = child;
      else children.ytdlp = child;
      return child;
    })
  };
});

const { getPcmStream } = await import('../../src/integrations/youtube.js');
const { StreamType } = await import('@discordjs/voice');

const tick = () => new Promise((resolve) => setImmediate(resolve));

let uncaught;
const onUncaught = (err) => uncaught.push(err);

beforeEach(() => {
  children.ytdlp = null;
  children.ffmpeg = null;
  uncaught = [];
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  process.removeListener('uncaughtException', onUncaught);
  vi.useRealTimers();
});

describe('youtube.getPcmStream (T015)', () => {
  it('returns raw PCM from FFmpeg fed by yt-dlp', async () => {
    const result = await getPcmStream('https://youtu.be/x');
    expect(result.type).toBe(StreamType.Raw);

    const fedToFfmpeg = [];
    children.ffmpeg.stdin.on('data', (c) => fedToFfmpeg.push(c));
    children.ytdlp.stdout.write(Buffer.from('webm'));
    await tick();
    expect(Buffer.concat(fedToFfmpeg).toString()).toBe('webm');

    result.cleanup();
  });

  it('lets buffered PCM drain after a normal FFmpeg exit', async () => {
    const { stream } = await getPcmStream('https://youtu.be/x');
    const received = [];
    stream.on('data', (c) => received.push(c));
    const ended = new Promise((resolve) => stream.on('end', resolve));

    children.ffmpeg.stdout.write(Buffer.from('pcm-1'));
    children.ffmpeg.exitCode = 0;
    children.ffmpeg.emit('close', 0);
    expect(stream.destroyed).toBe(false);
    children.ffmpeg.stdout.end(Buffer.from('pcm-2'));

    await ended;
    expect(Buffer.concat(received).toString()).toBe('pcm-1pcm-2');
    expect(children.ffmpeg.kill).not.toHaveBeenCalled();
  });

  it('survives an async FFmpeg spawn error without an unhandled error event', async () => {
    const { stream } = await getPcmStream('https://youtu.be/x');
    const outputErrors = [];
    stream.on('error', (err) => outputErrors.push(err));

    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    children.ffmpeg.emit('error', enoent);
    await tick();

    expect(uncaught).toEqual([]);
    expect(outputErrors).toEqual([enoent]);
    expect(stream.destroyed).toBe(true);
    expect(children.ytdlp.kill).toHaveBeenCalledWith('SIGKILL');
    expect(children.ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('tears down FFmpeg and errors the output when the yt-dlp watchdog fires', async () => {
    vi.useFakeTimers();
    const { stream } = await getPcmStream('https://youtu.be/x');
    const outputErrors = [];
    stream.on('error', (err) => outputErrors.push(err));

    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await tick();

    expect(uncaught).toEqual([]);
    expect(outputErrors).toHaveLength(1);
    expect(outputErrors[0].message).toMatch(/startup timed out/);
    expect(children.ytdlp.kill).toHaveBeenCalledWith('SIGKILL');
    expect(children.ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills both children when the consumer destroys the output', async () => {
    const { stream } = await getPcmStream('https://youtu.be/x');
    stream.destroy();
    await tick();

    expect(uncaught).toEqual([]);
    expect(children.ytdlp.kill).toHaveBeenCalledWith('SIGKILL');
    expect(children.ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('is idempotent when cleanup is called repeatedly', async () => {
    const result = await getPcmStream('https://youtu.be/x');
    result.cleanup();
    result.cleanup(new Error('late'));
    await tick();

    expect(uncaught).toEqual([]);
    expect(children.ffmpeg.kill).toHaveBeenCalledTimes(1);
    expect(children.ytdlp.kill).toHaveBeenCalledTimes(1);
  });
});
