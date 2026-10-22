import os
import uuid
import shutil
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any

import yt_dlp
from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from app.ffmpeg_engine import build_ffmpeg_command, run_ffmpeg_render

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("verticlip.api")

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOADS_DIR = BASE_DIR / "storage" / "uploads"
OUTPUTS_DIR = BASE_DIR / "storage" / "outputs"
ASSETS_DIR = BASE_DIR / "storage" / "assets"

for directory in (UPLOADS_DIR, OUTPUTS_DIR, ASSETS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="VertiClip Studio API",
    description="Motor automatizado con FastAPI, yt-dlp y FFmpeg para extracción y reencuadre vertical 9:16 (1080x1920)",
    version="1.0.0",
)

app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))

# Almacén en memoria para estado de colas de renderizado (en producción puede migrarse a Redis)
JOBS_STORE: Dict[str, Dict[str, Any]] = {}


class ClipRange(BaseModel):
    clip_id: str = Field(..., description="Identificador o nombre del clip")
    start_time: str = Field(..., description="Timestamp de inicio (HH:MM:SS)")
    end_time: str = Field(..., description="Timestamp de fin (HH:MM:SS)")


class TextOverlayConfig(BaseModel):
    enabled: bool = False
    text: str = ""
    font_path: str = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
    font_size: int = 56
    font_color: str = "white"
    box_enabled: bool = True
    box_color: str = "black@0.75"
    border_w: int = 3
    border_color: str = "black"
    position: str = "top"  # top | center | bottom


class BatchRenderRequest(BaseModel):
    source_video_filename: str
    template_id: str = "blur_bg"  # blur_bg | split_screen | full_crop
    secondary_media_filename: Optional[str] = None
    watermark_filename: Optional[str] = None
    watermark_position: str = "top-right"
    watermark_scale: float = 0.20
    text_overlay: TextOverlayConfig = TextOverlayConfig()
    clips: List[ClipRange]


class YouTubeIngestRequest(BaseModel):
    url: str


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/api/ingest/youtube")
async def ingest_youtube(payload: YouTubeIngestRequest):
    """
    Descarga un vídeo de YouTube en máxima calidad MP4 (H.264 + AAC) usando yt-dlp.
    """
    video_id = uuid.uuid4().hex[:10]
    output_template = str(UPLOADS_DIR / f"yt_{video_id}.%(ext)s")

    ydl_opts = {
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(payload.url, download=True)
            title = info.get("title", f"YouTube_{video_id}")
            duration = info.get("duration", 0)
            final_path = UPLOADS_DIR / f"yt_{video_id}.mp4"

            if not final_path.exists():
                # Localiza el archivo descargado si tuvo otra extensión
                matches = list(UPLOADS_DIR.glob(f"yt_{video_id}.*"))
                if not matches:
                    raise HTTPException(status_code=500, detail="No se encontró el archivo descargado por yt-dlp.")
                final_path = matches[0]

        return {
            "status": "ok",
            "filename": final_path.name,
            "title": title,
            "duration": duration,
            "video_url": f"/uploads/{final_path.name}",
        }
    except Exception as exc:
        logger.exception("Error descargando desde YouTube")
        raise HTTPException(status_code=400, detail=f"Error en yt-dlp: {str(exc)}")


@app.post("/api/ingest/upload")
async def upload_file(
    file: UploadFile = File(...),
    asset_type: str = Form("source_video"),  # source_video | secondary_media | watermark
):
    """
    Sube un vídeo local (.mp4, .mov, .mkv) o un asset de superposición (.png, .jpg, .mp4).
    """
    ext = Path(file.filename or "video.mp4").suffix.lower()
    allowed_exts = {".mp4", ".mov", ".mkv", ".webm", ".png", ".jpg", ".jpeg", ".webp"}
    if ext not in allowed_exts:
        raise HTTPException(status_code=400, detail=f"Extensión no soportada: {ext}")

    target_dir = UPLOADS_DIR if asset_type == "source_video" else ASSETS_DIR
    safe_name = f"{asset_type}_{uuid.uuid4().hex[:8]}{ext}"
    dest_path = target_dir / safe_name

    with dest_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "status": "ok",
        "asset_type": asset_type,
        "filename": safe_name,
        "original_name": file.filename,
        "url": f"/uploads/{safe_name}" if asset_type == "source_video" else None,
    }


