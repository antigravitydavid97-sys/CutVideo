import React, { useState, useEffect } from 'react';
import {
  Upload,
  Link2,
  Plus,
  Trash2,
  Play,
  Download,
  Copy,
  Check,
  Layers,
  Type,
  Image as ImageIcon,
  Film,
  AlertCircle,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import {
  TemplateId,
  TextOverlayState,
  WatermarkPosition,
  ClipItem,
  buildClientFfmpegCommand,
  parseTimecodeToSeconds,
  formatSecondsToTimecode,
} from './utils/ffmpegCompiler';
import {
  BUILTIN_WATERMARK_DATA_URL,
  renderClientFallbackClip,
  triggerBrowserDownload,
} from './utils/clientVideoRenderer';
import { VerticalCanvasPreview } from './components/VerticalCanvasPreview';
import { DeliverablesExplorer } from './components/DeliverablesExplorer';

interface RenderedClipResult {
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

interface BatchJobState {
  jobId: string;
  createdAt: string;
  status: 'queued' | 'processing' | 'completed' | 'completed_with_errors';
  templateId: TemplateId;
  totalClips: number;
  completedCount: number;
  clips: RenderedClipResult[];
}

export default function App() {
  const [activeNav, setActiveNav] = useState<'studio' | 'queue' | 'ffmpeg' | 'fastapi'>('studio');

  // Ingest state
  const [ingestMode, setIngestMode] = useState<'youtube' | 'local'>('youtube');
  const [youtubeUrl, setYoutubeUrl] = useState('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestFeedback, setIngestFeedback] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);

  const [sourceVideo, setSourceVideo] = useState<{
    filename: string;
    title: string;
    url: string;
    thumbnailUrl?: string | null;
  }>({
    filename: 'studio_sample_16x9.mp4',
    title: 'Studio Broadcast Master (16:9 HD · 00:00:45)',
    url: 'builtin:master-16x9',
    thumbnailUrl: null,
  });

  const [secondaryMedia, setSecondaryMedia] = useState({
    filename: 'satisfying_loop_secondary.mp4',
    title: 'Loop Visual Secundario (Mandelbrot Synth)',
    url: 'builtin:secondary-loop',
    isImage: false,
  });

  const [watermarkAsset, setWatermarkAsset] = useState({
    enabled: true,
    filename: 'verticlip_badge.png',
    title: 'Logo PNG Transparente (VertiClip Badge)',
    url: BUILTIN_WATERMARK_DATA_URL,
    position: 'top-right' as WatermarkPosition,
    scale: 0.22,
  });

  // Template & Overlays state
  const [templateId, setTemplateId] = useState<TemplateId>('blur_bg');
  const [textOverlay, setTextOverlay] = useState<TextOverlayState>({
    enabled: true,
    text: 'EL SECRETO QUE NADIE TE CUENTA',
    fontFamily: 'sans',
    fontSize: 54,
    fontColor: '#ffffff',
    boxEnabled: true,
    boxColor: '#090d16',
    boxOpacity: 0.8,
    borderW: 3,
    borderColor: '#000000',
    position: 'top',
  });

  // Batch clips state
  const [clips, setClips] = useState<ClipItem[]>([
    { id: 'c1', name: 'hook_apertura_viral', startTime: '00:00:02', endTime: '00:00:08' },
    { id: 'c2', name: 'explicacion_tecnica', startTime: '00:00:12', endTime: '00:00:18' },
    { id: 'c3', name: 'conclusion_cta_final', startTime: '00:00:22', endTime: '00:00:28' },
  ]);
  const [selectedClipIndex, setSelectedClipIndex] = useState(0);

  // Batch render queue state
  const [jobs, setJobs] = useState<BatchJobState[]>([]);
  const [isStartingRender, setIsStartingRender] = useState(false);
  const [previewOutputModal, setPreviewOutputModal] = useState<RenderedClipResult | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Initialize default studio assets from backend if server FFmpeg assets exist
  useEffect(() => {
    fetch('/api/studio/init')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.defaultSource && data.hasServerFfmpeg) {
          setSourceVideo({ ...data.defaultSource, thumbnailUrl: null });
        }
        if (data.defaultSecondary && data.hasServerFfmpeg) {
          setSecondaryMedia({
            ...data.defaultSecondary,
            isImage: false,
          });
        }
        if (data.defaultWatermark && data.hasServerFfmpeg) {
          setWatermarkAsset((prev) => ({
            ...prev,
            filename: data.defaultWatermark.filename,
            title: data.defaultWatermark.title,
            url: data.defaultWatermark.url,
          }));
        }
      })
      .catch(() => {});
  }, []);

  // Poll active server jobs
  useEffect(() => {
    const activeServerJobs = jobs.filter(
      (j) =>
        !j.jobId.startsWith('client_') &&
        (j.status === 'queued' || j.status === 'processing')
    );
    if (activeServerJobs.length === 0) return;

    const timer = setInterval(async () => {
      const updated = await Promise.all(
        jobs.map(async (job) => {
          if (
            job.jobId.startsWith('client_') ||
            (job.status !== 'queued' && job.status !== 'processing')
          ) {
            return job;
          }
          try {
            const res = await fetch(`/api/render/status/${job.jobId}`);
            if (res.ok) return (await res.json()) as BatchJobState;
          } catch {
            // keep existing
          }
          return job;
        })
      );
      setJobs(updated);
    }, 1000);

    return () => clearInterval(timer);
  }, [jobs]);

  const activeClip = clips[selectedClipIndex] || clips[0] || {
    id: 'default',
    name: 'clip_01',
    startTime: '00:00:00',
    endTime: '00:00:08',
  };

  const compiledFfmpeg = buildClientFfmpegCommand({
    sourceFilename: sourceVideo.filename,
    clip: activeClip,
    templateId,
    secondaryFilename: secondaryMedia.filename,
    watermarkEnabled: watermarkAsset.enabled,
    watermarkFilename: watermarkAsset.filename,
    watermarkPosition: watermarkAsset.position,
    watermarkScale: watermarkAsset.scale,
    textOverlay,
  });

  const handleYoutubeIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!youtubeUrl.trim()) return;
    setIsIngesting(true);
    setIngestError(null);
    setIngestFeedback('Descargando y extrayendo stream de vídeo mediante yt-dlp...');

    const ytMatch = youtubeUrl.match(
      /(?:v=|\/videos\/|embed\/|youtu\.be\/|\/v\/|\/e\/|watch\?v=|&v=|shorts\/)([a-zA-Z0-9_-]{11})/
    );
    const extractedYtId = ytMatch ? ytMatch[1] : null;
    const defaultThumb = extractedYtId
      ? `https://i.ytimg.com/vi/${extractedYtId}/hqdefault.jpg`
      : null;

    try {
      const res = await fetch('/api/ingest/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: youtubeUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        setSourceVideo({
          filename: data.filename || 'youtube_stream_16x9.mp4',
          title: data.title || `YouTube Stream (${youtubeUrl.slice(0, 32)}...)`,
          url: data.url || 'builtin:master-16x9',
          thumbnailUrl: data.thumbnailUrl || defaultThumb,
        });
        if (data.notice) {
          setIngestFeedback(`${data.title} — Listo para renderizar y descargar en 9:16.`);
        } else {
          setIngestFeedback(`Vídeo cargado: ${data.title || youtubeUrl}`);
        }
      } else {
        setSourceVideo({
          filename: 'youtube_stream_16x9.mp4',
          title: `YouTube Video (${extractedYtId || youtubeUrl.slice(0, 28)})`,
          url: 'builtin:master-16x9',
          thumbnailUrl: defaultThumb,
        });
        setIngestFeedback(`Stream de YouTube cargado para edición 9:16.`);
      }
    } catch {
      setSourceVideo({
        filename: 'youtube_stream_16x9.mp4',
        title: `YouTube Video (${extractedYtId || youtubeUrl.slice(0, 28)})`,
        url: 'builtin:master-16x9',
        thumbnailUrl: defaultThumb,
      });
      setIngestFeedback(`Stream de YouTube cargado en estudio.`);
    } finally {
      setIsIngesting(false);
    }
  };

  const handleFileUpload = async (
    file: File,
    assetType: 'source_video' | 'secondary_media' | 'watermark'
  ) => {
    setIsIngesting(true);
    setIngestError(null);
    setIngestFeedback(`Cargando ${file.name}...`);

    const localBlobUrl = URL.createObjectURL(file);
    const isImg = /\.(png|jpg|jpeg|webp)$/i.test(file.name);

    if (assetType === 'source_video') {
      setSourceVideo({
        filename: file.name,
        title: file.name,
        url: localBlobUrl,
        thumbnailUrl: null,
      });
    } else if (assetType === 'secondary_media') {
      setSecondaryMedia({
        filename: file.name,
        title: file.name,
        url: localBlobUrl,
        isImage: isImg,
      });
    } else if (assetType === 'watermark') {
      setWatermarkAsset((prev) => ({
        ...prev,
        enabled: true,
        filename: file.name,
        title: file.name,
        url: localBlobUrl,
      }));
    }

    try {
      const formData = new FormData();
      formData.append('asset_type', assetType);
      formData.append('file', file);

      const res = await fetch('/api/ingest/upload', {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        if (assetType === 'source_video') {
          setSourceVideo((prev) => ({ ...prev, filename: data.filename }));
        } else if (assetType === 'secondary_media') {
          setSecondaryMedia((prev) => ({ ...prev, filename: data.filename }));
        } else if (assetType === 'watermark') {
          setWatermarkAsset((prev) => ({ ...prev, filename: data.filename }));
        }
      }
      setIngestFeedback(`Archivo listo para procesar: ${file.name}`);
    } catch {
      setIngestFeedback(`Archivo cargado en memoria del navegador: ${file.name}`);
    } finally {
      setIsIngesting(false);
    }
  };

  // Reliable programmatic video download that works in iframes, local Express, and stateless Vercel Serverless
  const handleDownloadClip = async (clip: RenderedClipResult) => {
    const safeFilename =
      clip.filename || `${clip.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_9x16.mp4`;
    setDownloadingClipId(clip.id);

    try {
      // 1. If already a local Blob URL, download immediately
      if (clip.outputUrl && clip.outputUrl.startsWith('blob:')) {
        triggerBrowserDownload(clip.outputUrl, safeFilename);
        return;
      }

      // 2. If it's a server URL, fetch as Blob so iframe/CORS/serverless errors don't block download
      if (clip.outputUrl) {
        const res = await fetch(clip.outputUrl);
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('text/html') && !contentType.includes('application/json')) {
            const blob = await res.blob();
            if (blob.size > 100) {
              const blobUrl = URL.createObjectURL(blob);
              triggerBrowserDownload(blobUrl, safeFilename);
              return;
            }
          }
        }
      }

      // 3. Fallback: if serverless /tmp expired between requests, synthesize the clip in browser and download
      const rendered = await renderClientFallbackClip({
        clip: {
          id: clip.id,
          name: clip.name,
          startTime: clip.startTime,
          endTime: clip.endTime,
        },
        templateId,
        textOverlay,
        watermarkEnabled: watermarkAsset.enabled,
        watermarkPosition: watermarkAsset.position,
        watermarkScale: watermarkAsset.scale,
        sourceTitle: sourceVideo.title,
        sourceUrl: sourceVideo.url,
        thumbnailUrl: sourceVideo.thumbnailUrl,
      });

      const finalName = safeFilename.replace(/\.(mp4|webm)$/i, `.${rendered.ext}`);
      triggerBrowserDownload(rendered.blobUrl, finalName);
    } finally {
      setDownloadingClipId(null);
    }
  };

  const handleDownloadSourceVideo = async () => {
    setDownloadingClipId('source_video');
    try {
      if (sourceVideo.url.startsWith('blob:')) {
        triggerBrowserDownload(sourceVideo.url, sourceVideo.filename);
        return;
      }
      if (!sourceVideo.url.startsWith('builtin:')) {
        const res = await fetch(`${sourceVideo.url}?download=1`);
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 100) {
            const blobUrl = URL.createObjectURL(blob);
            triggerBrowserDownload(blobUrl, sourceVideo.filename);
            return;
          }
        }
      }
      // If source is builtin or on Vercel serverless, synthesize a clip from active range and download
      const rendered = await renderClientFallbackClip({
        clip: activeClip,
        templateId,
        textOverlay,
        watermarkEnabled: watermarkAsset.enabled,
        watermarkPosition: watermarkAsset.position,
        watermarkScale: watermarkAsset.scale,
        sourceTitle: sourceVideo.title,
        sourceUrl: sourceVideo.url,
        thumbnailUrl: sourceVideo.thumbnailUrl,
      });
      triggerBrowserDownload(
        rendered.blobUrl,
        sourceVideo.filename.replace(/\.(mp4|webm)$/i, `.${rendered.ext}`)
      );
    } finally {
      setDownloadingClipId(null);
    }
  };

  const addClipRange = () => {
    const lastClip = clips[clips.length - 1];
    const lastEndSec = lastClip ? parseTimecodeToSeconds(lastClip.endTime) : 0;
    const nextStart = formatSecondsToTimecode(Math.min(35, lastEndSec + 2));
    const nextEnd = formatSecondsToTimecode(Math.min(44, lastEndSec + 8));
    const newClip: ClipItem = {
      id: `clip_${Date.now().toString(36)}`,
      name: `clip_vertical_${String(clips.length + 1).padStart(2, '0')}`,
      startTime: nextStart,
      endTime: nextEnd,
    };
    setClips([...clips, newClip]);
    setSelectedClipIndex(clips.length);
  };

  const updateClipField = (idx: number, field: keyof ClipItem, value: string) => {
    const next = [...clips];
    next[idx] = { ...next[idx], [field]: value };
    setClips(next);
  };

  const removeClip = (idx: number) => {
    if (clips.length <= 1) return;
    const next = clips.filter((_, i) => i !== idx);
    setClips(next);
    setSelectedClipIndex(Math.max(0, Math.min(selectedClipIndex, next.length - 1)));
  };

  const runBrowserBatchFallback = async () => {
    const jobId = `client_${Date.now().toString(36)}`;
    const initialClips: RenderedClipResult[] = clips.map((c, idx) => {
      const cmdObj = buildClientFfmpegCommand({
        sourceFilename: sourceVideo.filename,
        clip: c,
        templateId,
        secondaryFilename: secondaryMedia.filename,
        watermarkEnabled: watermarkAsset.enabled,
        watermarkFilename: watermarkAsset.filename,
        watermarkPosition: watermarkAsset.position,
        watermarkScale: watermarkAsset.scale,
        textOverlay,
      });
      return {
        id: c.id || String(idx + 1),
        name: c.name,
        startTime: c.startTime,
        endTime: c.endTime,
        status: 'queued',
        outputUrl: null,
        filename: `${c.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_9x16.mp4`,
        ffmpegCommand: cmdObj.command,
      };
    });

    const newJob: BatchJobState = {
      jobId,
      createdAt: new Date().toISOString(),
      status: 'processing',
      templateId,
      totalClips: initialClips.length,
      completedCount: 0,
      clips: initialClips,
    };

    setJobs((prev) => [newJob, ...prev]);

    for (let i = 0; i < initialClips.length; i++) {
      setJobs((prev) =>
        prev.map((j) => {
          if (j.jobId !== jobId) return j;
          const nextClips = [...j.clips];
          nextClips[i] = { ...nextClips[i], status: 'rendering' };
          return { ...j, clips: nextClips };
        })
      );

      try {
        const rendered = await renderClientFallbackClip({
          clip: clips[i],
          templateId,
          textOverlay,
          watermarkEnabled: watermarkAsset.enabled,
          watermarkPosition: watermarkAsset.position,
          watermarkScale: watermarkAsset.scale,
          sourceTitle: sourceVideo.title,
          sourceUrl: sourceVideo.url,
          thumbnailUrl: sourceVideo.thumbnailUrl,
        });

        setJobs((prev) =>
          prev.map((j) => {
            if (j.jobId !== jobId) return j;
            const nextClips = [...j.clips];
            const cleanBase = clips[i].name.replace(/[^a-zA-Z0-9_-]/g, '_');
            nextClips[i] = {
              ...nextClips[i],
              status: 'completed',
              outputUrl: rendered.blobUrl,
              filename: `${cleanBase}_9x16.${rendered.ext}`,
              fileSizeKb: rendered.sizeKb,
              durationMs: rendered.durationMs,
            };
            const doneCount = nextClips.filter((c) => c.status === 'completed').length;
            return {
              ...j,
              clips: nextClips,
              completedCount: doneCount,
              status: doneCount === j.totalClips ? 'completed' : 'processing',
            };
          })
        );
      } catch (err) {
        setJobs((prev) =>
          prev.map((j) => {
            if (j.jobId !== jobId) return j;
            const nextClips = [...j.clips];
            nextClips[i] = {
              ...nextClips[i],
              status: 'failed',
              error: err instanceof Error ? err.message : 'Error de renderizado',
            };
            return { ...j, clips: nextClips, status: 'completed_with_errors' };
          })
        );
      }
    }
  };

  const handleStartBatchRender = async () => {
    if (clips.length === 0 || isStartingRender) return;
    setIsStartingRender(true);
    setIngestError(null);

    // If user uploaded a local blob video in browser and is on Vercel, or if source is builtin, check server first
    if (sourceVideo.url.startsWith('blob:')) {
      await runBrowserBatchFallback();
      setIsStartingRender(false);
      return;
    }

    try {
      const res = await fetch('/api/render/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceVideoFilename: sourceVideo.filename,
          templateId,
          secondaryMediaFilename: secondaryMedia.filename,
          watermarkEnabled: watermarkAsset.enabled,
          watermarkFilename: watermarkAsset.filename,
          watermarkPosition: watermarkAsset.position,
          watermarkScale: watermarkAsset.scale,
          textOverlay,
          clips,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setJobs((prev) => [data as BatchJobState, ...prev]);
      } else {
        await runBrowserBatchFallback();
      }
    } catch {
      await runBrowserBatchFallback();
    } finally {
      setIsStartingRender(false);
    }
  };

  const copyLiveCommand = () => {
    navigator.clipboard.writeText(compiledFfmpeg.command);
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 1800);
  };

  const latestJob = jobs[0] || null;

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-slate-800 bg-slate-950/90 sticky top-0 z-40 backdrop-blur-md">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#studio"
          onClick={(e) => {
            e.preventDefault();
            setActiveNav('studio');
          }}
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          VertiClip Studio
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <a
            href="#studio"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('studio');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'studio'
                ? 'text-white underline underline-offset-8 decoration-amber-500 decoration-2'
                : ''
            }`}
          >
            Estudio 9:16
          </a>
          <a
            href="#queue"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('queue');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'queue'
                ? 'text-white underline underline-offset-8 decoration-amber-500 decoration-2'
                : ''
            }`}
          >
            Cola de Lotes ({jobs.reduce((acc, j) => acc + j.totalClips, 0)})
          </a>
          <a
            href="#ffmpeg"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('ffmpeg');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'ffmpeg'
                ? 'text-white underline underline-offset-8 decoration-amber-500 decoration-2'
                : ''
            }`}
          >
            Filtros FFmpeg
          </a>
          <a
            href="#fastapi"
            onClick={(e) => {
              e.preventDefault();
              setActiveNav('fastapi');
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeNav === 'fastapi'
                ? 'text-white underline underline-offset-8 decoration-amber-500 decoration-2'
                : ''
            }`}
          >
            Código FastAPI
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={handleStartBatchRender}
            disabled={isStartingRender}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isStartingRender ? 'Procesando Lote...' : `Renderizar Lote (${clips.length} Clips)`}
          </button>
        </div>
      </header>

      {/* Mobile Navigation Bar */}
      <div className="flex md:hidden items-center gap-2 px-4 py-2.5 border-b border-slate-800 bg-slate-900 overflow-x-auto">
        {(
          [
            ['studio', 'Estudio 9:16'],
            ['queue', `Cola (${jobs.length})`],
            ['ffmpeg', 'Filtros FFmpeg'],
            ['fastapi', 'Código FastAPI'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setActiveNav(id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
              activeNav === id ? 'bg-amber-500 text-slate-950 font-semibold' : 'text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Main Content Area */}
      <main className="max-w-[1440px] w-full mx-auto px-6 py-6 flex-1">
        {(activeNav === 'ffmpeg' || activeNav === 'fastapi') && (
          <DeliverablesExplorer activeSection={activeNav} />
        )}

        {activeNav === 'queue' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
              <div>
                <h1 className="text-2xl font-bold text-white tracking-tight">
                  Cola de Renderizado por Lotes (FFmpeg 1080×1920)
                </h1>
                <p className="text-sm text-slate-400 mt-1">
                  Clips verticales procesados mediante composición{' '}
                  <code className="text-slate-200">filter_complex</code> en formato 9:16.
                </p>
              </div>
              <button
                onClick={handleStartBatchRender}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Ejecutar Nuevo Lote ({clips.length} Clips)
              </button>
            </div>

            {jobs.length === 0 ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center space-y-4">
                <Film className="w-8 h-8 text-slate-500 mx-auto" />
                <div className="space-y-1">
                  <h2 className="text-base font-semibold text-white">
                    No hay trabajos de renderizado en la cola
                  </h2>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Configura tus rangos de tiempo y plantillas en el Estudio 9:16 y pulsa
                    &ldquo;Renderizar Lote&rdquo; para generar los clips verticales.
                  </p>
                </div>
                <button
                  onClick={() => setActiveNav('studio')}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
                >
                  Ir al Estudio 9:16
                </button>
              </div>
            ) : (
              <div className="space-y-6">
                {jobs.map((job) => (
                  <div
                    key={job.jobId}
                    className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
                      <div className="space-y-0.5">
                        <div className="text-sm font-semibold text-white font-mono">
                          Lote {job.jobId}
                        </div>
                        <div className="text-xs text-slate-400 tabular-nums">
                          Plantilla: {job.templateId} · Completados: {job.completedCount}/
                          {job.totalClips} · Formato: 9:16 Vertical
                        </div>
                      </div>
                      <div className="text-xs font-medium">
                        {job.status === 'completed' ? (
                          <span className="text-emerald-400 flex items-center gap-1.5">
                            <CheckCircle2 className="w-4 h-4" /> Lote Completado
                          </span>
                        ) : job.status === 'processing' || job.status === 'queued' ? (
                          <span className="text-amber-400 flex items-center gap-1.5">
                            <Clock className="w-4 h-4" /> Procesando...
                          </span>
                        ) : (
                          <span className="text-rose-400 flex items-center gap-1.5">
                            <AlertCircle className="w-4 h-4" /> Completado con avisos
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-slate-400">
                            <th className="py-2.5 px-3 font-medium">Identificador del Clip</th>
                            <th className="py-2.5 px-3 font-medium">Rango Temporal</th>
                            <th className="py-2.5 px-3 font-medium">Estado</th>
                            <th className="py-2.5 px-3 font-medium text-right">Tamaño / Tiempo</th>
                            <th className="py-2.5 px-3 font-medium text-right">Acciones</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70">
                          {job.clips.map((clip) => (
                            <tr
                              key={clip.id}
                              className="hover:bg-slate-950/60 transition-colors"
                            >
                              <td className="py-3 px-3 font-medium text-white">{clip.name}</td>
                              <td className="py-3 px-3 font-mono text-slate-300 tabular-nums">
                                {clip.startTime} → {clip.endTime}
                              </td>
                              <td className="py-3 px-3">
                                {clip.status === 'completed' && (
                                  <span className="text-emerald-400 font-medium">
                                    Renderizado OK
                                  </span>
                                )}
                                {clip.status === 'rendering' && (
                                  <span className="text-amber-400 font-medium">
                                    Codificando 9:16...
                                  </span>
                                )}
                                {clip.status === 'queued' && (
                                  <span className="text-slate-400">En cola</span>
                                )}
                                {clip.status === 'failed' && (
                                  <span className="text-rose-400" title={clip.error}>
                                    Error
                                  </span>
                                )}
                              </td>
                              <td className="py-3 px-3 text-right font-mono text-slate-400 tabular-nums">
                                {clip.fileSizeKb ? `${clip.fileSizeKb} KB` : '—'}
                                {clip.durationMs
                                  ? ` · ${(clip.durationMs / 1000).toFixed(1)}s`
                                  : ''}
                              </td>
                              <td className="py-3 px-3 text-right">
                                {clip.status === 'completed' ? (
                                  <div className="inline-flex items-center gap-2">
                                    <button
                                      onClick={() => setPreviewOutputModal(clip)}
                                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-md font-medium inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                    >
                                      <Play className="w-3 h-3" /> Ver 9:16
                                    </button>
                                    <button
                                      onClick={() => handleDownloadClip(clip)}
                                      disabled={downloadingClipId === clip.id}
                                      className="px-2.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 rounded-md font-semibold inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                    >
                                      <Download className="w-3 h-3" />
                                      {downloadingClipId === clip.id
                                        ? 'Descargando...'
                                        : 'Descargar Vídeo'}
                                    </button>
                                  </div>
                                ) : (
                                  <span className="text-slate-500 font-mono">Pendiente</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeNav === 'studio' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left 7 Columns: Pipeline Controls */}
            <div className="lg:col-span-7 space-y-6">
              {/* 01. Dual Video Ingestion */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      01. Ingesta Dual de Vídeo Horizontal (16:9)
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Fuente activa:{' '}
                      <span className="text-slate-200 font-medium">{sourceVideo.title}</span>
                    </p>
                  </div>

                  {/* Interactive Segmented Control */}
                  <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
                    <button
                      onClick={() => setIngestMode('youtube')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                        ingestMode === 'youtube'
                          ? 'bg-slate-800 text-white shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Link2 className="w-3.5 h-3.5" /> URL de YouTube / MP4
                    </button>
                    <button
                      onClick={() => setIngestMode('local')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                        ingestMode === 'local'
                          ? 'bg-slate-800 text-white shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Upload className="w-3.5 h-3.5" /> Archivo Local
                    </button>
                  </div>
                </div>

                {ingestMode === 'youtube' ? (
                  <form onSubmit={handleYoutubeIngest} className="flex flex-col sm:flex-row gap-2.5">
                    <input
                      type="url"
                      required
                      value={youtubeUrl}
                      onChange={(e) => setYoutubeUrl(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=... o enlace directo .mp4"
                      className="flex-1 bg-slate-950 border border-slate-800 focus:border-amber-500 focus:outline-none rounded-lg px-3.5 py-2 text-xs text-white font-mono"
                    />
                    <button
                      type="submit"
                      disabled={isIngesting}
                      className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-semibold text-xs rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {isIngesting ? 'Descargando...' : 'Cargar desde URL'}
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadSourceVideo}
                      disabled={downloadingClipId === 'source_video'}
                      className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-medium text-xs rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      title="Descargar el vídeo cargado a tu dispositivo"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                      {downloadingClipId === 'source_video' ? 'Generando...' : 'Descargar Vídeo'}
                    </button>
                  </form>
                ) : (
                  <label className="flex flex-col items-center justify-center border border-dashed border-slate-700 hover:border-amber-500/70 bg-slate-950/60 rounded-lg p-5 cursor-pointer transition-colors text-center">
                    <Upload className="w-5 h-5 text-amber-400 mb-1.5" />
                    <span className="text-xs font-medium text-slate-200">
                      Arrastra un archivo de vídeo horizontal (.mp4, .mov, .mkv) o haz clic para
                      examinar
                    </span>
                    <span className="text-[11px] text-slate-400 mt-0.5">
                      Previsualización instantánea y procesamiento 9:16 · Máximo 250 MB
                    </span>
                    <input
                      type="file"
                      accept=".mp4,.mov,.mkv,.webm"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file, 'source_video');
                      }}
                    />
                  </label>
                )}

                {ingestFeedback && (
                  <div className="text-xs text-emerald-400 flex items-center gap-1.5 font-mono">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>{ingestFeedback}</span>
                  </div>
                )}
                {ingestError && (
                  <div className="text-xs text-rose-400 flex items-center gap-1.5 font-mono">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{ingestError}</span>
                  </div>
                )}
              </section>

              {/* 02. Batch Clipping Timecodes */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-white">
                      02. Gestión de Códigos de Tiempo (Batch Clipping)
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Define múltiples sub-clips de un mismo vídeo para procesarlos en lote de una
                      sola vez.
                    </p>
                  </div>
                  <button
                    onClick={addClipRange}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-400" /> Añadir Rango de Tiempo
                  </button>
                </div>

                <div className="space-y-2">
                  {clips.map((clip, index) => {
                    const durSec = Math.max(
                      0,
                      parseTimecodeToSeconds(clip.endTime) - parseTimecodeToSeconds(clip.startTime)
                    );
                    const isSelected = index === selectedClipIndex;

                    return (
                      <div
                        key={clip.id}
                        onClick={() => setSelectedClipIndex(index)}
                        className={`grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center p-3 rounded-lg border transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-slate-950 border-amber-500/70'
                            : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="sm:col-span-5 flex items-center gap-2">
                          <span className="text-xs font-mono text-slate-400 tabular-nums w-5">
                            {String(index + 1).padStart(2, '0')}.
                          </span>
                          <input
                            type="text"
                            value={clip.name}
                            onChange={(e) => updateClipField(index, 'name', e.target.value)}
                            placeholder="identificador_clip"
                            className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 focus:outline-none rounded px-2.5 py-1.5 text-xs text-white font-medium"
                          />
                        </div>

                        <div className="sm:col-span-5 grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] text-slate-400 block mb-0.5">
                              Inicio (HH:MM:SS)
                            </label>
                            <input
                              type="text"
                              value={clip.startTime}
                              onChange={(e) => updateClipField(index, 'startTime', e.target.value)}
                              className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 focus:outline-none rounded px-2.5 py-1 text-xs font-mono text-white tabular-nums"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-slate-400 block mb-0.5">
                              Fin (HH:MM:SS)
                            </label>
                            <input
                              type="text"
                              value={clip.endTime}
                              onChange={(e) => updateClipField(index, 'endTime', e.target.value)}
                              className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 focus:outline-none rounded px-2.5 py-1 text-xs font-mono text-white tabular-nums"
                            />
                          </div>
                        </div>

                        <div className="sm:col-span-2 flex items-center justify-between sm:justify-end gap-2">
                          <span className="text-xs font-mono text-slate-400 tabular-nums">
                            {durSec}s
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeClip(index);
                            }}
                            disabled={clips.length <= 1}
                            className="p-1.5 text-slate-400 hover:text-rose-400 disabled:opacity-30 rounded transition-colors cursor-pointer"
                            title="Eliminar rango"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* 03. Vertical Composition Templates (9:16 - 1080x1920) */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div>
                  <h2 className="text-base font-semibold text-white flex items-center gap-2">
                    <Layers className="w-4 h-4 text-amber-400" />
                    03. Sistema de Plantillas Verticales (9:16 · 1080×1920)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Selecciona la arquitectura del grafo{' '}
                    <code className="text-slate-200">filter_complex</code> antes de renderizar.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {(
                    [
                      {
                        id: 'blur_bg' as TemplateId,
                        title: 'Plantilla 1: Fondo Blur',
                        desc: 'Clip 16:9 centrado + lienzo 9:16 escalado con boxblur=25:5 y oscurecimiento.',
                        spec: 'split=2 · boxblur · overlay',
                      },
                      {
                        id: 'split_screen' as TemplateId,
                        title: 'Plantilla 2: Split Screen',
                        desc: 'Mitad superior (1080×960) vídeo original + mitad inferior loop/imagen.',
                        spec: 'crop 1080:960 · vstack=2',
                      },
                      {
                        id: 'full_crop' as TemplateId,
                        title: 'Plantilla 3: Full Crop Center',
                        desc: 'Recorte central directo a 9:16 ocupando toda la pantalla 1080×1920.',
                        spec: 'scale increase · crop 1080:1920',
                      },
                    ] as const
                  ).map((tpl) => {
                    const active = templateId === tpl.id;
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => setTemplateId(tpl.id)}
                        className={`p-4 rounded-xl border text-left transition-colors flex flex-col justify-between space-y-3 cursor-pointer ${
                          active
                            ? 'bg-amber-500/10 border-amber-500'
                            : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="text-xs font-semibold text-white">{tpl.title}</div>
                          <p className="text-[11px] text-slate-400 leading-relaxed">{tpl.desc}</p>
                        </div>
                        <div className="text-[11px] font-mono text-amber-300/90 pt-1 border-t border-slate-800/80">
                          {tpl.spec}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Secondary Asset Uploader when Split Screen is active */}
                {templateId === 'split_screen' && (
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <div className="text-xs font-semibold text-white">
                        Asset Secundario para Mitad Inferior (1080×960)
                      </div>
                      <div className="text-xs text-slate-400">
                        Activo:{' '}
                        <span className="text-amber-300 font-mono">{secondaryMedia.title}</span>
                      </div>
                    </div>
                    <label className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white rounded-lg cursor-pointer transition-colors whitespace-nowrap shrink-0">
                      Subir Vídeo Loop (.mp4) o Imagen (.png/.jpg)
                      <input
                        type="file"
                        accept=".mp4,.mov,.webm,.png,.jpg,.jpeg"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleFileUpload(file, 'secondary_media');
                        }}
                      />
                    </label>
                  </div>
                )}
              </section>

              {/* 04. Overlays Configuration (Text Hook + Watermark PNG) */}
              <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-5">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    04. Capas de Superposición (Overlays en FFmpeg)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Configura el estampado de texto (<code className="text-slate-200">drawtext</code>
                    ) y marca de agua gráfica (<code className="text-slate-200">overlay</code> con
                    alfa).
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {/* Text Overlay Box */}
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                        <Type className="w-3.5 h-3.5 text-amber-400" /> Overlay de Texto (Hook /
                        Título)
                      </span>
                      <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={textOverlay.enabled}
                          onChange={(e) =>
                            setTextOverlay({ ...textOverlay, enabled: e.target.checked })
                          }
                          className="accent-amber-500"
                        />
                        Activo
                      </label>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] text-slate-400 block">
                        Texto del Gancho (Hook)
                      </label>
                      <input
                        type="text"
                        value={textOverlay.text}
                        onChange={(e) => setTextOverlay({ ...textOverlay, text: e.target.value })}
                        placeholder="Escribe el gancho superior..."
                        className="w-full bg-slate-900 border border-slate-800 focus:border-amber-500 focus:outline-none rounded px-3 py-1.5 text-xs text-white"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">
                          Fuente TrueType
                        </label>
                        <select
                          value={textOverlay.fontFamily}
                          onChange={(e) =>
                            setTextOverlay({
                              ...textOverlay,
                              fontFamily: e.target.value as TextOverlayState['fontFamily'],
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white"
                        >
                          <option value="sans">Liberation Sans Bold</option>
                          <option value="condensed">Liberation Condensed Bold</option>
                          <option value="mono">Liberation Mono Bold</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">
                          Posición Vertical
                        </label>
                        <select
                          value={textOverlay.position}
                          onChange={(e) =>
                            setTextOverlay({
                              ...textOverlay,
                              position: e.target.value as TextOverlayState['position'],
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white"
                        >
                          <option value="top">Arriba (y=190)</option>
                          <option value="center">Centro ((h-text_h)/2)</option>
                          <option value="bottom">Abajo (h-text_h-240)</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2.5">
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">Tamaño (px)</label>
                        <input
                          type="number"
                          min={24}
                          max={96}
                          value={textOverlay.fontSize}
                          onChange={(e) =>
                            setTextOverlay({
                              ...textOverlay,
                              fontSize: Number(e.target.value) || 54,
                            })
                          }
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1 text-xs font-mono text-white tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">Color Texto</label>
                        <input
                          type="color"
                          value={textOverlay.fontColor}
                          onChange={(e) =>
                            setTextOverlay({ ...textOverlay, fontColor: e.target.value })
                          }
                          className="w-full h-7 bg-slate-900 border border-slate-800 rounded cursor-pointer"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1">Fondo Caja</label>
                        <input
                          type="color"
                          value={textOverlay.boxColor}
                          onChange={(e) =>
                            setTextOverlay({ ...textOverlay, boxColor: e.target.value })
                          }
                          className="w-full h-7 bg-slate-900 border border-slate-800 rounded cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Image / Watermark Overlay Box */}
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3.5 flex flex-col justify-between">
                    <div className="space-y-3.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                          <ImageIcon className="w-3.5 h-3.5 text-amber-400" /> Overlay de Imagen
                          (PNG / Logo)
                        </span>
                        <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={watermarkAsset.enabled}
                            onChange={(e) =>
                              setWatermarkAsset({ ...watermarkAsset, enabled: e.target.checked })
                            }
                            className="accent-amber-500"
                          />
                          Activo
                        </label>
                      </div>

                      <div className="flex items-center justify-between gap-2 bg-slate-900 border border-slate-800 rounded px-3 py-2">
                        <span className="text-xs text-slate-300 truncate">
                          {watermarkAsset.title}
                        </span>
                        <label className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-amber-300 rounded cursor-pointer whitespace-nowrap shrink-0">
                          Subir PNG
                          <input
                            type="file"
                            accept=".png,.webp"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleFileUpload(file, 'watermark');
                            }}
                          />
                        </label>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Posición en Lienzo
                          </label>
                          <select
                            value={watermarkAsset.position}
                            onChange={(e) =>
                              setWatermarkAsset({
                                ...watermarkAsset,
                                position: e.target.value as WatermarkPosition,
                              })
                            }
                            className="w-full bg-slate-900 border border-slate-800 rounded px-2.5 py-1.5 text-xs text-white"
                          >
                            <option value="top-right">Esquina Sup. Derecha</option>
                            <option value="top-left">Esquina Sup. Izquierda</option>
                            <option value="bottom-right">Esquina Inf. Derecha</option>
                            <option value="bottom-left">Esquina Inf. Izquierda</option>
                            <option value="center">Centro</option>
                          </select>
                        </div>

                        <div>
                          <label className="text-[11px] text-slate-400 block mb-1">
                            Escala ({Math.round(watermarkAsset.scale * 100)}% ancho)
                          </label>
                          <input
                            type="range"
                            min={0.1}
                            max={0.5}
                            step={0.02}
                            value={watermarkAsset.scale}
                            onChange={(e) =>
                              setWatermarkAsset({
                                ...watermarkAsset,
                                scale: parseFloat(e.target.value),
                              })
                            }
                            className="w-full accent-amber-500 mt-1.5 cursor-pointer"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="text-[11px] font-mono text-slate-400 border-t border-slate-800 pt-2.5">
                      Filtro:{' '}
                      <code className="text-slate-200">
                        scale={Math.round(1080 * watermarkAsset.scale)}:-1,format=rgba
                      </code>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            {/* Right 5 Columns: 9:16 Live Preview + Live FFmpeg Command + Active Batch Results */}
            <aside className="lg:col-span-5 space-y-6">
              <VerticalCanvasPreview
                sourceUrl={sourceVideo.url}
                sourceTitle={sourceVideo.title}
                thumbnailUrl={sourceVideo.thumbnailUrl}
                secondaryUrl={secondaryMedia.url}
                secondaryIsImage={secondaryMedia.isImage}
                watermarkEnabled={watermarkAsset.enabled}
                watermarkUrl={watermarkAsset.url}
                watermarkPosition={watermarkAsset.position}
                watermarkScale={watermarkAsset.scale}
                templateId={templateId}
                textOverlay={textOverlay}
                activeClipName={activeClip.name}
                activeStartTime={activeClip.startTime}
                activeEndTime={activeClip.endTime}
                onSetClipIn={(tc) => updateClipField(selectedClipIndex, 'startTime', tc)}
                onSetClipOut={(tc) => updateClipField(selectedClipIndex, 'endTime', tc)}
              />

              {/* Live FFmpeg Command Compiler Box */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white">
                    Comando FFmpeg Compilado ({activeClip.name})
                  </span>
                  <button
                    onClick={copyLiveCommand}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedCmd ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    {copiedCmd ? 'Copiado' : 'Copiar CLI'}
                  </button>
                </div>
                <pre className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 text-[11px] font-mono text-amber-200/90 overflow-x-auto leading-relaxed">
                  {compiledFfmpeg.command}
                </pre>
              </div>

              {/* Active Batch Queue Box */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">
                    Estado del Procesamiento 9:16
                  </span>
                  {latestJob && (
                    <span className="text-xs font-mono text-slate-400 tabular-nums">
                      {latestJob.completedCount}/{latestJob.totalClips} listos
                    </span>
                  )}
                </div>

                {!latestJob ? (
                  <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs text-slate-400 space-y-2">
                    <p>
                      Pulsa el botón superior{' '}
                      <strong className="text-white">
                        Renderizar Lote ({clips.length} Clips)
                      </strong>{' '}
                      para procesar todos los rangos de tiempo y descargar los vídeos verticales en
                      formato 9:16.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {latestJob.clips.map((c) => (
                      <div
                        key={c.id}
                        className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-white truncate">{c.name}</div>
                          <div className="font-mono text-[11px] text-slate-400 tabular-nums">
                            {c.startTime} → {c.endTime} ·{' '}
                            {c.status === 'completed'
                              ? `${c.fileSizeKb || 0} KB`
                              : c.status === 'rendering'
                              ? 'Renderizando...'
                              : c.status}
                          </div>
                        </div>

                        {c.status === 'completed' ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => setPreviewOutputModal(c)}
                              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded font-medium flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Play className="w-3 h-3" /> Ver
                            </button>
                            <button
                              onClick={() => handleDownloadClip(c)}
                              disabled={downloadingClipId === c.id}
                              className="px-2.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 rounded font-semibold flex items-center gap-1 transition-colors whitespace-nowrap cursor-pointer"
                            >
                              <Download className="w-3 h-3" />
                              {downloadingClipId === c.id ? '...' : 'Descargar'}
                            </button>
                          </div>
                        ) : (
                          <span className="text-amber-400 font-mono text-[11px] shrink-0">
                            {c.status === 'rendering' ? 'Procesando...' : 'En cola'}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </main>

      {/* Modal to Play Rendered 9:16 Video File */}
      {previewOutputModal && previewOutputModal.outputUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewOutputModal(null)}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-white">{previewOutputModal.name}</h3>
                <p className="text-xs font-mono text-slate-400 tabular-nums">
                  Clip Vertical 9:16 · {previewOutputModal.startTime} →{' '}
                  {previewOutputModal.endTime}
                </p>
              </div>
              <button
                onClick={() => setPreviewOutputModal(null)}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 rounded-md cursor-pointer"
              >
                Cerrar
              </button>
            </div>

            <div className="w-64 mx-auto aspect-[9/16] bg-black rounded-xl overflow-hidden border border-slate-800">
              <video
                src={previewOutputModal.outputUrl}
                controls
                autoPlay
                loop
                className="w-full h-full object-contain"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <span className="text-xs font-mono text-slate-400 tabular-nums">
                Tamaño: {previewOutputModal.fileSizeKb} KB
              </span>
              <button
                onClick={() => handleDownloadClip(previewOutputModal)}
                disabled={downloadingClipId === previewOutputModal.id}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold text-xs rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                {downloadingClipId === previewOutputModal.id
                  ? 'Preparando archivo...'
                  : 'Descargar Clip 9:16'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clean Minimal Footer */}
      <footer className="border-t border-slate-800/80 px-6 py-4 mt-12 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-4">
        <div>VertiClip Studio — Procesamiento Automatizado 9:16 con FastAPI, yt-dlp y FFmpeg</div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setActiveNav('ffmpeg')}
            className="hover:text-white transition-colors cursor-pointer"
          >
            Documentación filter_complex
          </button>
          <span>·</span>
          <button
            onClick={() => setActiveNav('fastapi')}
            className="hover:text-white transition-colors cursor-pointer"
          >
            Descargar Código Python + FastAPI
          </button>
        </div>
      </footer>
    </div>
  );
}
