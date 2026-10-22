import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, RotateCcw, Scissors } from 'lucide-react';
import {
  TemplateId,
  TextOverlayState,
  WatermarkPosition,
  formatSecondsToTimecode,
  parseTimecodeToSeconds,
} from '../utils/ffmpegCompiler';
import {
  BUILTIN_WATERMARK_DATA_URL,
  drawSyntheticFrame16x9,
  drawSyntheticSecondaryLoop,
} from '../utils/clientVideoRenderer';

interface VerticalCanvasPreviewProps {
  sourceUrl: string;
  sourceTitle?: string;
  thumbnailUrl?: string | null;
  secondaryUrl: string;
  secondaryIsImage: boolean;
  watermarkEnabled: boolean;
  watermarkUrl: string;
  watermarkPosition: WatermarkPosition;
  watermarkScale: number;
  templateId: TemplateId;
  textOverlay: TextOverlayState;
  activeClipName: string;
  activeStartTime: string;
  activeEndTime: string;
  onSetClipIn: (timecode: string) => void;
  onSetClipOut: (timecode: string) => void;
}

export const VerticalCanvasPreview: React.FC<VerticalCanvasPreviewProps> = ({
  sourceUrl,
  sourceTitle = 'STUDIO MASTER 16:9',
  thumbnailUrl = null,
  secondaryUrl,
  secondaryIsImage,
  watermarkEnabled,
  watermarkUrl,
  watermarkPosition,
  watermarkScale,
  templateId,
  textOverlay,
  activeClipName,
  activeStartTime,
  activeEndTime,
  onSetClipIn,
  onSetClipOut,
}) => {
  const mainVideoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const secVideoRef = useRef<HTMLVideoElement | null>(null);

  const synthMainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const synthBgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const synthSecCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumbImageRef = useRef<HTMLImageElement | null>(null);

  const [useSyntheticSource, setUseSyntheticSource] = useState(
    sourceUrl.startsWith('builtin:')
  );
  const [useSyntheticSecondary, setUseSyntheticSecondary] = useState(
    secondaryUrl.startsWith('builtin:')
  );
  const [resolvedWatermarkUrl, setResolvedWatermarkUrl] = useState(
    watermarkUrl.startsWith('builtin:') ? BUILTIN_WATERMARK_DATA_URL : watermarkUrl
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(2);
  const [duration, setDuration] = useState(45);

  useEffect(() => {
    if (!thumbnailUrl) {
      thumbImageRef.current = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      thumbImageRef.current = img;
    };
    img.src = thumbnailUrl;
  }, [thumbnailUrl]);

  useEffect(() => {
    setUseSyntheticSource(sourceUrl.startsWith('builtin:'));
    setIsPlaying(false);
    setCurrentTime(parseTimecodeToSeconds(activeStartTime) || 2);
  }, [sourceUrl]);

  useEffect(() => {
    setUseSyntheticSecondary(secondaryUrl.startsWith('builtin:'));
  }, [secondaryUrl]);

  useEffect(() => {
    setResolvedWatermarkUrl(
      watermarkUrl.startsWith('builtin:') ? BUILTIN_WATERMARK_DATA_URL : watermarkUrl
    );
  }, [watermarkUrl]);

  // Animate synthetic broadcast canvas when in serverless/Vercel mode or playing
  useEffect(() => {
    let rafId: number;
    let lastTs = performance.now();

    const renderLoop = (now: number) => {
      const dt = (now - lastTs) / 1000;
      lastTs = now;

      if (useSyntheticSource && isPlaying) {
        setCurrentTime((prev) => {
          const next = prev + dt;
          return next >= duration ? 0 : next;
        });
      }

      if (useSyntheticSource) {
        if (synthMainCanvasRef.current) {
          const ctx = synthMainCanvasRef.current.getContext('2d');
          if (ctx) {
            drawSyntheticFrame16x9(ctx, 480, 270, currentTime, sourceTitle, thumbImageRef.current);
          }
        }
        if (synthBgCanvasRef.current) {
          const ctx = synthBgCanvasRef.current.getContext('2d');
          if (ctx) {
            drawSyntheticFrame16x9(ctx, 320, 180, currentTime, sourceTitle, thumbImageRef.current);
          }
        }
      }

      if (useSyntheticSecondary && synthSecCanvasRef.current) {
        const ctx = synthSecCanvasRef.current.getContext('2d');
        if (ctx) {
          drawSyntheticSecondaryLoop(ctx, 360, 320, currentTime);
        }
      }

      if (isPlaying) {
        rafId = requestAnimationFrame(renderLoop);
      }
    };

    renderLoop(performance.now());
    if (isPlaying) {
      rafId = requestAnimationFrame(renderLoop);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [useSyntheticSource, useSyntheticSecondary, isPlaying, currentTime, duration, sourceTitle, templateId]);

  const togglePlay = () => {
    if (useSyntheticSource) {
      setIsPlaying((prev) => !prev);
      return;
    }

    const main = mainVideoRef.current;
    if (!main) {
      setUseSyntheticSource(true);
      setIsPlaying((prev) => !prev);
      return;
    }
    if (main.paused) {
      main.play().catch(() => {
        setUseSyntheticSource(true);
      });
      bgVideoRef.current?.play().catch(() => {});
      secVideoRef.current?.play().catch(() => {});
      setIsPlaying(true);
    } else {
      main.pause();
      bgVideoRef.current?.pause();
      secVideoRef.current?.pause();
      setIsPlaying(false);
    }
  };

  const seekTo = (seconds: number) => {
    setCurrentTime(seconds);
    if (!useSyntheticSource && mainVideoRef.current) {
      mainVideoRef.current.currentTime = seconds;
      if (bgVideoRef.current) {
        bgVideoRef.current.currentTime = seconds;
      }
    }
  };

  const jumpToActiveRange = () => {
    const startSec = parseTimecodeToSeconds(activeStartTime);
    seekTo(startSec);
  };

  const handleTimeUpdate = () => {
    const main = mainVideoRef.current;
    if (!main) return;
    setCurrentTime(main.currentTime);
    if (bgVideoRef.current && Math.abs(bgVideoRef.current.currentTime - main.currentTime) > 0.25) {
      bgVideoRef.current.currentTime = main.currentTime;
    }
  };

  const wmPositionClass: Record<WatermarkPosition, string> = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    center: 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4',
  };

  const textPositionClass =
    textOverlay.position === 'top'
      ? 'top-[10%]'
      : textOverlay.position === 'center'
      ? 'top-1/2 -translate-y-1/2'
      : 'bottom-[12%]';

  const fontClass =
    textOverlay.fontFamily === 'mono'
      ? 'font-mono'
      : textOverlay.fontFamily === 'condensed'
      ? 'tracking-tight font-bold'
      : 'font-sans font-bold';

  const scaledFontSize = Math.max(11, Math.min(28, Math.round(textOverlay.fontSize * 0.26)));

  const hexToRgba = (hex: string, alpha: number) => {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.slice(0, 2) || '00', 16);
    const g = parseInt(clean.slice(2, 4) || '00', 16);
    const b = parseInt(clean.slice(4, 6) || '00', 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col items-center space-y-4">
      <div className="w-full flex items-center justify-between text-xs">
        <span className="font-semibold text-white">Previsualizador de Plantilla 9:16</span>
        <span className="text-slate-400 font-mono tabular-nums">
          1080 × 1920 · {activeClipName}
        </span>
      </div>

      {/* 9:16 Vertical Stage */}
      <div className="w-[270px] sm:w-[288px] aspect-[9/16] bg-slate-950 border border-slate-700 rounded-2xl relative overflow-hidden shadow-inner select-none">
        {/* Plantilla 1: Blurred 9:16 Background */}
        {templateId === 'blur_bg' &&
          (useSyntheticSource ? (
            <canvas
              ref={synthBgCanvasRef}
              width={320}
              height={180}
              className="absolute inset-0 w-full h-full object-cover scale-125 blur-xl brightness-75 pointer-events-none"
            />
          ) : (
            <video
              ref={bgVideoRef}
              src={sourceUrl}
              muted
              playsInline
              loop
              onError={() => setUseSyntheticSource(true)}
              className="absolute inset-0 w-full h-full object-cover scale-110 blur-xl brightness-75 pointer-events-none"
            />
          ))}

        {/* Main Video Layer - Plantilla 1 */}
        {templateId === 'blur_bg' && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            {useSyntheticSource ? (
              <canvas
                ref={synthMainCanvasRef}
                width={480}
                height={270}
                className="w-full aspect-video object-contain shadow-lg border-y border-white/10 bg-black"
              />
            ) : (
              <video
                ref={mainVideoRef}
                src={sourceUrl}
                playsInline
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 45)}
                onEnded={() => setIsPlaying(false)}
                onError={() => setUseSyntheticSource(true)}
                className="w-full aspect-video object-contain shadow-lg border-y border-white/10 bg-black"
              />
            )}
          </div>
        )}

        {/* Main + Secondary Layer - Plantilla 2 (Split Screen) */}
        {templateId === 'split_screen' && (
          <div className="absolute inset-0 flex flex-col z-10">
            <div className="w-full h-1/2 overflow-hidden border-b border-slate-800 bg-black">
              {useSyntheticSource ? (
                <canvas
                  ref={synthMainCanvasRef}
                  width={480}
                  height={270}
                  className="w-full h-full object-cover"
                />
              ) : (
                <video
                  ref={mainVideoRef}
                  src={sourceUrl}
                  playsInline
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 45)}
                  onEnded={() => setIsPlaying(false)}
                  onError={() => setUseSyntheticSource(true)}
                  className="w-full h-full object-cover"
                />
              )}
            </div>
            <div className="w-full h-1/2 overflow-hidden bg-slate-950">
              {useSyntheticSecondary ? (
                <canvas
                  ref={synthSecCanvasRef}
                  width={360}
                  height={320}
                  className="w-full h-full object-cover"
                />
              ) : secondaryIsImage ? (
                <img
                  src={secondaryUrl}
                  alt="Media secundario inferior"
                  referrerPolicy="no-referrer"
                  onError={() => setUseSyntheticSecondary(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <video
                  ref={secVideoRef}
                  src={secondaryUrl}
                  muted
                  loop
                  playsInline
                  onError={() => setUseSyntheticSecondary(true)}
                  className="w-full h-full object-cover"
                />
              )}
            </div>
          </div>
        )}

        {/* Main Layer - Plantilla 3 (Full Crop) */}
        {templateId === 'full_crop' && (
          <div className="absolute inset-0 z-10">
            {useSyntheticSource ? (
              <canvas
                ref={synthMainCanvasRef}
                width={480}
                height={270}
                className="w-full h-full object-cover"
              />
            ) : (
              <video
                ref={mainVideoRef}
                src={sourceUrl}
                playsInline
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 45)}
                onEnded={() => setIsPlaying(false)}
                onError={() => setUseSyntheticSource(true)}
                className="w-full h-full object-cover"
              />
            )}
          </div>
        )}

        {/* Watermark PNG Overlay */}
        {watermarkEnabled && resolvedWatermarkUrl && (
          <div
            className={`absolute z-20 pointer-events-none ${wmPositionClass[watermarkPosition]}`}
            style={{ width: `${Math.round(watermarkScale * 100)}%` }}
          >
            <img
              src={resolvedWatermarkUrl}
              alt="Marca de agua superpuesta"
              referrerPolicy="no-referrer"
              onError={() => setResolvedWatermarkUrl(BUILTIN_WATERMARK_DATA_URL)}
              className="w-full h-auto object-contain"
            />
          </div>
        )}

        {/* Text Hook Overlay */}
        {textOverlay.enabled && textOverlay.text.trim() && (
          <div
            className={`absolute left-3 right-3 z-30 flex justify-center pointer-events-none ${textPositionClass}`}
          >
            <div
              className={`px-2.5 py-1.5 rounded text-center leading-snug break-words max-w-full ${fontClass}`}
              style={{
                fontSize: `${scaledFontSize}px`,
                color: textOverlay.fontColor,
                backgroundColor: textOverlay.boxEnabled
                  ? hexToRgba(textOverlay.boxColor, textOverlay.boxOpacity)
                  : 'transparent',
                WebkitTextStroke:
                  textOverlay.borderW > 0
                    ? `${Math.max(0.5, textOverlay.borderW * 0.25)}px ${textOverlay.borderColor}`
                    : undefined,
              }}
            >
              {textOverlay.text}
            </div>
          </div>
        )}

        {/* Safe Zone Guides Overlay */}
        <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/60 to-transparent z-10 pointer-events-none flex items-end justify-between px-3 pb-2 text-[10px] font-mono text-slate-300/80">
          <span>
            {templateId === 'blur_bg'
              ? 'Plantilla 1 · Blur'
              : templateId === 'split_screen'
              ? 'Plantilla 2 · Split'
              : 'Plantilla 3 · Crop'}
          </span>
          <span className="tabular-nums">{formatSecondsToTimecode(currentTime)}</span>
        </div>
      </div>

      {/* Scrubber & Playhead Controls */}
      <div className="w-full space-y-2.5 pt-1">
        <div className="flex items-center gap-2">
          <button
            onClick={togglePlay}
            className="p-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg transition-colors shrink-0 cursor-pointer"
            title={isPlaying ? 'Pausar' : 'Reproducir'}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={jumpToActiveRange}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors shrink-0 cursor-pointer"
            title="Ir al inicio del clip seleccionado"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(1, duration)}
            step={0.1}
            value={currentTime}
            onChange={(e) => seekTo(parseFloat(e.target.value))}
            className="w-full accent-amber-500 cursor-pointer"
          />
          <span className="text-xs font-mono text-slate-300 tabular-nums shrink-0">
            {formatSecondsToTimecode(currentTime)} / {formatSecondsToTimecode(duration)}
          </span>
        </div>

        {/* Quick In/Out Markers for Active Clip */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onSetClipIn(formatSecondsToTimecode(currentTime))}
            className="px-3 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs text-slate-300 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Scissors className="w-3.5 h-3.5 text-amber-400" />
            Marcar Inicio ({activeStartTime})
          </button>
          <button
            onClick={() => onSetClipOut(formatSecondsToTimecode(currentTime))}
            className="px-3 py-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs text-slate-300 flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Scissors className="w-3.5 h-3.5 text-amber-400" />
            Marcar Fin ({activeEndTime})
          </button>
        </div>
      </div>
    </div>
  );
};
