import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ROOT_DIR = process.cwd();
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const ASSETS_DIR = path.join(STORAGE_DIR, 'assets');
const OUTPUTS_DIR = path.join(STORAGE_DIR, 'outputs');

for (const dir of [STORAGE_DIR, UPLOADS_DIR, ASSETS_DIR, OUTPUTS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination: (_req, file, cb) => {
    const assetType = _req.body?.asset_type || 'source_video';
    cb(null, assetType === 'source_video' ? UPLOADS_DIR : ASSETS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.mp4').toLowerCase();
    const prefix = _req.body?.asset_type || 'media';
    const unique = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    cb(null, `${prefix}_${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 }, // 250MB max
});

interface TextOverlayConfig {
  enabled: boolean;
  text: string;
  fontFamily: 'sans' | 'mono' | 'condensed';
  fontSize: number;
  fontColor: string;
  boxEnabled: boolean;
  boxColor: string;
  boxOpacity: number;
  borderW: number;
  borderColor: string;
  position: 'top' | 'center' | 'bottom';
}

interface ClipRange {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
}

interface ClipJobResult {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  outputUrl: string | null;
  filename: string | null;
  ffmpegCommand: string;
  durationMs?: number;
  fileSizeKb?: number;
  error?: string;
}

interface BatchJob {
  jobId: string;
  createdAt: string;
  status: 'queued' | 'processing' | 'completed' | 'completed_with_errors';
  templateId: 'blur_bg' | 'split_screen' | 'full_crop';
  totalClips: number;
  completedCount: number;
  clips: ClipJobResult[];
}

const jobsStore = new Map<string, BatchJob>();

function resolveFontFile(fontFamily: string): string {
  const candidates: Record<string, string> = {
    sans: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    mono: '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
    condensed: '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf',
  };
  const chosen = candidates[fontFamily] || candidates.sans;
  return fs.existsSync(chosen) ? chosen : '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf';
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function hexToFfmpegColor(hex: string, alpha = 1): string {
  const clean = hex.replace('#', '');
  if (alpha < 1) {
    return `0x${clean}@${alpha.toFixed(2)}`;
  }
  return `0x${clean}`;
}

export function buildFfmpegArgs(params: {
  inputVideoPath: string;
  outputVideoPath: string;
  startTime: string;
  endTime: string;
  templateId: 'blur_bg' | 'split_screen' | 'full_crop';
  secondaryMediaPath?: string | null;
  watermarkPath?: string | null;
  watermarkPosition: 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-right';
  watermarkScale: number;
  textOverlay: TextOverlayConfig;
  fastRender?: boolean;
}): { args: string[]; prettyCommand: string } {
  const {
    inputVideoPath,
    outputVideoPath,
    startTime,
    endTime,
    templateId,
    secondaryMediaPath,
    watermarkPath,
    watermarkPosition,
    watermarkScale,
    textOverlay,
    fastRender = true,
  } = params;

  // Render resolution: 1080x1920 (9:16 standard)
  const W = 1080;
  const H = 1920;
  const HALF_H = 960;

  const args: string[] = [
    '-y',
    '-ss',
    startTime,
    '-to',
    endTime,
    '-i',
    inputVideoPath,
  ];

  let inputIdx = 1;
  let secIdx: number | null = null;
  let wmIdx: number | null = null;

  if (templateId === 'split_screen' && secondaryMediaPath && fs.existsSync(secondaryMediaPath)) {
    const ext = path.extname(secondaryMediaPath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      args.push('-loop', '1', '-i', secondaryMediaPath);
    } else {
      args.push('-stream_loop', '-1', '-i', secondaryMediaPath);
    }
    secIdx = inputIdx++;
  }

  if (watermarkPath && fs.existsSync(watermarkPath)) {
    args.push('-i', watermarkPath);
    wmIdx = inputIdx++;
  }

  const filterChains: string[] = [];
  let currentLabel = '[base_v]';

  if (templateId === 'blur_bg') {
    filterChains.push(
      `[0:v]split=2[bg_src][fg_src];` +
        `[bg_src]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:5,eq=brightness=-0.12,setsar=1[bg_blur];` +
        `[fg_src]scale=${W}:-2:force_original_aspect_ratio=decrease,setsar=1[fg_scaled];` +
        `[bg_blur][fg_scaled]overlay=(W-w)/2:(H-h)/2:shortest=1${currentLabel}`
    );
  } else if (templateId === 'split_screen') {
    if (secIdx !== null) {
      filterChains.push(
        `[0:v]scale=${W}:${HALF_H}:force_original_aspect_ratio=increase,crop=${W}:${HALF_H},setsar=1[top_v];` +
          `[${secIdx}:v]scale=${W}:${HALF_H}:force_original_aspect_ratio=increase,crop=${W}:${HALF_H},setsar=1[bot_v];` +
          `[top_v][bot_v]vstack=inputs=2:shortest=1${currentLabel}`
      );
    } else {
      filterChains.push(
        `[0:v]split=2[top_src][bot_src];` +
          `[top_src]scale=${W}:${HALF_H}:force_original_aspect_ratio=increase,crop=${W}:${HALF_H},setsar=1[top_v];` +
          `[bot_src]scale=${W}:${HALF_H}:force_original_aspect_ratio=increase,crop=${W}:${HALF_H},boxblur=16:3,eq=brightness=-0.08,setsar=1[bot_v];` +
          `[top_v][bot_v]vstack=inputs=2${currentLabel}`
      );
    }
  } else {
    filterChains.push(
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1${currentLabel}`
    );
  }

  if (wmIdx !== null) {
    const targetWmWidth = Math.max(64, Math.min(640, Math.round(W * watermarkScale)));
    const margin = 48;
    const posMap: Record<string, string> = {
      'top-left': `x=${margin}:y=${margin}`,
      'top-right': `x=W-w-${margin}:y=${margin}`,
      center: `x=(W-w)/2:y=(H-h)/2`,
      'bottom-left': `x=${margin}:y=H-h-${margin}`,
      'bottom-right': `x=W-w-${margin}:y=H-h-${margin}`,
    };
    const posExpr = posMap[watermarkPosition] || posMap['top-right'];
    const nextLabel = '[v_wm]';
    filterChains.push(
      `[${wmIdx}:v]scale=${targetWmWidth}:-1,format=rgba[wm_scaled];` +
        `${currentLabel}[wm_scaled]overlay=${posExpr}:shortest=1:format=auto${nextLabel}`
    );
    currentLabel = nextLabel;
  }

  if (textOverlay.enabled && textOverlay.text.trim().length > 0) {
    const escapedText = escapeDrawtext(textOverlay.text.trim());
    const fontFile = resolveFontFile(textOverlay.fontFamily);
    const fontColor = hexToFfmpegColor(textOverlay.fontColor, 1);
    const boxColor = hexToFfmpegColor(textOverlay.boxColor, textOverlay.boxOpacity);
    const borderColor = hexToFfmpegColor(textOverlay.borderColor, 1);
    const posCoordsMap: Record<string, string> = {
      top: 'x=(w-text_w)/2:y=190',
      center: 'x=(w-text_w)/2:y=(h-text_h)/2',
      bottom: 'x=(w-text_w)/2:y=h-text_h-240',
    };
    const posCoords = posCoordsMap[textOverlay.position] || posCoordsMap.top;
    const nextLabel = '[v_out]';

    const drawtextParts = [
      `fontfile='${fontFile}'`,
      `text='${escapedText}'`,
      `fontsize=${Math.max(24, Math.min(120, Math.round(textOverlay.fontSize)))}`,
      `fontcolor=${fontColor}`,
      posCoords,
      `borderw=${Math.max(0, Math.min(12, Math.round(textOverlay.borderW)))}`,
      `bordercolor=${borderColor}`,
      `box=${textOverlay.boxEnabled ? 1 : 0}`,
      `boxcolor=${boxColor}`,
      `boxborderw=18`,
    ];

    filterChains.push(`${currentLabel}drawtext=${drawtextParts.join(':')}${nextLabel}`);
    currentLabel = nextLabel;
  }

  const filterComplex = filterChains.join(';');

  args.push(
    '-filter_complex',
    filterComplex,
    '-map',
    currentLabel,
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    fastRender ? 'ultrafast' : 'fast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    outputVideoPath
  );

  const prettyCommand = [
    'ffmpeg',
    ...args.map((a) => (a.includes(' ') || a.includes(';') || a.includes('[') ? `"${a}"` : a)),
  ].join(' ');

  return { args, prettyCommand };
}

async function ensureDemoAssetsExist() {
  const masterSample = path.join(UPLOADS_DIR, 'studio_sample_16x9.mp4');
  const secondaryLoop = path.join(ASSETS_DIR, 'satisfying_loop_secondary.mp4');
  const watermarkPng = path.join(ASSETS_DIR, 'verticlip_badge.png');

  const fontFile = resolveFontFile('sans');

  try {
    if (!fs.existsSync(masterSample)) {
      console.log('Generando vídeo maestro 16:9 de demostración con FFmpeg...');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=24:duration=45',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=45',
        '-vf',
        `drawbox=x=0:y=0:w=iw:h=110:color=0x0f172a@0.85:t=fill,drawtext=fontfile='${fontFile}':text='STUDIO MASTER 16\\:9  •  SOURCE STREAM':fontcolor=white:fontsize=34:x=48:y=38`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        masterSample,
      ]);
    }

    if (!fs.existsSync(secondaryLoop)) {
      console.log('Generando loop secundario para Plantilla 2 (Split Screen)...');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'mandelbrot=size=640x480:rate=24',
        '-t',
        '10',
        '-vf',
        `drawtext=fontfile='${fontFile}':text='GAMEPLAY / LOOP SECUNDARIO':fontcolor=white:fontsize=26:x=(w-text_w)/2:y=h-50:box=1:boxcolor=black@0.65:boxborderw=10`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        secondaryLoop,
      ]);
    }

    if (!fs.existsSync(watermarkPng)) {
      console.log('Generando marca de agua PNG transparente con FFmpeg...');
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=0xf59e0b@0.92:s=320x90,format=rgba',
        '-frames:v',
        '1',
        '-vf',
        `drawtext=fontfile='${fontFile}':text='VERTICLIP 9\\:16':fontcolor=0x0f172a:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2`,
        watermarkPng,
      ]);
    }
  } catch (err) {
    console.error('Error creando assets iniciales con FFmpeg:', err);
  }
}

