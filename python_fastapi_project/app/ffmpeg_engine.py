import os
import shlex
import subprocess
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger("verticlip.ffmpeg")


def escape_drawtext(text: str) -> str:
    """
    Escapa caracteres especiales para el filtro drawtext de FFmpeg.
    """
    if not text:
        return ""
    escaped = text.replace("\\", "\\\\")
    escaped = escaped.replace(":", "\\:")
    escaped = escaped.replace("'", "\\'")
    escaped = escaped.replace("%", "\\%")
    return escaped


def resolve_text_position(position: str) -> str:
    """
    Devuelve las coordenadas x:y de FFmpeg drawtext para un lienzo 1080x1920.
    """
    pos_map = {
        "top": "x=(w-text_w)/2:y=180",
        "center": "x=(w-text_w)/2:y=(h-text_h)/2",
        "bottom": "x=(w-text_w)/2:y=h-text_h-240",
    }
    return pos_map.get(position, pos_map["top"])


def resolve_overlay_position(position: str, margin: int = 48) -> str:
    """
    Devuelve las coordenadas x:y del filtro overlay para marca de agua/logo en 1080x1920.
    """
    pos_map = {
        "top-left": f"x={margin}:y={margin}",
        "top-right": f"x=W-w-{margin}:y={margin}",
        "center": "x=(W-w)/2:y=(H-h)/2",
        "bottom-left": f"x={margin}:y=H-h-{margin}",
        "bottom-right": f"x=W-w-{margin}:y=H-h-{margin}",
    }
    return pos_map.get(position, pos_map["top-right"])


