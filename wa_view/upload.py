"""Recebimento de exports .zip enviados pela interface.

O cliente envia o arquivo bruto no corpo de um ``POST /api/upload``
(``Content-Type: application/zip``, nome em ``X-Filename``). O corpo é
gravado em disco em blocos, com limite de tamanho e hash SHA-256 calculado
durante a recepção; depois o ZIP é validado, extraído com segurança e
carregado. Só então o export ativo é substituído.
"""
import hashlib
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

from .extractor import ArchiveError, Extraction, safe_extract
from .parser import ChatStore

ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06")


class UploadError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class AppState:
    """Export ativo + configuração de upload (compartilhado entre threads)."""

    def __init__(self, store=None, uploads_dir=None, max_upload=4 * 1024 ** 3,
                 extra_media=(), limits=None):
        self.store = store
        self.uploads_dir = Path(uploads_dir)
        self.max_upload = max_upload
        self.extra_media = list(extra_media)
        self.limits = limits
        self.upload_info = None
        self._current_upload_dir = None
        self._lock = threading.Lock()

    @property
    def busy(self):
        return self._lock.locked()

    def status(self):
        return {
            "loaded": self.store is not None,
            "busy": self.busy,
            "max_upload": self.max_upload,
            "upload": self.upload_info,
        }

    # ----------------------------------------------------------------- upload
    def receive(self, rfile, headers):
        if not self._lock.acquire(blocking=False):
            raise UploadError(409, "busy", "Já existe um upload em processamento. Aguarde a conclusão.")
        work = None
        try:
            length = self._content_length(headers)
            name = Path(unquote(headers.get("X-Filename") or "export.zip")).name or "export.zip"
            if not name.lower().endswith(".zip"):
                raise UploadError(415, "not_zip", "Envie um arquivo com extensão .zip.")
            self.uploads_dir.mkdir(parents=True, exist_ok=True)
            work = self.uploads_dir / f"{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}"
            work.mkdir()
            zip_path = work / "export.zip"
            t0 = time.time()
            digest = self._stream_to_disk(rfile, length, zip_path)
            with open(zip_path, "rb") as fh:
                if not fh.read(4).startswith(ZIP_MAGIC):
                    raise UploadError(400, "bad_zip", "O arquivo enviado não é um ZIP válido.")
            try:
                files = safe_extract(zip_path, work / "extracted", self.limits)
            except ArchiveError as exc:
                raise UploadError(400, "bad_zip", str(exc)) from exc
            try:
                extraction = Extraction(work / "extracted", source_zip=zip_path, extra_media=self.extra_media)
            except FileNotFoundError as exc:
                raise UploadError(422, "no_chatstorage",
                                  "O ZIP não contém o banco ChatStorage.sqlite do WhatsApp.") from exc
            try:
                store = ChatStore(extraction)
            except Exception as exc:  # banco ilegível / schema inesperado
                raise UploadError(422, "bad_database", f"Não foi possível ler o banco do WhatsApp: {exc}") from exc
            info = {
                "original_name": name,
                "size": length,
                "sha256": digest,
                "received_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "files_extracted": files,
                "seconds": round(time.time() - t0, 2),
            }
            previous = self._current_upload_dir
            self.store, self.upload_info, self._current_upload_dir = store, info, work
            work = None  # não remover: é o export ativo
            if previous and previous.exists():
                shutil.rmtree(previous, ignore_errors=True)
            return {"ok": True, "upload": info, "summary": store.summary()}
        finally:
            if work is not None:
                shutil.rmtree(work, ignore_errors=True)
            self._lock.release()

    def _content_length(self, headers):
        if headers.get("Transfer-Encoding", "").lower() == "chunked":
            raise UploadError(411, "length_required", "Envio fragmentado não suportado; informe Content-Length.")
        raw = headers.get("Content-Length")
        if raw is None:
            raise UploadError(411, "length_required", "Cabeçalho Content-Length ausente.")
        try:
            length = int(raw)
        except ValueError as exc:
            raise UploadError(400, "bad_length", "Content-Length inválido.") from exc
        if length <= 0:
            raise UploadError(400, "empty", "Arquivo vazio.")
        if length > self.max_upload:
            raise UploadError(413, "too_large",
                              f"Arquivo maior que o limite de {self.max_upload // 1024 ** 2} MB.")
        return length

    @staticmethod
    def _stream_to_disk(rfile, length, target):
        h = hashlib.sha256()
        remaining = length
        with open(target, "wb") as out:
            while remaining > 0:
                chunk = rfile.read(min(1 << 20, remaining))
                if not chunk:
                    raise UploadError(400, "incomplete", "Upload interrompido antes do fim do arquivo.")
                h.update(chunk)
                out.write(chunk)
                remaining -= len(chunk)
        return h.hexdigest()