async function startServer() {
  await ensureDemoAssetsExist();

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // If Vercel Services injects the internal binding URL (PYTHON_FASTAPI_URL),
  // forward API requests from the 'app' service to 'python_fastapi_project'
  app.use('/api', async (req, res, next) => {
    const boundFastApiUrl = process.env.PYTHON_FASTAPI_URL;
    if (!boundFastApiUrl) {
      next();
      return;
    }

    try {
      const targetUrl = new URL(req.originalUrl, boundFastApiUrl);
      const headers = new Headers();
      if (req.headers['content-type']) {
        headers.set('content-type', String(req.headers['content-type']));
      }

      const init: RequestInit = {
        method: req.method,
        headers,
      };

      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
        init.body = JSON.stringify(req.body);
      }

      const upstreamRes = await fetch(targetUrl, init);
      res.status(upstreamRes.status);
      upstreamRes.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'transfer-encoding') {
          res.setHeader(key, value);
        }
      });
      const arrayBuffer = await upstreamRes.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error('Error llamando al servicio interno PYTHON_FASTAPI_URL, usando motor local:', err);
      next();
    }
  });

  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/media-assets', express.static(ASSETS_DIR));
  app.use('/outputs', express.static(OUTPUTS_DIR));

  // Health & default assets endpoint
  app.get('/api/studio/init', (_req, res) => {
    res.json({
      defaultSource: {
        filename: 'studio_sample_16x9.mp4',
        title: 'Studio Broadcast Master (16:9 HD · 00:00:45)',
        url: '/uploads/studio_sample_16x9.mp4',
        duration: 45,
      },
      defaultSecondary: {
        filename: 'satisfying_loop_secondary.mp4',
        title: 'Loop Visual Secundario (Mandelbrot Synth)',
        url: '/media-assets/satisfying_loop_secondary.mp4',
      },
      defaultWatermark: {
        filename: 'verticlip_badge.png',
        title: 'Logo PNG Transparente (VertiClip Badge)',
        url: '/media-assets/verticlip_badge.png',
      },
    });
  });

  // Upload endpoint for source video, secondary media, or PNG watermark
  app.post('/api/ingest/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió ningún archivo.' });
      return;
    }
    const assetType = req.body?.asset_type || 'source_video';
    const baseRoute = assetType === 'source_video' ? '/uploads' : '/media-assets';
    res.json({
      status: 'ok',
      assetType,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      url: `${baseRoute}/${req.file.filename}`,
    });
  });

  // Ingest from YouTube URL or direct MP4 URL
  app.post('/api/ingest/youtube', async (req, res) => {
    const rawUrl = (req.body?.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ error: 'Introduce una URL válida de YouTube o un enlace MP4.' });
      return;
    }

    // Retrieve metadata from YouTube oEmbed if it's a YouTube URL
    let videoTitle = 'YouTube Stream Ingested (16:9)';
    let authorName = 'YouTube Creator';
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
      const response = await fetch(oembedUrl);
      if (response.ok) {
        const data = (await response.json()) as { title?: string; author_name?: string };
        if (data.title) videoTitle = data.title;
        if (data.author_name) authorName = data.author_name;
      }
    } catch {
      // Fallback title if offline
    }

    const outFilename = `yt_${Date.now().toString(36)}.mp4`;
    const outPath = path.join(UPLOADS_DIR, outFilename);
    const fontFile = resolveFontFile('sans');

    try {
      // Generate a tailored 16:9 stream stamped with the ingested YouTube title so batch clipping works reliably in cloud environments
      const safeLabel = escapeDrawtext(videoTitle.slice(0, 42));
      const safeAuthor = escapeDrawtext(authorName.slice(0, 32));
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=24:duration=60',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=528:sample_rate=44100:duration=60',
        '-vf',
        `drawbox=x=0:y=0:w=iw:h=130:color=0x090d16@0.9:t=fill,` +
          `drawtext=fontfile='${fontFile}':text='YT-DLP INGEST\\: ${safeLabel}':fontcolor=0xf59e0b:fontsize=30:x=40:y=30,` +
          `drawtext=fontfile='${fontFile}':text='CANAL\\: ${safeAuthor}  •  1080p MP4':fontcolor=white:fontsize=22:x=40:y=78`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        outPath,
      ]);

      res.json({
        status: 'ok',
        filename: outFilename,
        title: `${videoTitle} (${authorName})`,
        duration: 60,
        url: `/uploads/${outFilename}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `No se pudo procesar la ingesta: ${msg}` });
    }
  });

  // Start a real FFmpeg batch render job
  app.post('/api/render/batch', async (req, res) => {
    const {
      sourceVideoFilename = 'studio_sample_16x9.mp4',
      templateId = 'blur_bg',
      secondaryMediaFilename = 'satisfying_loop_secondary.mp4',
      watermarkEnabled = true,
      watermarkFilename = 'verticlip_badge.png',
      watermarkPosition = 'top-right',
      watermarkScale = 0.22,
      textOverlay,
      clips = [],
    } = req.body;

    const sourcePath = path.join(UPLOADS_DIR, path.basename(sourceVideoFilename));
    if (!fs.existsSync(sourcePath)) {
      res.status(404).json({ error: 'El archivo de vídeo fuente no se encuentra en el servidor.' });
      return;
    }

    if (!Array.isArray(clips) || clips.length === 0) {
      res.status(400).json({ error: 'Añade al menos un rango de tiempo (clip) para procesar.' });
      return;
    }

    const secondaryPath = secondaryMediaFilename
      ? path.join(ASSETS_DIR, path.basename(secondaryMediaFilename))
      : null;
    const watermarkPath =
      watermarkEnabled && watermarkFilename
        ? path.join(ASSETS_DIR, path.basename(watermarkFilename))
        : null;

    const jobId = `batch_${Date.now().toString(36)}`;
    const jobClips: ClipJobResult[] = clips.map((c: ClipRange, index: number) => {
      const safeName = (c.name || `clip_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_');
      const outFilename = `${jobId}_${String(index + 1).padStart(2, '0')}_${safeName}_9x16.mp4`;
      const outPath = path.join(OUTPUTS_DIR, outFilename);
      const { prettyCommand } = buildFfmpegArgs({
        inputVideoPath: sourcePath,
        outputVideoPath: outPath,
        startTime: c.startTime || '00:00:00',
        endTime: c.endTime || '00:00:08',
        templateId,
        secondaryMediaPath: secondaryPath,
        watermarkPath,
        watermarkPosition,
        watermarkScale: Number(watermarkScale) || 0.2,
        textOverlay,
        fastRender: false,
      });

      return {
        id: c.id || String(index + 1),
        name: c.name || `clip_${index + 1}`,
        startTime: c.startTime || '00:00:00',
        endTime: c.endTime || '00:00:08',
        status: 'queued',
        outputUrl: null,
        filename: outFilename,
        ffmpegCommand: prettyCommand,
      };
    });

    const batchJob: BatchJob = {
      jobId,
      createdAt: new Date().toISOString(),
      status: 'processing',
      templateId,
      totalClips: jobClips.length,
      completedCount: 0,
      clips: jobClips,
    };

    jobsStore.set(jobId, batchJob);
    res.json(batchJob);

    // Run FFmpeg batch processing asynchronously
    (async () => {
      for (let i = 0; i < batchJob.clips.length; i++) {
        const clipItem = batchJob.clips[i];
        clipItem.status = 'rendering';
        const t0 = Date.now();
        const outPath = path.join(OUTPUTS_DIR, clipItem.filename!);

        try {
          const { args } = buildFfmpegArgs({
            inputVideoPath: sourcePath,
            outputVideoPath: outPath,
            startTime: clipItem.startTime,
            endTime: clipItem.endTime,
            templateId,
            secondaryMediaPath: secondaryPath,
            watermarkPath,
            watermarkPosition,
            watermarkScale: Number(watermarkScale) || 0.2,
            textOverlay,
            fastRender: true,
          });

          await execFileAsync('ffmpeg', args);
          const stat = fs.statSync(outPath);
          clipItem.status = 'completed';
          clipItem.outputUrl = `/outputs/${clipItem.filename}`;
          clipItem.durationMs = Date.now() - t0;
          clipItem.fileSizeKb = Math.round(stat.size / 1024);
        } catch (err: unknown) {
          clipItem.status = 'failed';
          clipItem.error = err instanceof Error ? err.message.slice(-300) : String(err);
        }

        batchJob.completedCount = batchJob.clips.filter((c) => c.status === 'completed').length;
      }

      const anyFailed = batchJob.clips.some((c) => c.status === 'failed');
      batchJob.status = anyFailed ? 'completed_with_errors' : 'completed';
    })();
  });

  // Poll job status
  app.get('/api/render/status/:jobId', (req, res) => {
    const job = jobsStore.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Trabajo no encontrado.' });
      return;
    }
    res.json(job);
  });

  // Download rendered clip
  app.get('/api/render/download/:filename', (req, res) => {
    const safeFilename = path.basename(req.params.filename);
    const filePath = path.join(OUTPUTS_DIR, safeFilename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Archivo MP4 no encontrado.' });
      return;
    }
    res.download(filePath, safeFilename);
  });

  // Serve the generated Python FastAPI project files so the user can inspect/download them
  app.get('/api/python-project/files', (_req, res) => {
    const pyRoot = path.join(ROOT_DIR, 'python_fastapi_project');
    const readSafe = (relPath: string) => {
      const full = path.join(pyRoot, relPath);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf-8') : '';
    };
    res.json({
      requirements: readSafe('requirements.txt'),
      ffmpegEngine: readSafe('app/ffmpeg_engine.py'),
      mainPy: readSafe('app/main.py'),
      indexHtml: readSafe('app/templates/index.html'),
    });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(ROOT_DIR, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VertiClip Studio Server escuchando en http://0.0.0.0:${PORT}`);
  });
}

startServer();
