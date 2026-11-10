"""Extração segura do ZIP e indexação dos arquivos relevantes."""
import hashlib
import os
import zipfile
from pathlib import Path

CHAT_DB_HINTS = ("chatstorage",)
CONTACTS_DB_HINTS = ("contacts",)

MAGIC = (
    (b"OggS", "audio/ogg"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG", "image/png"),
    (b"GIF8", "image/gif"),
    (b"RIFF", "image/webp"),
    (b"ID3", "audio/mpeg"),
    (b"\xff\xf1", "audio/aac"),
    (b"\xff\xf9", "audio/aac"),
    (b"%PDF", "application/pdf"),
)
EXT_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".opus": "audio/ogg",
    ".ogg": "audio/ogg", ".aac": "audio/aac", ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".mov": "video/quicktime",
    ".pdf": "application/pdf", ".vcf": "text/vcard",
}


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def sniff_mime(path):
    """Detecta o tipo real pelo conteúdo; a extensão é só fallback.

    Necessário porque nos exports analisados arquivos ``.aac`` são, na
    prática, Ogg/Opus.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(16)
    except OSError:
        head = b""
    for magic, mime in MAGIC:
        if head.startswith(magic):
            return mime
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        return "audio/mp4" if brand in (b"M4A ", b"M4B ") else "video/mp4"
    return EXT_MIME.get(Path(path).suffix.lower(), "application/octet-stream")


class Extraction:
    """Resultado da extração: caminhos dos bancos e índice de mídias."""

    def __init__(self, root, source_zip=None):
        self.root = Path(root)
        self.source_zip = Path(source_zip) if source_zip else None
        self.chat_db = None
        self.contacts_db = None
        self.media_by_name = {}
        self.integrity = {}
        self._scan()

    def _scan(self):
        for path in sorted(self.root.rglob("*")):
            if not path.is_file():
                continue
            lower = path.name.lower()
            if lower.endswith((".sqlite", ".db", ".sqlitedb")):
                if any(h in lower for h in CHAT_DB_HINTS) and self.chat_db is None:
                    self.chat_db = path
                    continue
                if any(h in lower for h in CONTACTS_DB_HINTS) and self.contacts_db is None:
                    self.contacts_db = path
                    continue
            if lower.endswith(("-wal", "-shm", ".plist")):
                continue
            # Índice por nome de arquivo: o DB guarda caminhos do sandbox iOS
            # (Media/<jid>/a/b/<hash>.jpg) enquanto o export agrupa por tipo.
            self.media_by_name.setdefault(path.name, path)
        if self.chat_db is None:
            raise FileNotFoundError("ChatStorage.sqlite não encontrado no ZIP/pasta")
        self.integrity = {
            "source_zip": self._file_info(self.source_zip) if self.source_zip else None,
            "chat_db": self._file_info(self.chat_db),
            "contacts_db": self._file_info(self.contacts_db) if self.contacts_db else None,
            "media_files": len(self.media_by_name),
        }

    def _file_info(self, path):
        path = Path(path)
        return {
            "name": path.name,
            "size": path.stat().st_size,
            "sha256": sha256_file(path),
        }

    def resolve_media(self, local_path):
        """Localiza o arquivo físico a partir de ZMEDIALOCALPATH."""
        if not local_path:
            return None
        return self.media_by_name.get(os.path.basename(local_path))


def _safe_members(zf, dest):
    dest = Path(dest).resolve()
    for info in zf.infolist():
        target = (dest / info.filename).resolve()
        if dest not in target.parents and target != dest:
            raise ValueError(f"Caminho suspeito no ZIP: {info.filename}")
        yield info


def extract(source, workdir):
    """Extrai ``source`` (ZIP ou diretório já extraído) para ``workdir``."""
    source = Path(source)
    workdir = Path(workdir)
    if source.is_dir():
        return Extraction(source)
    workdir.mkdir(parents=True, exist_ok=True)
    marker = workdir / ".extracted"
    expected = f"{source.resolve()}|{source.stat().st_size}|{int(source.stat().st_mtime)}"
    if not (marker.exists() and marker.read_text() == expected):
        with zipfile.ZipFile(source) as zf:
            for info in _safe_members(zf, workdir):
                zf.extract(info, workdir)
        marker.write_text(expected)
    return Extraction(workdir, source_zip=source)
