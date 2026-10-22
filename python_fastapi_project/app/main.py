import os
import uuid
import shutil
import logging
from pathlib import Path
from typing import List, Optional, Dict, Any

import yt_dlp
from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse
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
app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))

# Almacén en memoria para estado de colas de renderizado
JOBS_STORE: Dict[str, Dict[str, Any]] = {}


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
    position: str = "top"  # top | center | bottom

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
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/studio/init")
async def studio_init():
    return {
        "defaultSource": {
            "filename": "studio_sample_16x9.mp4",
            "title": "Studio Broadcast Master (16:9 HD · 00:00:45)",
            "url": "/uploads/studio_sample_16x9.mp4",
            "duration": 45,
        },
        "defaultSecondary": {
            "filename": "satisfying_loop_secondary.mp4",
            "title": "Loop Visual Secundario (Mandelbrot Synth)",
            "url": "/assets/satisfying_loop_secondary.mp4",
        },
        "defaultWatermark": {
            "filename": "verticlip_badge.png",
            "title": "Logo PNG Transparente (VertiClip Badge)",
            "url": "/assets/verticlip_badge.png",
        },
    }


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
                matches = list(UPLOADS_DIR.glob(f"yt_{video_id}.*"))
                if not matches:
                    raise HTTPException(status_code=500, detail="No se encontró el archivo descargado por yt-dlp.")
                final_path = matches[0]

        return {
            "status": "ok",
            "filename": final_path.name,
            "title": title,
            "duration": duration,
            "url": f"/uploads/{final_path.name}",
            "video_url": f"/uploads/{final_path.name}",
        }
    except Exception as exc:
        logger.exception("Error descargando desde YouTube")
        raise HTTPException(status_code=400, detail=f"Error en yt-dlp: {str(exc)}")


@app.post("/api/ingest/upload")
async def upload_file(
    file: UploadFile = File(...),
    asset_type: str = Form("source_video"),
):
    """
    Sube un vídeo local (.mp4, .mov, .mkv) o un asset de superposición (.png, .jpg, .mp4).
    """
    ext = Path(file.filename or "video.mp4").suffix.lower()
    allowed_exts = {".mp4", ".mov", ".mkv", ".webm", ".png", ".jpg", ".jpeg", ".webp"}
    if ext not in allowed_exts:
        raise HTTPException(status_code=400, detail=f"Extensión no soportada: {ext}")

    target_dir = UPLOADS_DIR if asset_type == "source_video" else ASSETS_DIR
    base_route = "/uploads" if asset_type == "source_video" else "/assets"
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
        "url": f"{base_route}/{safe_name}",
    }


def process_batch_job(job_id: str, req: BatchRenderRequest):
    """
    Tarea en segundo plano (BackgroundTask) que procesa todos los clips del lote con FFmpeg.
    """
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
            clip_entry["outputUrl"] = f"/outputs/{out_filename}"
            clip_entry["output_url"] = f"/outputs/{out_filename}"
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
    """
    Encola un lote de clips para renderizado asíncrono con FFmpeg.
    """
    src_name = req.sourceVideoFilename or req.source_video_filename or "studio_sample_16x9.mp4"
    tpl_id = req.templateId or req.template_id or "blur_bg"
    source_path = UPLOADS_DIR / src_name
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="El vídeo fuente indicado no existe en el servidor.")

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
    file_path = OUTPUTS_DIR / Path(filename).name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Archivo no encontrado.")
    return FileResponse(path=str(file_path), media_type="video/mp4", filename=file_path.name)


@app.get("/api/python-project/files")
async def get_python_project_files():
    """
    Devuelve el código fuente de los módulos Python para su inspección y descarga en la UI.
    """
    def read_safe(rel_path: str) -> str:
        full_path = BASE_DIR / rel_path
        return full_path.read_text(encoding="utf-8") if full_path.exists() else ""

    return {
        "requirements": read_safe("requirements.txt"),
        "ffmpegEngine": read_safe("app/ffmpeg_engine.py"),
        "mainPy": read_safe("app/main.py"),
        "indexHtml": read_safe("app/templates/index.html"),
    }
