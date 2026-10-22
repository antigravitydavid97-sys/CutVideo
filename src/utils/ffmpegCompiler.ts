export type TemplateId = 'blur_bg' | 'split_screen' | 'full_crop';
export type TextPosition = 'top' | 'center' | 'bottom';
export type WatermarkPosition = 'top-left' | 'top-right' | 'center' | 'bottom-left' | 'bottom-right';

export interface TextOverlayState {
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
  position: TextPosition;
}

export interface ClipItem {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
}

export function parseTimecodeToSeconds(tc: string): number {
  const parts = tc.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] || 0;
}

export function formatSecondsToTimecode(sec: number): string {
  const clamped = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  return [hrs, mins, secs].map((n) => String(n).padStart(2, '0')).join(':');
}

export function buildClientFfmpegCommand(params: {
  sourceFilename: string;
  clip: ClipItem;
  templateId: TemplateId;
  secondaryFilename: string | null;
  watermarkEnabled: boolean;
  watermarkFilename: string | null;
  watermarkPosition: WatermarkPosition;
  watermarkScale: number;
  textOverlay: TextOverlayState;
}): { command: string; filterComplex: string } {
  const {
    sourceFilename,
    clip,
    templateId,
    secondaryFilename,
    watermarkEnabled,
    watermarkFilename,
    watermarkPosition,
    watermarkScale,
    textOverlay,
  } = params;

  const inputs: string[] = [
    `-ss ${clip.startTime}`,
    `-to ${clip.endTime}`,
    `-i "uploads/${sourceFilename || 'input_16x9.mp4'}"`,
  ];

  let inputIdx = 1;
  let secIdx: number | null = null;
  let wmIdx: number | null = null;

  if (templateId === 'split_screen' && secondaryFilename) {
    const isImage = /\.(png|jpg|jpeg|webp)$/i.test(secondaryFilename);
    inputs.push(
      isImage
        ? `-loop 1 -i "assets/${secondaryFilename}"`
        : `-stream_loop -1 -i "assets/${secondaryFilename}"`
    );
    secIdx = inputIdx++;
  }

  if (watermarkEnabled && watermarkFilename) {
    inputs.push(`-i "assets/${watermarkFilename}"`);
    wmIdx = inputIdx++;
  }

  const chains: string[] = [];
  let currentLabel = '[base_v]';

  if (templateId === 'blur_bg') {
    chains.push(
      `[0:v]split=2[bg_src][fg_src]`,
      `[bg_src]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5,eq=brightness=-0.12,setsar=1[bg_blur]`,
      `[fg_src]scale=1080:-2:force_original_aspect_ratio=decrease,setsar=1[fg_scaled]`,
      `[bg_blur][fg_scaled]overlay=(W-w)/2:(H-h)/2:shortest=1${currentLabel}`
    );
  } else if (templateId === 'split_screen') {
    if (secIdx !== null) {
      chains.push(
        `[0:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[top_v]`,
        `[${secIdx}:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[bot_v]`,
        `[top_v][bot_v]vstack=inputs=2:shortest=1${currentLabel}`
      );
    } else {
      chains.push(
        `[0:v]split=2[top_src][bot_src]`,
        `[top_src]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[top_v]`,
        `[bot_src]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,boxblur=16:3,setsar=1[bot_v]`,
        `[top_v][bot_v]vstack=inputs=2${currentLabel}`
      );
    }
  } else {
    chains.push(
      `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1${currentLabel}`
    );
  }

  if (wmIdx !== null) {
    const wmWidth = Math.round(1080 * watermarkScale);
    const posMap: Record<WatermarkPosition, string> = {
      'top-left': 'x=48:y=48',
      'top-right': 'x=W-w-48:y=48',
      center: 'x=(W-w)/2:y=(H-h)/2',
      'bottom-left': 'x=48:y=H-h-48',
      'bottom-right': 'x=W-w-48:y=H-h-48',
    };
    const nextLabel = '[v_wm]';
    chains.push(
      `[${wmIdx}:v]scale=${wmWidth}:-1,format=rgba[wm_scaled]`,
      `${currentLabel}[wm_scaled]overlay=${posMap[watermarkPosition]}:shortest=1:format=auto${nextLabel}`
    );
    currentLabel = nextLabel;
  }

  if (textOverlay.enabled && textOverlay.text.trim()) {
    const fontMap = {
      sans: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
      mono: '/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
      condensed: '/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf',
    };
    const posMap: Record<TextPosition, string> = {
      top: 'x=(w-text_w)/2:y=190',
      center: 'x=(w-text_w)/2:y=(h-text_h)/2',
      bottom: 'x=(w-text_w)/2:y=h-text_h-240',
    };
    const safeText = textOverlay.text.trim().replace(/'/g, "\\'").replace(/:/g, '\\:');
    const nextLabel = '[v_out]';
    chains.push(
      `${currentLabel}drawtext=fontfile='${fontMap[textOverlay.fontFamily]}':text='${safeText}':fontsize=${textOverlay.fontSize}:fontcolor=${textOverlay.fontColor}:${posMap[textOverlay.position]}:borderw=${textOverlay.borderW}:bordercolor=${textOverlay.borderColor}:box=${textOverlay.boxEnabled ? 1 : 0}:boxcolor=${textOverlay.boxColor}@${textOverlay.boxOpacity}:boxborderw=18${nextLabel}`
    );
    currentLabel = nextLabel;
  }

  const filterComplex = chains.join(';\n  ');
  const outSafeName = `${clip.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_9x16.mp4`;

  const command = [
    `ffmpeg -y \\`,
    ...inputs.map((inp) => `  ${inp} \\`),
    `  -filter_complex "\\\n  ${filterComplex}" \\`,
    `  -map "${currentLabel}" -map "0:a?" \\`,
    `  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \\`,
    `  -c:a aac -b:a 192k -movflags +faststart \\`,
    `  "outputs/${outSafeName}"`,
  ].join('\n');

  return { command, filterComplex: chains.join('; ') };
}
