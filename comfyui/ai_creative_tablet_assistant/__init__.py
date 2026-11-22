import asyncio
import base64
import hashlib
import json
import re
from http.client import HTTPConnection, HTTPException
from io import BytesIO
from ipaddress import ip_address
from pathlib import Path
from secrets import token_hex
from socket import create_connection
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit

from aiohttp import web
import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
from server import PromptServer


_ENDPOINT = "/api/image/latest-returned"
_MAX_IMAGE_BYTES = 32 * 1024 * 1024
_MAX_EDGE = 8192
_MAX_PIXELS = 32 * 1024 * 1024
_IMAGE_VERSION = re.compile(r'"[0-9a-f]{64}"')
_LIVE_SUBFOLDER = "TabletLive_" + token_hex(12)
_NO_IMAGE = "还没有平板回传图像。请在平板上发送画布。"


class _LegacyService(RuntimeError):
    pass


class _NoTabletImage(RuntimeError):
    pass


def _request_latest(port: int, method: str) -> tuple[bytes | None, str | None]:
    if type(port) is not int or not 1 <= port <= 65535:
        raise RuntimeError("平板助手端口须为 1–65535 的整数。")

    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, _ENDPOINT, headers={"Accept": "image/*"})
        with connection.getresponse() as response:
            content_type = response.getheader("Content-Type", "")
            version = response.getheader("ETag")
            if response.status == 404:
                if content_type.startswith("application/json"):
                    raise _NoTabletImage(_NO_IMAGE)
                raise _LegacyService("当前平板助手没有单图读取接口。")
            if response.status != 200 or not content_type.startswith("image/"):
                raise RuntimeError(f"平板助手返回了非图像响应（HTTP {response.status}）。")
            if method == "HEAD":
                return None, version
            data = response.read(_MAX_IMAGE_BYTES + 1)
            if len(data) > _MAX_IMAGE_BYTES:
                raise RuntimeError("回传图像超过 32 MiB，无法载入。")
            return data, version
    except (OSError, HTTPException) as error:
        raise RuntimeError(f"无法读取本机平板助手。请确认服务正在端口 {port} 运行。") from error
    finally:
        connection.close()


def _read_legacy_image(port: int) -> bytes:
    # Existing services can supply the image through their local PC connection.
    try:
        from websockets.exceptions import WebSocketException
        from websockets.sync.client import connect
    except ImportError as error:
        raise RuntimeError("请启动新版平板助手，或在 ComfyUI 环境中启用 websockets。") from error

    address = f"127.0.0.1:{port}"
    try:
        with create_connection(("127.0.0.1", port), timeout=5) as socket:
            with connect(
                f"ws://{address}/?role=pc&device=ComfyUI",
                sock=socket,
                origin=f"http://{address}",
                open_timeout=5,
                close_timeout=1,
                max_size=128 * 1024 * 1024,
            ) as connection:
                for _ in range(4):
                    state = json.loads(connection.recv(timeout=5))
                    if isinstance(state, dict) and state.get("type") == "INIT_STATE":
                        break
                else:
                    raise RuntimeError("平板助手没有发送初始画布状态。")

        item = state.get("latestReturnedImage")
        if not item:
            raise _NoTabletImage(_NO_IMAGE)
        data_url = item.get("dataUrl")
        if not isinstance(data_url, str):
            raise RuntimeError("平板助手返回了无效的图像数据。")
        prefix, separator, encoded = data_url.partition(",")
        if not separator or not prefix.startswith("data:image/") or not prefix.endswith(";base64"):
            raise RuntimeError("平板助手返回了无效的图像数据。")
        if len(encoded) > (_MAX_IMAGE_BYTES + 2) // 3 * 4:
            raise RuntimeError("回传图像超过 32 MiB，无法载入。")
        return base64.b64decode(encoded, validate=True)
    except (OSError, WebSocketException, ValueError) as error:
        raise RuntimeError("无法从当前平板助手读取回传图像，更新服务后可使用单图接口。") from error


def _decode_rgb(data: bytes) -> Image.Image:
    if len(data) > _MAX_IMAGE_BYTES:
        raise RuntimeError("回传图像超过 32 MiB，无法载入。")
    try:
        with Image.open(BytesIO(data)) as source:
            width, height = source.size
            if max(width, height) > _MAX_EDGE or width * height > _MAX_PIXELS:
                raise RuntimeError("回传图像尺寸超出支持范围。")
            return ImageOps.exif_transpose(source).convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise RuntimeError("无法解码回传图像，请在平板上重新发送。") from error