def build_ffmpeg_command(
    input_video_path: str,
    output_video_path: str,
    start_time: str,
    end_time: str,
    template_id: str = "blur_bg",
    secondary_media_path: Optional[str] = None,
    watermark_path: Optional[str] = None,
    watermark_position: str = "top-right",
    watermark_scale: float = 0.20,
    text_overlay: Optional[Dict[str, Any]] = None,
) -> list[str]:
    """
    Construye el comando exacto de FFmpeg (con filter_complex avanzado) para:
    - Plantilla 1 (blur_bg): Fondo 9:16 con desenfoque gaussiano y oscurecimiento + 16:9 centrado.
    - Plantilla 2 (split_screen): Mitad superior 1080x960 vídeo original + mitad inferior 1080x960 loop/imagen.
    - Plantilla 3 (full_crop): Recorte central directo 9:16 (1080x1920).
    - Superposición de Texto (drawtext) y Marca de Agua PNG (overlay).
    - Sincronización exacta de audio y vídeo con recorte preciso (-ss / -to).
    """
    cmd = [
        "ffmpeg",
        "-y",
        "-ss", start_time,
        "-to", end_time,
        "-i", input_video_path,
    ]

    # Gestión dinámica de índices de entrada adicionales
    input_idx = 1
    sec_idx: Optional[int] = None
    wm_idx: Optional[int] = None

    if template_id == "split_screen" and secondary_media_path and os.path.exists(secondary_media_path):
        ext = os.path.splitext(secondary_media_path)[1].lower()
        if ext in [".png", ".jpg", ".jpeg", ".webp"]:
            cmd.extend(["-loop", "1", "-i", secondary_media_path])
        else:
            cmd.extend(["-stream_loop", "-1", "-i", secondary_media_path])
        sec_idx = input_idx
        input_idx += 1

    if watermark_path and os.path.exists(watermark_path):
        cmd.extend(["-i", watermark_path])
        wm_idx = input_idx
        input_idx += 1

    filter_chains: list[str] = []
    current_video_label = "[base_v]"

    # 1. Construcción de la Plantilla Base (1080x1920)
    if template_id == "blur_bg":
        # Plantilla 1: Fondo Blur 9:16 + Vídeo 16:9 centrado
        filter_chains.append(
            "[0:v]split=2[bg_src][fg_src];"
            "[bg_src]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,boxblur=25:5,eq=brightness=-0.12[bg_blur];"
            "[fg_src]scale=1080:-2:force_original_aspect_ratio=decrease[fg_scaled];"
            f"[bg_blur][fg_scaled]overlay=(W-w)/2:(H-h)/2:shortest=1{current_video_label}"
        )

    elif template_id == "split_screen":
        # Plantilla 2: Split Screen Superior (1080x960) + Inferior (1080x960)
        if sec_idx is not None:
            filter_chains.append(
                "[0:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[top_v];"
                f"[{sec_idx}:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[bot_v];"
                f"[top_v][bot_v]vstack=inputs=2:shortest=1{current_video_label}"
            )
        else:
            # Fallback si no hay media secundario: duplica una versión con zoom/espejo en la mitad inferior
            filter_chains.append(
                "[0:v]split=2[top_src][bot_src];"
                "[top_src]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[top_v];"
                "[bot_src]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,boxblur=15:3,setsar=1[bot_v];"
                f"[top_v][bot_v]vstack=inputs=2{current_video_label}"
            )

    else:
        # Plantilla 3: Full Crop Center (9:16 ocupando todo el lienzo 1080x1920)
        filter_chains.append(
            "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
            f"crop=1080:1920,setsar=1{current_video_label}"
        )

    # 2. Superposición de Imagen / Marca de Agua PNG (Opcional)
    if wm_idx is not None:
        target_wm_width = max(64, min(800, int(1080 * float(watermark_scale))))
        pos_expr = resolve_overlay_position(watermark_position)
        next_label = "[v_wm]"
        filter_chains.append(
            f"[{wm_idx}:v]scale={target_wm_width}:-1,format=rgba[wm_scaled];"
            f"{current_video_label}[wm_scaled]overlay={pos_expr}:format=auto{next_label}"
        )
        current_video_label = next_label

    # 3. Superposición de Texto / Hook (drawtext) (Opcional)
    if text_overlay and text_overlay.get("enabled") and text_overlay.get("text", "").strip():
        escaped_text = escape_drawtext(text_overlay["text"].strip())
        font_file = text_overlay.get("font_path", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf")
        font_size = int(text_overlay.get("font_size", 56))
        font_color = text_overlay.get("font_color", "white")
        box_enabled = 1 if text_overlay.get("box_enabled", True) else 0
        box_color = text_overlay.get("box_color", "black@0.75")
        border_w = int(text_overlay.get("border_w", 3))
        border_color = text_overlay.get("border_color", "black")
        pos_coords = resolve_text_position(text_overlay.get("position", "top"))

        next_label = "[v_out]"
        drawtext_parts = [
            f"text='{escaped_text}'",
            f"fontsize={font_size}",
            f"fontcolor={font_color}",
            pos_coords,
            f"borderw={border_w}",
            f"bordercolor={border_color}",
            f"box={box_enabled}",
            f"boxcolor={box_color}",
            "boxborderw=18",
        ]
        if os.path.exists(font_file):
            drawtext_parts.insert(0, f"fontfile='{font_file}'")

        drawtext_filter = ":".join(drawtext_parts)
        filter_chains.append(f"{current_video_label}drawtext={drawtext_filter}{next_label}")
        current_video_label = next_label

    filter_complex_str = ";".join(filter_chains)

    cmd.extend([
        "-filter_complex", filter_complex_str,
        "-map", current_video_label,
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output_video_path,
    ])

    return cmd


def run_ffmpeg_render(cmd: list[str]) -> Dict[str, Any]:
    """
    Ejecuta el proceso FFmpeg de forma segura y devuelve el resultado.
    """
    logger.info("Ejecutando comando FFmpeg: %s", " ".join(shlex.quote(arg) for arg in cmd))
    process = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        logger.error("Error en FFmpeg: %s", process.stderr)
        raise RuntimeError(f"FFmpeg falló con código {process.returncode}: {process.stderr[-600:]}")

    return {
        "returncode": process.returncode,
        "command": " ".join(shlex.quote(arg) for arg in cmd),
    }
