"""Análise forense das mídias referenciadas nas conversas.

Cada item de mídia recebe um ``status``:

* ``ok``        arquivo presente e coerente com os metadados do banco;
* ``missing``   referenciado no banco, mas o arquivo não está no export;
* ``corrupted`` arquivo presente, porém vazio, truncado, de tipo incompatível
                com a mensagem ou com tamanho diferente do declarado
                (não corresponde ao arquivo original).

Avisos que não invalidam o arquivo (ex.: extensão diferente do conteúdo)
vão em ``warnings``.
"""
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Tipos de mensagem que carregam um arquivo físico.
FILE_KINDS = {"image", "video", "audio", "document", "gif", "sticker"}
STATUSES = ("ok", "missing", "corrupted")

_MIME_CATEGORY = {
    "image": ("image/",),
    "sticker": ("image/",),
    "gif": ("image/", "video/"),
    "video": ("video/",),
    "audio": ("audio/",),
    "document": (),  # qualquer tipo é aceitável
}
_EXT_FOR_MIME = {
    "image/jpeg": {".jpg", ".jpeg"}, "image/png": {".png"}, "image/gif": {".gif"},
    "image/webp": {".webp"}, "audio/ogg": {".opus", ".ogg"},
    "audio/mpeg": {".mp3"}, "audio/mp4": {".m4a", ".mp4"},
    "video/mp4": {".mp4", ".mov", ".m4v"}, "application/pdf": {".pdf"},
}

ISSUE_LABELS = {
    "empty": "arquivo vazio (0 bytes)",
    "unreadable": "arquivo ilegível",
    "truncated": "estrutura do arquivo incompleta (truncado)",
    "type_mismatch": "conteúdo incompatível com o tipo da mensagem",
    "size_mismatch": "tamanho diferente do declarado no banco",
    "extension_mismatch": "extensão não corresponde ao conteúdo",
    "not_in_export": "arquivo não incluído no export",
    "no_local_path": "mensagem sem caminho local de mídia no banco",
}


