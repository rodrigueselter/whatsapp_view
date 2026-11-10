"""Conversão de datas Core Data (segundos desde 2001-01-01 UTC).

Alguns exports anonimizados truncam o timestamp para os 5 primeiros
dígitos (ex.: ``47777`` em vez de ``477784102.3``). Nesses casos a
data é reconstituída multiplicando por 10**4, o que dá uma janela de
~2h47min de incerteza; o resultado é marcado como ``approx``.
"""
from datetime import datetime, timezone

CORE_DATA_EPOCH = 978307200  # 2001-01-01T00:00:00Z em Unix time
TRUNCATION_LIMIT = 1_000_000
TRUNCATION_FACTOR = 10_000


def core_to_unix(value):
    """Retorna (unix_seconds, approx) ou (None, False)."""
    if value is None:
        return None, False
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None, False
    if value <= 0:
        return None, False
    approx = False
    if value < TRUNCATION_LIMIT:
        value *= TRUNCATION_FACTOR
        approx = True
    return value + CORE_DATA_EPOCH, approx


def to_iso(unix_seconds):
    if unix_seconds is None:
        return None
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).isoformat(timespec="seconds")


def timestamp(value):
    """Estrutura serializável com unix, iso e flag de aproximação."""
    unix, approx = core_to_unix(value)
    if unix is None:
        return None
    return {
        "unix": round(unix, 3),
        "iso": to_iso(unix),
        "approx": approx,
        "window_seconds": TRUNCATION_FACTOR if approx else 0,
        "raw": value,
    }
