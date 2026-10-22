import {
  ClipItem,
  TemplateId,
  TextOverlayState,
  WatermarkPosition,
  parseTimecodeToSeconds,
} from './ffmpegCompiler';

export const BUILTIN_WATERMARK_DATA_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90" viewBox="0 0 320 90">
  <rect x="2" y="2" width="316" height="86" rx="14" fill="#f59e0b" fill-opacity="0.94" stroke="#090d16" stroke-width="4"/>
  <text x="160" y="54" font-family="sans-serif" font-weight="800" font-size="28" fill="#090d16" text-anchor="middle" letter-spacing="1">VERTICLIP 9:16</text>
</svg>`);

export function drawSyntheticFrame16x9(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  timeSec: number,
  title = 'STUDIO MASTER 16:9',
  bgImage?: HTMLImageElement | null
) {
  if (bgImage && bgImage.complete && bgImage.naturalWidth > 0) {
    ctx.drawImage(bgImage, 0, 0, w, h);
    ctx.fillStyle = 'rgba(9, 13, 22, 0.35)';
    ctx.fillRect(0, 0, w, h);
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#0f172a');
    grad.addColorStop(0.5, '#1e293b');
    grad.addColorStop(1, '#090d16');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  // Animated broadcast waveform bars
  const barCount = 24;
  const barAreaW = w * 0.76;
  const startX = (w - barAreaW) / 2;
  const stepX = barAreaW / barCount;
  for (let i = 0; i < barCount; i++) {
    const wave =
      Math.sin(timeSec * 4.2 + i * 0.45) * 0.5 +
      Math.cos(timeSec * 2.7 - i * 0.3) * 0.5;
    const barH = Math.max(10, Math.abs(wave) * (h * (bgImage ? 0.24 : 0.42)));
    ctx.fillStyle = i % 3 === 0 ? '#f59e0b' : '#38bdf8';
    ctx.fillRect(
      startX + i * stepX,
      (bgImage ? h * 0.72 : h * 0.56) - barH / 2,
      stepX * 0.65,
      barH
    );
  }

  // Top broadcast banner
  ctx.fillStyle = 'rgba(9, 13, 22, 0.86)';
  ctx.fillRect(0, 0, w, h * 0.18);
  ctx.fillStyle = '#f8fafc';
  ctx.font = `bold ${Math.max(14, Math.round(h * 0.065))}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(title.slice(0, 38), w * 0.05, h * 0.09);

  // Timecode badge
  const mins = String(Math.floor(timeSec / 60)).padStart(2, '0');
  const secs = String(Math.floor(timeSec % 60)).padStart(2, '0');
  const frames = String(Math.floor((timeSec % 1) * 24)).padStart(2, '0');
  ctx.fillStyle = '#f59e0b';
  ctx.font = `bold ${Math.max(13, Math.round(h * 0.06))}px monospace`;
  ctx.fillText(`TC 00:${mins}:${secs}:${frames}`, w * 0.05, h * 0.9);
}

export function drawSyntheticSecondaryLoop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  timeSec: number
) {
  ctx.fillStyle = '#090d16';
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) * 0.44;
  for (let r = 8; r >= 1; r--) {
    const radius = (maxR * r) / 8;
    const angleOffset = timeSec * (1.2 + (8 - r) * 0.25);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, angleOffset, angleOffset + Math.PI * 1.35);
    ctx.strokeStyle = r % 2 === 0 ? '#f59e0b' : '#10b981';
    ctx.lineWidth = Math.max(3, w * 0.018);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(9, 13, 22, 0.78)';
  ctx.fillRect(0, h - 36, w, 36);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('LOOP SECUNDARIO 1080×960', cx, h - 18);
  ctx.textAlign = 'start';
}

function loadOptionalVideo(url: string, startSec: number): Promise<HTMLVideoElement | null> {
  if (!url || url.startsWith('builtin:')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.muted = true;
    vid.playsInline = true;
    vid.src = url;

    const timeout = setTimeout(() => resolve(null), 3500);
    vid.onloadeddata = () => {
      clearTimeout(timeout);
      vid.currentTime = Math.min(startSec, Math.max(0, (vid.duration || 10) - 0.5));
      vid.play().catch(() => {});
      resolve(vid);
    };
    vid.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
  });
}

function loadOptionalImage(url?: string | null): Promise<HTMLImageElement | null> {
  if (!url || url.startsWith('builtin:')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => resolve(null), 3000);
    img.onload = () => {
      clearTimeout(timeout);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };
    img.src = url;
  });
}

