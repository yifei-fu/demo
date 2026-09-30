// Video helpers for shots.mjs's `film` mode: find an ffmpeg, pipe JPEG frames into it, and check the
// resulting clip by loading it in Chromium.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// First ffmpeg (env, the one Playwright bundles, then PATH) that can write webm (VP8) or mp4 (x264).
const CODECS = [
  {
    name: 'libvpx',
    ext: 'webm',
    mime: 'video/webm',
    // constrained quality: -crf sets the ceiling, -b:v the size budget; cpu-used 3 keeps up with rendering
    args: (kbps) =>
      `-c:v libvpx -b:v ${kbps}k -crf 10 -deadline good -cpu-used 3 -threads 2`.split(' '),
  },
  {
    name: 'libx264',
    ext: 'mp4',
    mime: 'video/mp4',
    args: (kbps) =>
      `-c:v libx264 -crf 20 -maxrate ${kbps}k -bufsize ${2 * kbps}k -movflags +faststart`.split(
        ' ',
      ),
  },
];
export function findEncoder(root) {
  const bundled = existsSync(root)
    ? readdirSync(root)
        .filter((d) => d.startsWith('ffmpeg-'))
        .flatMap((d) =>
          readdirSync(join(root, d))
            .filter((f) => /^ffmpeg-(linux|mac|win)/.test(f))
            .map((f) => join(root, d, f)),
        )
    : [];
  for (const bin of [process.env.FFMPEG, ...bundled, 'ffmpeg'].filter(Boolean)) {
    const listed = spawnSync(bin, ['-hide_banner', '-encoders']).stdout?.toString() ?? '';
    const codec = CODECS.find((c) => new RegExp(`\\s${c.name}\\s`).test(listed));
    if (codec) return { bin, ...codec };
  }
  throw new Error('no ffmpeg with libvpx or libx264 found (set $FFMPEG to one)');
}

// JPEG frames (the one still format Playwright's ffmpeg can decode) go in through stdin as they
// are rendered, so nothing piles up in memory.
export function startEncoder(enc, file, fps, kbps) {
  const filters = 'crop=trunc(iw/2)*2:trunc(ih/2)*2'; // yuv420p needs even dimensions
  const input = `-y -loglevel error -f image2pipe -framerate ${fps} -c:v mjpeg -i pipe:0`.split(
    ' ',
  );
  const output = `-vf ${filters} -pix_fmt yuv420p -r ${fps}`.split(' ');
  const proc = spawn(enc.bin, [...input, ...output, ...enc.args(kbps), file], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let err = '';
  proc.stderr.on('data', (d) => (err += d));
  proc.stdin.on('error', () => {}); // a dead ffmpeg is reported through `done`
  const done = new Promise((ok, no) => {
    proc.on('error', no);
    proc.on('close', (code) =>
      code === 0 ? ok() : no(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-400)}`)),
    );
  });
  done.catch(() => {});
  return {
    write: (png) =>
      Promise.race([
        new Promise((ok) => (proc.stdin.write(png) ? ok() : proc.stdin.once('drain', ok))),
        done,
      ]),
    finish: () => (proc.stdin.end(), done),
    kill: () => proc.kill('SIGKILL'),
  };
}

// Load the clip in Chromium: it must decode, report a sane duration, and not be black mid-way.
export function inspectVideo(tool, file, mime) {
  return tool.evaluate(
    async ([b64, type]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const video = document.createElement('video');
      video.muted = true;
      video.src = URL.createObjectURL(new Blob([bytes], { type }));
      await new Promise((ok, no) => {
        video.onloadeddata = ok;
        video.onerror = () =>
          no(new Error(`video does not decode: ${video.error?.message ?? video.error?.code}`));
      });
      video.currentTime = video.duration / 2;
      await new Promise((ok) => (video.onseeked = ok));
      const g = new OffscreenCanvas(64, 64).getContext('2d', { willReadFrequently: true });
      g.drawImage(video, 0, 0, 64, 64);
      const px = g.getImageData(0, 0, 64, 64).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
      return {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        midLuma: sum / (px.length / 4) / 255,
      };
    },
    [readFileSync(file).toString('base64'), mime],
  );
}
