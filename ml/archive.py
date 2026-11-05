"""Extract supported ZIP entries to generated paths inside a session directory."""
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile
from zlib import error as ZlibError


class ArchiveError(ValueError):
    pass


def extract(payload):
    archive_path = Path(payload["path"])
    limit = payload["limit"]
    allowed = set(payload["extensions"])
    files, total = [], 0
    with ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > 128:
            raise ArchiveError("ZIP 最多可包含 128 个条目。")
        for entry in entries:
            raw = entry.orig_filename
            parts = raw.rstrip("/").split("/")
            if (re.search(r"[:\\\x00-\x1f\x7f]", raw) or any(p in ("", ".", "..") for p in parts)
                    or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFDIR, stat.S_IFREG)):
                raise ArchiveError("ZIP 含有不安全的路径或特殊文件，请重新打包。")
            if entry.is_dir() or any(p == "__MACOSX" or p.startswith(".") for p in parts):
                continue
            ext = PurePosixPath(raw).suffix.lower()
            if ext not in allowed:
                continue
            if len(files) >= 16 or len(raw) > 240:
                raise ArchiveError("ZIP 最多支持 16 个数据文件，每个文件路径最多 240 个字符。")
            if entry.flag_bits & 1 or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
                raise ArchiveError("请上传未加密的普通 ZIP 压缩包。")
            if total + entry.file_size > limit:
                raise ArchiveError(f"ZIP 中的数据解压后不能超过 {limit // (1024 * 1024)} MB。")
            path = archive_path.parent / f"entry-{len(files) + 1}{ext}"
            with archive.open(entry) as source, path.open("xb") as dest:
                while chunk := source.read(64 * 1024):
                    total += len(chunk)
                    if total > limit:
                        raise ArchiveError(f"ZIP 中的数据解压后不能超过 {limit // (1024 * 1024)} MB。")
                    dest.write(chunk)
            files.append({"name": parts[-1], "entry": raw, "path": str(path)})
    if not files:
        raise ArchiveError("ZIP 里没有可读取的数据文件，请放入 CSV、XLSX 或其他支持的表格。")
    return files


if __name__ == "__main__":
    try:
        print(json.dumps({"report": extract(json.load(sys.stdin))}, ensure_ascii=False))
    except ArchiveError as error:
        print(json.dumps({"error": {"code": "ZIP_INVALID", "message": str(error)}}, ensure_ascii=False))
    except (BadZipFile, OSError, RuntimeError, UnicodeError, ZlibError):
        print(json.dumps({"error": {"code": "ZIP_INVALID", "message": "ZIP 损坏或无法解压，请重新打包后上传。"}}, ensure_ascii=False))