def _live_preview(port, known_version):
    directory = Path(folder_paths.get_temp_directory()) / _LIVE_SUBFOLDER
    if known_version:
        _, version = _request_latest(port, "HEAD")
        if version == known_version and (directory / f"{port}-{version[1:-1]}.png").is_file():
            return None, version
    data, version = _request_latest(port, "GET")
    if not _IMAGE_VERSION.fullmatch(version or ""):
        version = '"' + hashlib.sha256(data).hexdigest() + '"'
    filename = f"{port}-{version[1:-1]}.png"
    target = directory / filename
    if version == known_version and target.is_file():
        return None, version
    if not target.is_file():
        directory.mkdir(parents=True, exist_ok=True)
        with _decode_rgb(data) as image:
            image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            with NamedTemporaryFile(dir=directory, suffix=".tmp", delete=False) as temporary:
                temp_path = Path(temporary.name)
                try:
                    image.save(temporary, format="PNG", compress_level=1)
                    temporary.close()
                    temp_path.replace(target)
                finally:
                    temporary.close()
                    temp_path.unlink(missing_ok=True)
        # Keep recent thumbnails available to graphs that have not refreshed yet.
        try:
            previous = [file for file in directory.glob(f"{port}-*.png") if file != target]
            previous.sort(key=lambda file: file.stat().st_mtime_ns, reverse=True)
            for file in previous[3:]:
                file.unlink(missing_ok=True)
        except OSError:
            pass
    return {"filename": filename, "subfolder": _LIVE_SUBFOLDER, "type": "temp"}, version


@PromptServer.instance.routes.get("/ai-creative-tablet/preview")
async def tablet_preview(request):
    headers = {"Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin"}
    origin = request.headers.get("Origin")
    host = None
    try:
        host = urlsplit("//" + request.host).hostname
        local = ip_address(request.remote or "").is_loopback
    except ValueError:
        local = False
    if (not local or host not in ("localhost", "127.0.0.1", "::1")
            or request.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none")
            or (origin and origin != f"{request.scheme}://{request.host}")):
        return web.Response(status=403, headers=headers)

    raw_port = request.query.get("port", "3680")
    if not re.fullmatch(r"[1-9][0-9]{0,4}", raw_port) or int(raw_port) > 65535:
        return web.Response(status=400, headers=headers)
    version = request.headers.get("If-None-Match")
    if not _IMAGE_VERSION.fullmatch(version or ""):
        version = None
    try:
        preview, updated_version = await asyncio.to_thread(_live_preview, int(raw_port), version)
    except _NoTabletImage:
        return web.Response(status=404, headers=headers)
    except (RuntimeError, OSError):
        return web.Response(status=503, headers=headers)
    if updated_version:
        headers["ETag"] = updated_version
    if preview is None:
        return web.Response(status=304, headers=headers)
    return web.json_response({"images": [preview]}, headers=headers)


class TabletReturnImage:
    """Read the latest composited image returned by the tablet."""

    CATEGORY = "AI创作平板助手"
    DESCRIPTION = "自动预览最近一次回传图。运行工作流时，将最新图片作为 IMAGE 输出。"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "load_image"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "port": ("INT", {
                    "default": 3680,
                    "min": 1,
                    "max": 65535,
                    "tooltip": "本机平板助手端口，默认 3680。",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, port):
        try:
            _, version = _request_latest(port, "HEAD")
        except RuntimeError:
            return float("nan")
        return version or float("nan")

    def load_image(self, port):
        from nodes import PreviewImage

        try:
            data, _ = _request_latest(port, "GET")
        except _LegacyService:
            data = _read_legacy_image(port)
        with _decode_rgb(data) as source:
            pixels = np.array(source, dtype=np.float32)

        pixels *= 1.0 / 255.0
        image = torch.from_numpy(pixels).unsqueeze(0)
        preview = PreviewImage().save_images(image, filename_prefix="TabletReturn")
        return {"ui": preview["ui"], "result": (image,)}


NODE_CLASS_MAPPINGS = {"AICreativeTabletReturnImage": TabletReturnImage}
NODE_DISPLAY_NAME_MAPPINGS = {"AICreativeTabletReturnImage": "读取平板回传图像 (Tablet Return Image)"}
WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
