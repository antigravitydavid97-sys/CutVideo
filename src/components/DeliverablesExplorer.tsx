import React, { useEffect, useState } from 'react';
import { Copy, Check, Download, FolderTree, Terminal, FileCode } from 'lucide-react';

interface PythonFilesResponse {
  requirements: string;
  ffmpegEngine: string;
  mainPy: string;
  indexHtml: string;
}

const PROJECT_TREE = `verticlip_fastapi_project/
├── requirements.txt                  # Dependencias Python (FastAPI, Uvicorn, yt-dlp, Jinja2)
├── app/
│   ├── __init__.py
│   ├── main.py                       # Servidor FastAPI, endpoints de ingesta, BackgroundTasks y descarga
│   ├── ffmpeg_engine.py              # Constructor modular de grafos filter_complex y ejecución subprocess
│   └── templates/
│       └── index.html                # Interfaz web oscura con previsualización 9:16 y gestión por lotes
└── storage/
    ├── uploads/                      # Vídeos maestros 16:9 descargados con yt-dlp o subidos en local
    ├── assets/                       # Vídeos/imágenes secundarias (Split Screen) y logos PNG (Watermarks)
    └── outputs/                      # Clips finales renderizados en 1080x1920 (H.264 + AAC)`;

const TEMPLATE_1_COMMAND = `ffmpeg -y \\
  -ss 00:01:15 -to 00:01:45 \\
  -i "storage/uploads/source_16x9.mp4" \\
  -i "storage/assets/watermark_logo.png" \\
  -filter_complex " \\
    [0:v]split=2[bg_src][fg_src]; \\
    [bg_src]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:5,eq=brightness=-0.12,setsar=1[bg_blur]; \\
    [fg_src]scale=1080:-2:force_original_aspect_ratio=decrease,setsar=1[fg_scaled]; \\
    [bg_blur][fg_scaled]overlay=(W-w)/2:(H-h)/2:shortest=1[base_v]; \\
    [1:v]scale=216:-1,format=rgba[wm_scaled]; \\
    [base_v][wm_scaled]overlay=x=W-w-48:y=48:format=auto[v_wm]; \\
    [v_wm]drawtext=fontfile='/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf':text='EL SECRETO QUE NADIE TE CUENTA':fontsize=56:fontcolor=0xffffff:x=(w-text_w)/2:y=190:borderw=3:bordercolor=0x000000:box=1:boxcolor=0x000000@0.75:boxborderw=18[v_out] \\
  " \\
  -map "[v_out]" -map "0:a?" \\
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \\
  -c:a aac -b:a 192k -movflags +faststart \\
  "storage/outputs/clip_01_blur_9x16.mp4"`;

const TEMPLATE_2_COMMAND = `ffmpeg -y \\
  -ss 00:01:15 -to 00:01:45 \\
  -i "storage/uploads/source_16x9.mp4" \\
  -stream_loop -1 -i "storage/assets/secondary_loop.mp4" \\
  -i "storage/assets/watermark_logo.png" \\
  -filter_complex " \\
    [0:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[top_v]; \\
    [1:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[bot_v]; \\
    [top_v][bot_v]vstack=inputs=2:shortest=1[base_v]; \\
    [2:v]scale=216:-1,format=rgba[wm_scaled]; \\
    [base_v][wm_scaled]overlay=x=W-w-48:y=48:shortest=1:format=auto[v_wm]; \\
    [v_wm]drawtext=fontfile='/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf':text='MIRA HASTA EL FINAL':fontsize=56:fontcolor=0xffffff:x=(w-text_w)/2:y=(h-text_h)/2:borderw=3:bordercolor=0x000000:box=1:boxcolor=0xf59e0b@0.90:boxborderw=18[v_out] \\
  " \\
  -map "[v_out]" -map "0:a?" \\
  -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \\
  -c:a aac -b:a 192k -movflags +faststart \\
  "storage/outputs/clip_02_split_9x16.mp4"`;

interface DeliverablesExplorerProps {
  activeSection: 'ffmpeg' | 'fastapi';
}