def process_batch_job(job_id: str, req: BatchRenderRequest):
    """
    Tarea en segundo plano (BackgroundTask) que procesa todos los clips del lote con FFmpeg.
    """
    job = JOBS_STORE[job_id]
    job["status"] = "processing"

    source_path = UPLOADS_DIR / req.source_video_filename
    secondary_path = (ASSETS_DIR / req.secondary_media_filename) if req.secondary_media_filename else None
    watermark_path = (ASSETS_DIR / req.watermark_filename) if req.watermark_filename else None

    for idx, clip in enumerate(req.clips):
        clip_entry = job["clips"][idx]
        clip_entry["status"] = "rendering"

        safe_slug = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in clip.clip_id)
        out_filename = f"{job_id}_{idx + 1:02d}_{safe_slug}_9x16.mp4"
        out_path = OUTPUTS_DIR / out_filename

        try:
            cmd = build_ffmpeg_command(
                input_video_path=str(source_path),
                output_video_path=str(out_path),
                start_time=clip.start_time,
                end_time=clip.end_time,
                template_id=req.template_id,
                secondary_media_path=str(secondary_path) if secondary_path else None,
                watermark_path=str(watermark_path) if watermark_path else None,
                watermark_position=req.watermark_position,
                watermark_scale=req.watermark_scale,
                text_overlay=req.text_overlay.model_dump(),
            )
            result = run_ffmpeg_render(cmd)
            clip_entry["status"] = "completed"
            clip_entry["output_url"] = f"/outputs/{out_filename}"
            clip_entry["filename"] = out_filename
            clip_entry["ffmpeg_command"] = result["command"]
        except Exception as exc:
            clip_entry["status"] = "failed"
            clip_entry["error"] = str(exc)

        job["completed_count"] = sum(1 for c in job["clips"] if c["status"] == "completed")

    has_errors = any(c["status"] == "failed" for c in job["clips"])
    job["status"] = "completed_with_errors" if has_errors else "completed"


@app.post("/api/render/batch")
async def start_batch_render(req: BatchRenderRequest, background_tasks: BackgroundTasks):
    """
    Encola un lote de clips para renderizado asíncrono con FFmpeg.
    """
    source_path = UPLOADS_DIR / req.source_video_filename
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="El vídeo fuente indicado no existe en el servidor.")

    if not req.clips:
        raise HTTPException(status_code=400, detail="Debes definir al menos un rango de tiempo (clip).")

    job_id = f"job_{uuid.uuid4().hex[:8]}"
    JOBS_STORE[job_id] = {
        "job_id": job_id,
        "status": "queued",
        "template_id": req.template_id,
        "total_clips": len(req.clips),
        "completed_count": 0,
        "clips": [
            {
                "clip_id": c.clip_id,
                "start_time": c.start_time,
                "end_time": c.end_time,
                "status": "queued",
                "output_url": None,
                "filename": None,
                "ffmpeg_command": None,
                "error": None,
            }
            for c in req.clips
        ],
    }

    background_tasks.add_task(process_batch_job, job_id, req)
    return JOBS_STORE[job_id]


@app.get("/api/render/status/{job_id}")
async def get_job_status(job_id: str):
    """
    Consulta el progreso de la cola de renderizado y devuelve los enlaces de descarga.
    """
    if job_id not in JOBS_STORE:
        raise HTTPException(status_code=404, detail="Trabajo de renderizado no encontrado.")
    return JOBS_STORE[job_id]


@app.get("/api/render/download/{filename}")
async def download_clip(filename: str):
    """
    Descarga directa del clip MP4 9:16 procesado.
    """
    file_path = OUTPUTS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Archivo no encontrado.")
    return FileResponse(path=str(file_path), media_type="video/mp4", filename=filename)
