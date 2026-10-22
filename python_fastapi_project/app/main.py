import os
import re
import sys
import uuid
import shutil
import base64
import logging
import urllib.request
import json
from pathlib import Path
from typing import List, Optional, Dict, Any

# Garantiza que el paquete 'app' sea importable en cualquier entorno serverless (Vercel) o local
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse, Response
from pydantic import BaseModel, Field

from app.ffmpeg_engine import build_ffmpeg_command, run_ffmpeg_render

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("verticlip.api")

STORAGE_ROOT = Path("/tmp/verticlip_storage") if os.environ.get("VERCEL") else (BASE_DIR / "storage")
UPLOADS_DIR = STORAGE_ROOT / "uploads"
OUTPUTS_DIR = STORAGE_ROOT / "outputs"
ASSETS_DIR = STORAGE_ROOT / "assets"

for directory in (UPLOADS_DIR, OUTPUTS_DIR, ASSETS_DIR):
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

app = FastAPI(
    title="VertiClip Studio API",
    description="Motor automatizado con FastAPI, yt-dlp y FFmpeg para extracción y reencuadre vertical 9:16 (1080x1920)",
    version="1.0.0",
)

JOBS_STORE: Dict[str, Dict[str, Any]] = {}


def has_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None


def extract_youtube_id(url: str) -> Optional[str]:
    patterns = [
        r"(?:v=|\/videos\/|embed\/|youtu\.be\/|\/v\/|\/e\/|watch\?v=|&v=|shorts\/)([a-zA-Z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


class ClipRange(BaseModel):
    id: Optional[str] = None
    clip_id: Optional[str] = Field(None, description="Identificador o nombre del clip (snake_case)")
    name: Optional[str] = Field(None, description="Identificador o nombre del clip (camelCase)")
    start_time: Optional[str] = Field(None, description="Timestamp de inicio (HH:MM:SS)")
    startTime: Optional[str] = Field(None, description="Timestamp de inicio (camelCase)")
    end_time: Optional[str] = Field(None, description="Timestamp de fin (HH:MM:SS)")
    endTime: Optional[str] = Field(None, description="Timestamp de fin (camelCase)")

    def resolved_name(self, idx: int) -> str:
        return self.name or self.clip_id or f"clip_{idx + 1}"

    def resolved_start(self) -> str:
        return self.startTime or self.start_time or "00:00:00"

    def resolved_end(self) -> str:
        return self.endTime or self.end_time or "00:00:10"


class TextOverlayConfig(BaseModel):
    enabled: bool = False
    text: str = ""
    font_path: str = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
    fontFamily: Optional[str] = "sans"
    font_size: int = 56
    fontSize: Optional[int] = None
    font_color: str = "white"
    fontColor: Optional[str] = None
    box_enabled: bool = True
    boxEnabled: Optional[bool] = None
    box_color: str = "black@0.75"
    boxColor: Optional[str] = None
    boxOpacity: Optional[float] = 0.75
    border_w: int = 3
    borderW: Optional[int] = None
    border_color: str = "black"
    borderColor: Optional[str] = None
    position: str = "top"

    def to_engine_dict(self) -> Dict[str, Any]:
        font_map = {
            "sans": "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "mono": "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
            "condensed": "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf",
        }
        resolved_font = font_map.get(self.fontFamily or "sans", self.font_path)
        resolved_box_color = self.box_color
        if self.boxColor:
            clean_hex = self.boxColor.lstrip("#")
            opacity = self.boxOpacity if self.boxOpacity is not None else 0.75
            resolved_box_color = f"0x{clean_hex}@{opacity:.2f}"

        return {
            "enabled": self.enabled,
            "text": self.text,
            "font_path": resolved_font,
            "font_size": self.fontSize if self.fontSize is not None else self.font_size,
            "font_color": self.fontColor or self.font_color,
            "box_enabled": self.boxEnabled if self.boxEnabled is not None else self.box_enabled,
            "box_color": resolved_box_color,
            "border_w": self.borderW if self.borderW is not None else self.border_w,
            "border_color": self.borderColor or self.border_color,
            "position": self.position,
        }


class BatchRenderRequest(BaseModel):
    source_video_filename: Optional[str] = None
    sourceVideoFilename: Optional[str] = None
    template_id: str = "blur_bg"
    templateId: Optional[str] = None
    secondary_media_filename: Optional[str] = None
    secondaryMediaFilename: Optional[str] = None
    watermarkEnabled: bool = True
    watermark_filename: Optional[str] = None
    watermarkFilename: Optional[str] = None
    watermark_position: str = "top-right"
    watermarkPosition: Optional[str] = None
    watermark_scale: float = 0.20
    watermarkScale: Optional[float] = None
    text_overlay: Optional[TextOverlayConfig] = None
    textOverlay: Optional[TextOverlayConfig] = None
    clips: List[ClipRange]


class YouTubeIngestRequest(BaseModel):
    url: str


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    tpl_file = Path(__file__).resolve().parent / "templates" / "index.html"
    if tpl_file.exists():
        return HTMLResponse(content=tpl_file.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>VertiClip Studio FastAPI Engine</h1>")


@app.get("/api/studio/init")
async def studio_init():
    sample_exists = (UPLOADS_DIR / "studio_sample_16x9.mp4").exists()
    sec_exists = (ASSETS_DIR / "satisfying_loop_secondary.mp4").exists()
    wm_exists = (ASSETS_DIR / "verticlip_badge.png").exists()

    return {
        "hasServerFfmpeg": has_ffmpeg(),
        "defaultSource": {
            "filename": "studio_sample_16x9.mp4",
            "title": "Studio Broadcast Master (16:9 HD · 00:00:45)",
            "url": "/api/media/uploads/studio_sample_16x9.mp4" if sample_exists else "builtin:master-16x9",
            "duration": 45,
        },
        "defaultSecondary": {
            "filename": "satisfying_loop_secondary.mp4",
            "title": "Loop Visual Secundario (Mandelbrot Synth)",
            "url": "/api/media/assets/satisfying_loop_secondary.mp4" if sec_exists else "builtin:secondary-loop",
        },
        "defaultWatermark": {
            "filename": "verticlip_badge.png",
            "title": "Logo PNG Transparente (VertiClip Badge)",
            "url": "/api/media/assets/verticlip_badge.png" if wm_exists else "builtin:watermark-png",
        },
    }


@app.get("/api/media/{folder}/{filename}")
async def serve_media(folder: str, filename: str, download: int = 0):
    safe_name = Path(filename).name
    folder_map = {
        "uploads": UPLOADS_DIR,
        "assets": ASSETS_DIR,
        "outputs": OUTPUTS_DIR,
    }
    base = folder_map.get(folder)
    if not base:
        raise HTTPException(status_code=404, detail="Carpeta no válida.")
    target = base / safe_name
    if not target.exists():
        raise HTTPException(status_code=404, detail="Archivo no encontrado.")
    if download == 1:
        return FileResponse(
            path=str(target),
            media_type="video/mp4",
            filename=safe_name,
            headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
        )
    return FileResponse(path=str(target))


@app.post("/api/ingest/youtube")
async def ingest_youtube(payload: YouTubeIngestRequest):
    """
    Intenta descargar el vídeo con yt-dlp (usando formato progresivo MP4 si no hay ffmpeg).
    Si YouTube bloquea la IP del centro de datos (Vercel/Cloud), extrae metadatos reales y miniatura vía oEmbed.
    """
    raw_url = payload.url.strip()
    video_uid = uuid.uuid4().hex[:10]
    output_template = str(UPLOADS_DIR / f"yt_{video_uid}.%(ext)s")

    # Si no hay ffmpeg en el contenedor serverless, pedimos MP4 progresivo pre-mezclado (no requiere merge)
    fmt_selector = (
        "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        if has_ffmpeg()
        else "best[ext=mp4]/18/best"
    )

    ydl_opts: Dict[str, Any] = {
        "format": fmt_selector,
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "extractor_args": {"youtube": {"player_client": ["ios", "android", "web"]}},
    }
    if has_ffmpeg():
        ydl_opts["merge_output_format"] = "mp4"

    try:
        import yt_dlp

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(raw_url, download=True)
            title = info.get("title", f"Video_{video_uid}")
            duration = info.get("duration", 45)
            final_path = UPLOADS_DIR / f"yt_{video_uid}.mp4"

            if not final_path.exists():
                matches = list(UPLOADS_DIR.glob(f"yt_{video_uid}.*"))
                if matches:
                    final_path = matches[0]

            if final_path.exists():
                return {
                    "status": "ok",
                    "filename": final_path.name,
                    "title": title,
                    "duration": duration,
                    "url": f"/api/media/uploads/{final_path.name}",
                    "video_url": f"/api/media/uploads/{final_path.name}",
                    "downloadedRealVideo": True,
                }
    except Exception as exc:
        logger.warning("yt-dlp directo falló (%s), usando oEmbed/miniatura de respaldo", exc)

    # Fallback con metadatos reales de YouTube oEmbed + Miniatura HD cuando la IP datacenter requiere captcha
    yt_id = extract_youtube_id(raw_url)
    video_title = f"YouTube Video ({yt_id or raw_url[:28]})"
    author_name = "YouTube"
    thumbnail_url = f"https://i.ytimg.com/vi/{yt_id}/hqdefault.jpg" if yt_id else None

    try:
        oembed_endpoint = f"https://www.youtube.com/oembed?url={ urllib.parse.quote(raw_url) }&format=json"
        req = urllib.request.Request(oembed_endpoint, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                video_title = data.get("title") or video_title
                author_name = data.get("author_name") or author_name
                thumbnail_url = data.get("thumbnail_url") or thumbnail_url
    except Exception:
        pass

    return {
        "status": "ok",
        "filename": f"yt_{yt_id or video_uid}.mp4",
        "title": f"{video_title} ({author_name})",
        "duration": 45,
        "url": "builtin:master-16x9",
        "video_url": "builtin:master-16x9",
        "thumbnailUrl": thumbnail_url,
        "youtubeBlockedIp": True,
        "notice": "YouTube bloqueó la descarga directa desde la IP serverless (anti-bot). Se han cargado el título y miniatura del vídeo; para editar el MP4 original en la nube, súbelo en la pestaña 'Archivo Local' o ejecuta el backend en tu máquina local.",
    }


@app.post("/api/ingest/upload")
async def upload_file(
    file: UploadFile = File(...),
    asset_type: str = Form("source_video"),
):
    ext = Path(file.filename or "video.mp4").suffix.lower()
    allowed_exts = {".mp4", ".mov", ".mkv", ".webm", ".png", ".jpg", ".jpeg", ".webp"}
    if ext not in allowed_exts:
        raise HTTPException(status_code=400, detail=f"Extensión no soportada: {ext}")

    target_dir = UPLOADS_DIR if asset_type == "source_video" else ASSETS_DIR
    folder_key = "uploads" if asset_type == "source_video" else "assets"
    safe_name = f"{asset_type}_{uuid.uuid4().hex[:8]}{ext}"
    dest_path = target_dir / safe_name

    with dest_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "status": "ok",
        "assetType": asset_type,
        "asset_type": asset_type,
        "filename": safe_name,
        "originalName": file.filename,
        "original_name": file.filename,
        "url": f"/api/media/{folder_key}/{safe_name}",
    }


def process_batch_job(job_id: str, req: BatchRenderRequest):
    job = JOBS_STORE[job_id]
    job["status"] = "processing"

    src_name = req.sourceVideoFilename or req.source_video_filename or "studio_sample_16x9.mp4"
    tpl_id = req.templateId or req.template_id or "blur_bg"
    sec_name = req.secondaryMediaFilename or req.secondary_media_filename
    wm_name = req.watermarkFilename or req.watermark_filename
    wm_pos = req.watermarkPosition or req.watermark_position or "top-right"
    wm_scale = req.watermarkScale if req.watermarkScale is not None else req.watermark_scale
    txt_cfg = (req.textOverlay or req.text_overlay or TextOverlayConfig()).to_engine_dict()

    source_path = UPLOADS_DIR / src_name
    secondary_path = (ASSETS_DIR / sec_name) if sec_name else None
    watermark_path = (ASSETS_DIR / wm_name) if (req.watermarkEnabled and wm_name) else None

    for idx, clip in enumerate(req.clips):
        clip_entry = job["clips"][idx]
        clip_entry["status"] = "rendering"

        c_name = clip.resolved_name(idx)
        c_start = clip.resolved_start()
        c_end = clip.resolved_end()

        safe_slug = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in c_name)
        out_filename = f"{job_id}_{idx + 1:02d}_{safe_slug}_9x16.mp4"
        out_path = OUTPUTS_DIR / out_filename

        try:
            cmd = build_ffmpeg_command(
                input_video_path=str(source_path),
                output_video_path=str(out_path),
                start_time=c_start,
                end_time=c_end,
                template_id=tpl_id,
                secondary_media_path=str(secondary_path) if secondary_path else None,
                watermark_path=str(watermark_path) if watermark_path else None,
                watermark_position=wm_pos,
                watermark_scale=wm_scale,
                text_overlay=txt_cfg,
            )
            result = run_ffmpeg_render(cmd)
            file_size_kb = round(out_path.stat().st_size / 1024) if out_path.exists() else 0
            clip_entry["status"] = "completed"
            clip_entry["outputUrl"] = f"/api/media/outputs/{out_filename}"
            clip_entry["output_url"] = f"/api/media/outputs/{out_filename}"
            clip_entry["filename"] = out_filename
            clip_entry["fileSizeKb"] = file_size_kb
            clip_entry["ffmpegCommand"] = result["command"]
            clip_entry["ffmpeg_command"] = result["command"]
        except Exception as exc:
            clip_entry["status"] = "failed"
            clip_entry["error"] = str(exc)

        completed = sum(1 for c in job["clips"] if c["status"] == "completed")
        job["completed_count"] = completed
        job["completedCount"] = completed

    has_errors = any(c["status"] == "failed" for c in job["clips"])
    job["status"] = "completed_with_errors" if has_errors else "completed"


@app.post("/api/render/batch")
async def start_batch_render(req: BatchRenderRequest, background_tasks: BackgroundTasks):
    if not has_ffmpeg():
        raise HTTPException(
            status_code=503,
            detail="CLIENT_FALLBACK_REQUIRED: El contenedor serverless de Vercel no incluye el binario nativo /usr/bin/ffmpeg.",
        )

    src_name = req.sourceVideoFilename or req.source_video_filename or "studio_sample_16x9.mp4"
    tpl_id = req.templateId or req.template_id or "blur_bg"
    source_path = UPLOADS_DIR / src_name
    if not source_path.exists():
        raise HTTPException(
            status_code=404,
            detail="CLIENT_FALLBACK_REQUIRED: El vídeo fuente no se encuentra en el almacenamiento efímero del servidor.",
        )

    if not req.clips:
        raise HTTPException(status_code=400, detail="Debes definir al menos un rango de tiempo (clip).")

    job_id = f"job_{uuid.uuid4().hex[:8]}"
    JOBS_STORE[job_id] = {
        "jobId": job_id,
        "job_id": job_id,
        "status": "processing",
        "templateId": tpl_id,
        "template_id": tpl_id,
        "totalClips": len(req.clips),
        "total_clips": len(req.clips),
        "completedCount": 0,
        "completed_count": 0,
        "clips": [
            {
                "id": c.id or str(idx + 1),
                "name": c.resolved_name(idx),
                "clip_id": c.resolved_name(idx),
                "startTime": c.resolved_start(),
                "start_time": c.resolved_start(),
                "endTime": c.resolved_end(),
                "end_time": c.resolved_end(),
                "status": "queued",
                "outputUrl": None,
                "output_url": None,
                "filename": None,
                "ffmpegCommand": "",
                "ffmpeg_command": None,
                "error": None,
            }
            for idx, c in enumerate(req.clips)
        ],
    }

    background_tasks.add_task(process_batch_job, job_id, req)
    return JOBS_STORE[job_id]


@app.get("/api/render/status/{job_id}")
async def get_job_status(job_id: str):
    if job_id not in JOBS_STORE:
        raise HTTPException(status_code=404, detail="Trabajo de renderizado no encontrado.")
    return JOBS_STORE[job_id]


@app.get("/api/render/download/{filename}")
async def download_clip(filename: str):
    file_path = OUTPUTS_DIR / Path(filename).name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Archivo no encontrado.")
    return FileResponse(
        path=str(file_path),
        media_type="video/mp4",
        filename=file_path.name,
        headers={"Content-Disposition": f'attachment; filename="{file_path.name}"'},
    )


@app.get("/api/python-project/files")
async def get_python_project_files():
    def read_safe(rel_path: str) -> str:
        full_path = BASE_DIR / rel_path
        return full_path.read_text(encoding="utf-8") if full_path.exists() else ""

    return {
        "requirements": read_safe("requirements.txt"),
        "ffmpegEngine": read_safe("app/ffmpeg_engine.py"),
        "mainPy": read_safe("app/main.py"),
        "indexHtml": read_safe("app/templates/index.html"),
    }