export const DeliverablesExplorer: React.FC<DeliverablesExplorerProps> = ({ activeSection }) => {
  const [pyFiles, setPyFiles] = useState<PythonFilesResponse>({
    requirements: '',
    ffmpegEngine: '',
    mainPy: '',
    indexHtml: '',
  });
  const [selectedFileTab, setSelectedFileTab] = useState<'mainPy' | 'ffmpegEngine' | 'indexHtml' | 'requirements'>('ffmpegEngine');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/python-project/files')
      .then((r) => r.json())
      .then((data) => setPyFiles(data))
      .catch(() => {});
  }, []);

  const copyText = (key: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const downloadTextFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (activeSection === 'ffmpeg') {
    return (
      <div className="space-y-8">
        <div className="border-b border-slate-800 pb-5">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Arquitectura de Grafos FFmpeg (filter_complex)
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-3xl">
            Especificación técnica de los filtros compuestos en 1080×1920 para reencuadre vertical,
            superposición de capas gráficas y recorte exacto con sincronización de audio original.
          </p>
        </div>

        {/* Plantilla 1 Explanation */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">
                01. Plantilla 1: Fondo Blur 9:16 + Vídeo 16:9 Centrado + Overlays
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Divide el flujo de entrada en dos ramas con <code className="text-amber-300">split=2</code> sin decodificar dos veces el archivo fuente.
              </p>
            </div>
            <button
              onClick={() => copyText('tpl1', TEMPLATE_1_COMMAND)}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedKey === 'tpl1' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedKey === 'tpl1' ? 'Comando Copiado' : 'Copiar Comando FFmpeg'}
            </button>
          </div>

          <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-amber-200/95 overflow-x-auto leading-relaxed">
            {TEMPLATE_1_COMMAND}
          </pre>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 text-xs">
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-1.5">
              <div className="font-semibold text-white">Recorte y Sincronización A/V</div>
              <p className="text-slate-400 leading-relaxed">
                Al situar <code className="text-slate-200">-ss</code> y <code className="text-slate-200">-to</code> antes de <code className="text-slate-200">-i</code> junto con re-codificación (<code className="text-slate-200">libx264</code> + <code className="text-slate-200">aac</code>), FFmpeg realiza frame-accurate seeking manteniendo los timestamps de audio (<code className="text-slate-200">0:a?</code>) perfectamente alineados con el vídeo.
              </p>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-1.5">
              <div className="font-semibold text-white">Lienzo Desenfocado y Oscurecido</div>
              <p className="text-slate-400 leading-relaxed">
                La rama <code className="text-slate-200">[bg_src]</code> se escala con <code className="text-slate-200">force_original_aspect_ratio=increase</code> y se recorta a <code className="text-slate-200">1080:1920</code>, aplicando <code className="text-slate-200">boxblur=25:5</code> y <code className="text-slate-200">eq=brightness=-0.12</code> para que el clip frontal resalte.
              </p>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-1.5">
              <div className="font-semibold text-white">Capas PNG + Hook drawtext</div>
              <p className="text-slate-400 leading-relaxed">
                El logo PNG se convierte a <code className="text-slate-200">format=rgba</code> preservando el canal alfa y se superpone antes de estampar el texto gancho con caja semitransparente (<code className="text-slate-200">box=1:boxcolor=0x000000@0.75</code>).
              </p>
            </div>
          </div>
        </div>

        {/* Plantilla 2 Explanation */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">
                02. Plantilla 2: Split Screen (1080×960 + 1080×960 Apilado Vertical) + Overlays
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Combina el clip principal en la mitad superior y un loop infinito (<code className="text-amber-300">-stream_loop -1</code>) o imagen estática (<code className="text-amber-300">-loop 1</code>) en la mitad inferior mediante <code className="text-amber-300">vstack=inputs=2:shortest=1</code>.
              </p>
            </div>
            <button
              onClick={() => copyText('tpl2', TEMPLATE_2_COMMAND)}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedKey === 'tpl2' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedKey === 'tpl2' ? 'Comando Copiado' : 'Copiar Comando FFmpeg'}
            </button>
          </div>

          <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-amber-200/95 overflow-x-auto leading-relaxed">
            {TEMPLATE_2_COMMAND}
          </pre>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 text-xs">
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-1.5">
              <div className="font-semibold text-white">Geometría Exacta 1080×960</div>
              <p className="text-slate-400 leading-relaxed">
                Cada mitad se escala y recorta al centro a exactamente <code className="text-slate-200">1080×960</code> píxeles con <code className="text-slate-200">setsar=1</code> para evitar errores de Sample Aspect Ratio al unir con <code className="text-slate-200">vstack</code>.
              </p>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-1.5">
              <div className="font-semibold text-white">Bucle Infinito Controlado</div>
              <p className="text-slate-200 font-mono text-[11px]">-stream_loop -1 + shortest=1</p>
              <p className="text-slate-400 leading-relaxed">
                Si el vídeo secundario es más corto que el clip extraído, se repite sin cortes hasta que termina la ventana <code className="text-slate-200">-ss / -to</code> del vídeo principal.
              </p>
            </div>
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-1.5">
              <div className="font-semibold text-white">Aislamiento de Audio Principal</div>
              <p className="text-slate-400 leading-relaxed">
                Con <code className="text-slate-200">-map &quot;[v_out]&quot; -map &quot;0:a?&quot;</code> garantizamos que únicamente se exporte la pista de audio del vídeo principal (<code className="text-slate-200">input 0</code>), ignorando cualquier ruido del vídeo secundario.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const fileMetadata: Record<
    'ffmpegEngine' | 'mainPy' | 'indexHtml' | 'requirements',
    { title: string; filename: string; pathLabel: string; content: string }
  > = {
    ffmpegEngine: {
      title: 'Motor FFmpeg (app/ffmpeg_engine.py)',
      filename: 'ffmpeg_engine.py',
      pathLabel: 'python_fastapi_project/app/ffmpeg_engine.py',
      content: pyFiles.ffmpegEngine,
    },
    mainPy: {
      title: 'Backend FastAPI (app/main.py)',
      filename: 'main.py',
      pathLabel: 'python_fastapi_project/app/main.py',
      content: pyFiles.mainPy,
    },
    indexHtml: {
      title: 'Frontend HTML5 + JS (app/templates/index.html)',
      filename: 'index.html',
      pathLabel: 'python_fastapi_project/app/templates/index.html',
      content: pyFiles.indexHtml,
    },
    requirements: {
      title: 'Dependencias (requirements.txt)',
      filename: 'requirements.txt',
      pathLabel: 'python_fastapi_project/requirements.txt',
      content: pyFiles.requirements,
    },
  };

  const activeFile = fileMetadata[selectedFileTab];

  return (
    <div className="space-y-8">
      <div className="border-b border-slate-800 pb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Entregables del Proyecto Python + FastAPI + FFmpeg
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-3xl">
            Estructura completa de carpetas, <code className="text-slate-200">requirements.txt</code>, motor modular de filtros <code className="text-slate-200">ffmpeg_engine.py</code>, API asíncrona <code className="text-slate-200">main.py</code> y plantilla <code className="text-slate-200">index.html</code> listos para ejecución local.
          </p>
        </div>
      </div>

      {/* Folder Tree */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <FolderTree className="w-4 h-4 text-amber-400" />
            <h2 className="text-base font-semibold text-white">01. Estructura de Carpetas y Ejecución Local</h2>
          </div>
          <button
            onClick={() => copyText('tree', PROJECT_TREE)}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            {copiedKey === 'tree' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedKey === 'tree' ? 'Copiado' : 'Copiar Estructura'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <pre className="lg:col-span-7 bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
            {PROJECT_TREE}
          </pre>
          <div className="lg:col-span-5 bg-slate-950 border border-slate-800 rounded-lg p-4 flex flex-col justify-between space-y-3">
            <div className="space-y-2">
              <div className="text-xs font-semibold text-white flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-amber-400" /> Comandos de Puesta en Marcha Local
              </div>
              <pre className="text-xs font-mono text-amber-200/90 bg-slate-900 p-3 rounded border border-slate-800 overflow-x-auto leading-relaxed">
{`# 1. Crear entorno virtual e instalar paquetes
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 2. Iniciar servidor FastAPI con recarga activa
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload`}
              </pre>
            </div>
            <p className="text-xs text-slate-400">
              Todos estos archivos ya han sido generados físicamente en el directorio <code className="text-slate-200">/python_fastapi_project/</code> de este entorno y puedes copiarlos o descargarlos a continuación.
            </p>
          </div>
        </div>
      </div>

      {/* Source Code Inspector */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
            {(
              [
                ['ffmpegEngine', 'app/ffmpeg_engine.py'],
                ['mainPy', 'app/main.py'],
                ['indexHtml', 'app/templates/index.html'],
                ['requirements', 'requirements.txt'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSelectedFileTab(key)}
                className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  selectedFileTab === key
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => copyText(selectedFileTab, activeFile.content)}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedKey === selectedFileTab ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copiedKey === selectedFileTab ? 'Código Copiado' : 'Copiar Archivo'}
            </button>
            <button
              onClick={() => downloadTextFile(activeFile.filename, activeFile.content)}
              className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Descargar {activeFile.filename}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-slate-400 px-1">
          <span className="flex items-center gap-2 font-mono">
            <FileCode className="w-3.5 h-3.5 text-amber-400" />
            {activeFile.pathLabel}
          </span>
          <span className="font-mono tabular-nums">
            {activeFile.content.split('\n').length} líneas
          </span>
        </div>

        <pre className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono text-slate-200 overflow-x-auto max-h-[600px] leading-relaxed">
          {activeFile.content || 'Cargando archivo...'}
        </pre>
      </div>
    </div>
  );
};