def _looks_truncated(path, mime):
    """Verificação estrutural barata: marcadores de fim de arquivo."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(8)
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 64))
            tail = fh.read()
    except OSError:
        return None
    if mime == "image/jpeg":
        return b"\xff\xd9" not in tail
    if mime == "image/png":
        return b"IEND" not in tail
    if mime == "audio/ogg":
        return not head.startswith(b"OggS") or size < 64
    return False


def assess(kind, local_path, path, mime, declared_size):
    """Retorna ``(status, issues, warnings)`` para um item de mídia."""
    issues, warnings = [], []
    if path is None:
        issues.append("not_in_export" if local_path else "no_local_path")
        return "missing", issues, warnings
    try:
        actual = Path(path).stat().st_size
    except OSError:
        return "corrupted", ["unreadable"], warnings
    if actual == 0:
        return "corrupted", ["empty"], warnings
    truncated = _looks_truncated(path, mime)
    if truncated is None:
        issues.append("unreadable")
    elif truncated:
        issues.append("truncated")
    prefixes = _MIME_CATEGORY.get(kind, ())
    if prefixes and mime and not mime.startswith(prefixes):
        issues.append("type_mismatch")
    if declared_size and declared_size != actual:
        issues.append("size_mismatch")
    expected_ext = _EXT_FOR_MIME.get(mime)
    if expected_ext and Path(path).suffix.lower() not in expected_ext:
        warnings.append("extension_mismatch")
    return ("corrupted" if issues else "ok"), issues, warnings


def _month(ts):
    if not ts:
        return None
    return datetime.fromtimestamp(ts["unix"], tz=timezone.utc).strftime("%Y-%m")


class MediaIndex:
    """Índice de mídias com contexto da conversa, filtros e sumarização."""

    def __init__(self, store):
        self.items = []
        self.by_chat = defaultdict(list)
        self.by_media_id = {}
        for chat in store.chats:
            for msg in store.messages(chat["id"]):
                media = msg.get("media")
                if not media or msg["type"] not in FILE_KINDS:
                    continue
                sender = msg["sender"]
                item = {
                    "media_id": media["id"],
                    "message_id": msg["id"],
                    "chat_id": chat["id"],
                    "chat_name": chat["name"],
                    "chat_type": chat["type"],
                    "kind": msg["type"],
                    "status": media["status"],
                    "issues": media["issues"],
                    "warnings": media["warnings"],
                    "from_me": msg["from_me"],
                    "sender_name": sender["name"],
                    "sender_jid": sender.get("jid"),
                    "timestamp": msg["timestamp"],
                    "caption": msg["text"],
                    "url": media["url"],
                    "mime": media["mime"],
                    "filename": media["filename"] or (Path(media["local_path"]).name if media["local_path"] else None),
                    "local_path": media["local_path"],
                    "declared_size": media["declared_size"],
                    "actual_size": media["actual_size"],
                    "duration": media["duration"],
                }
                self.items.append(item)
                self.by_chat[chat["id"]].append(item)
                self.by_media_id[media["id"]] = item

    # --------------------------------------------------------------- filtros
    def query(self, chat_id=None, status=None, kind=None, sender=None, offset=0, limit=100):
        items = self.by_chat.get(chat_id, []) if chat_id is not None else self.items
        statuses = set(status.split(",")) if status else None
        kinds = set(kind.split(",")) if kind else None
        out = [
            i for i in items
            if (statuses is None or i["status"] in statuses)
            and (kinds is None or i["kind"] in kinds)
            and (sender is None or (i["sender_jid"] or i["sender_name"]) == sender)
        ]
        if chat_id is None:
            out.sort(key=lambda i: (i["timestamp"] or {}).get("unix", 0))
        limit = max(1, min(int(limit), 1000))
        offset = max(0, int(offset))
        return {"total": len(out), "offset": offset, "limit": limit, "items": out[offset:offset + limit]}

    def chat_counts(self, chat_id):
        items = self.by_chat.get(chat_id, [])
        c = Counter(i["status"] for i in items)
        return {"total": len(items), "ok": c["ok"], "missing": c["missing"], "corrupted": c["corrupted"]}

    # ----------------------------------------------------------- sumarização
    def summary(self, chat_id=None):
        items = self.by_chat.get(chat_id, []) if chat_id is not None else self.items
        by_kind = defaultdict(lambda: {s: 0 for s in STATUSES} | {"total": 0, "declared_bytes": 0, "present_bytes": 0})
        totals = {s: 0 for s in STATUSES} | {"total": 0, "declared_bytes": 0, "present_bytes": 0, "missing_declared_bytes": 0}
        issues = Counter()
        timeline = defaultdict(Counter)
        per_chat = {}
        per_sender = {}
        first = last = None
        for i in items:
            k = by_kind[i["kind"]]
            for bucket in (k, totals):
                bucket[i["status"]] += 1
                bucket["total"] += 1
                bucket["declared_bytes"] += i["declared_size"] or 0
                bucket["present_bytes"] += i["actual_size"] or 0
            if i["status"] == "missing":
                totals["missing_declared_bytes"] += i["declared_size"] or 0
            issues.update(i["issues"])
            issues.update(i["warnings"])
            month = _month(i["timestamp"])
            if month:
                timeline[month][i["kind"]] += 1
                timeline[month]["_" + i["status"]] += 1
                u = i["timestamp"]["unix"]
                first = u if first is None or u < first else first
                last = u if last is None or u > last else last
            for table, key, base in (
                (per_chat, i["chat_id"], {"chat_id": i["chat_id"], "chat_name": i["chat_name"], "chat_type": i["chat_type"]}),
                (per_sender, "me" if i["from_me"] else (i["sender_jid"] or i["sender_name"]),
                 {"sender": "me" if i["from_me"] else (i["sender_jid"] or i["sender_name"]),
                  "sender_name": i["sender_name"], "sender_jid": i["sender_jid"], "from_me": i["from_me"]}),
            ):
                row = table.get(key)
                if row is None:
                    row = table[key] = base | {"total": 0, "ok": 0, "missing": 0, "corrupted": 0,
                                               "declared_bytes": 0, "present_bytes": 0, "kinds": Counter()}
                row["total"] += 1
                row[i["status"]] += 1
                row["declared_bytes"] += i["declared_size"] or 0
                row["present_bytes"] += i["actual_size"] or 0
                row["kinds"][i["kind"]] += 1
        months = sorted(timeline)
        if months:  # preenche meses sem mídia para a linha do tempo ficar contínua
            y, m = map(int, months[0].split("-"))
            ly, lm = map(int, months[-1].split("-"))
            months = []
            while (y, m) <= (ly, lm):
                months.append(f"{y:04d}-{m:02d}")
                y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        rank = lambda rows: sorted(  # noqa: E731
            ({**r, "kinds": dict(r["kinds"])} for r in rows.values()), key=lambda r: (-r["total"], str(r.get("chat_name") or r.get("sender_name"))))
        return {
            "scope_chat_id": chat_id,
            "totals": totals,
            "by_kind": {k: v for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1]["total"])},
            "issues": [{"code": c, "label": ISSUE_LABELS.get(c, c), "count": n} for c, n in issues.most_common()],
            "timeline": [{"month": m, **{k: v for k, v in timeline.get(m, {}).items()}} for m in months],
            "first_unix": first,
            "last_unix": last,
            "chats_with_media": len(per_chat),
            "per_chat": rank(per_chat),
            "per_sender": rank(per_sender),
        }
