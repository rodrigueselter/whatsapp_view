"""Decodificação de ZWAMESSAGEINFO.ZRECEIPTINFO (NSKeyedArchiver bplist).

Estrutura observada: ``{jid: {"dd": NSDate, "rd": NSDate, "pd": NSDate}}``
onde dd = entregue (delivered), rd = lido (read), pd = reproduzido (played).
"""
import plistlib

from .dates import timestamp

KEY_LABELS = {"dd": "delivered", "rd": "read", "pd": "played"}


def _unarchive(blob):
    plist = plistlib.loads(blob)
    objects = plist["$objects"]

    def resolve(obj, depth=0):
        if depth > 32:
            return None
        if isinstance(obj, plistlib.UID):
            return resolve(objects[obj.data], depth + 1)
        if isinstance(obj, dict):
            if "NS.keys" in obj and "NS.objects" in obj:
                return {
                    resolve(k, depth + 1): resolve(v, depth + 1)
                    for k, v in zip(obj["NS.keys"], obj["NS.objects"])
                }
            if "NS.time" in obj:
                return obj["NS.time"]
            if "NS.objects" in obj:
                return [resolve(v, depth + 1) for v in obj["NS.objects"]]
        return obj

    return resolve(plist["$top"]["root"])


def parse_receipts(blob):
    """Retorna lista de ``{"jid", "delivered", "read", "played"}`` ou []."""
    if not blob:
        return []
    try:
        data = _unarchive(blob)
    except Exception:  # blob corrompido/inesperado: ignora, dado é opcional
        return []
    if not isinstance(data, dict):
        return []
    out = []
    for jid, info in data.items():
        if not isinstance(info, dict):
            continue
        entry = {"jid": str(jid)}
        for key, label in KEY_LABELS.items():
            if key in info:
                entry[label] = timestamp(info[key])
        out.append(entry)
    return out