export async function renderClientFallbackClip(params: {
  clip: ClipItem;
  templateId: TemplateId;
  textOverlay: TextOverlayState;
  watermarkEnabled: boolean;
  watermarkPosition: WatermarkPosition;
  watermarkScale: number;
  sourceTitle: string;
  sourceUrl?: string;
  thumbnailUrl?: string | null;
}): Promise<{ blobUrl: string; sizeKb: number; durationMs: number; ext: string }> {
  const t0 = Date.now();
  const canvas = document.createElement('canvas');
  canvas.width = 540;
  canvas.height = 960;
  const ctx = canvas.getContext('2d')!;

  const startSec = parseTimecodeToSeconds(params.clip.startTime);
  const endSec = parseTimecodeToSeconds(params.clip.endTime);
  const clipDurationSec = Math.max(2, Math.min(8, endSec - startSec || 4));

  const realVideo = await loadOptionalVideo(params.sourceUrl || '', startSec);
  const thumbImg = !realVideo ? await loadOptionalImage(params.thumbnailUrl) : null;

  const stream = canvas.captureStream(24);
  const preferredTypes = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const supportedMime =
    preferredTypes.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';
  const ext = supportedMime.includes('mp4') ? 'mp4' : 'webm';

  const chunks: BlobPart[] = [];
  const recorder = supportedMime
    ? new MediaRecorder(stream, { mimeType: supportedMime })
    : new MediaRecorder(stream);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopPromise = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: supportedMime || 'video/webm' }));
    };
  });

  recorder.start(100);

  const totalFrames = Math.round(clipDurationSec * 20);
  const offscreen16x9 = document.createElement('canvas');
  offscreen16x9.width = 640;
  offscreen16x9.height = 360;
  const offCtx = offscreen16x9.getContext('2d')!;

  const offscreenSec = document.createElement('canvas');
  offscreenSec.width = 540;
  offscreenSec.height = 480;
  const secCtx = offscreenSec.getContext('2d')!;

  for (let f = 0; f < totalFrames; f++) {
    const currentTc = startSec + f / 20;
    if (realVideo && realVideo.readyState >= 2) {
      offCtx.drawImage(realVideo, 0, 0, 640, 360);
    } else {
      drawSyntheticFrame16x9(offCtx, 640, 360, currentTc, params.sourceTitle, thumbImg);
    }

    const W = canvas.width;
    const H = canvas.height;

    if (params.templateId === 'blur_bg') {
      ctx.save();
      ctx.filter = 'blur(16px) brightness(0.7)';
      ctx.drawImage(offscreen16x9, -W * 0.4, 0, W * 1.8, H);
      ctx.restore();

      const fgH = Math.round((W * 9) / 16);
      const fgY = Math.round((H - fgH) / 2);
      ctx.drawImage(offscreen16x9, 0, fgY, W, fgH);
    } else if (params.templateId === 'split_screen') {
      drawSyntheticSecondaryLoop(secCtx, 540, 480, currentTc);
      ctx.drawImage(offscreen16x9, 0, 0, W, H / 2);
      ctx.drawImage(offscreenSec, 0, H / 2, W, H / 2);
    } else {
      ctx.drawImage(offscreen16x9, -W * 0.35, 0, W * 1.7, H);
    }

    // Watermark badge
    if (params.watermarkEnabled) {
      const wmW = Math.round(W * params.watermarkScale);
      const wmH = Math.round(wmW * 0.28);
      const margin = 24;
      let wx = W - wmW - margin;
      let wy = margin;
      if (params.watermarkPosition === 'top-left') {
        wx = margin;
        wy = margin;
      } else if (params.watermarkPosition === 'bottom-left') {
        wx = margin;
        wy = H - wmH - margin;
      } else if (params.watermarkPosition === 'bottom-right') {
        wx = W - wmW - margin;
        wy = H - wmH - margin;
      } else if (params.watermarkPosition === 'center') {
        wx = (W - wmW) / 2;
        wy = (H - wmH) / 2;
      }
      ctx.fillStyle = 'rgba(245, 158, 11, 0.92)';
      ctx.fillRect(wx, wy, wmW, wmH);
      ctx.fillStyle = '#090d16';
      ctx.font = `bold ${Math.max(10, Math.round(wmH * 0.45))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('VERTICLIP 9:16', wx + wmW / 2, wy + wmH / 2);
      ctx.textAlign = 'start';
    }

    // Text Hook Overlay
    if (params.textOverlay.enabled && params.textOverlay.text.trim()) {
      const fontSize = Math.round(params.textOverlay.fontSize * 0.5);
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ty =
        params.textOverlay.position === 'top'
          ? H * 0.14
          : params.textOverlay.position === 'center'
          ? H * 0.5
          : H * 0.84;

      const textStr = params.textOverlay.text.trim().slice(0, 36);
      const metrics = ctx.measureText(textStr);
      const bw = Math.min(W - 32, metrics.width + 28);
      const bh = fontSize + 20;

      if (params.textOverlay.boxEnabled) {
        ctx.fillStyle = 'rgba(9, 13, 22, 0.82)';
        ctx.fillRect((W - bw) / 2, ty - bh / 2, bw, bh);
      }
      ctx.fillStyle = params.textOverlay.fontColor || '#ffffff';
      ctx.fillText(textStr, W / 2, ty);
      ctx.textAlign = 'start';
    }

    await new Promise((r) => setTimeout(r, 35));
  }

  if (realVideo) {
    realVideo.pause();
    realVideo.src = '';
  }

  recorder.stop();
  const blob = await stopPromise;
  const blobUrl = URL.createObjectURL(blob);
  return {
    blobUrl,
    sizeKb: Math.max(48, Math.round(blob.size / 1024)),
    durationMs: Date.now() - t0,
    ext,
  };
}

export function triggerBrowserDownload(blobOrUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = blobOrUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
  }, 300);
}
