"""Leitura de CallHistory.sqlite (WhatsApp iOS).

Banco separado do ChatStorage, onde ficam todas as chamadas: atendidas,
efetuadas, perdidas e recusadas, com duração, direção, vídeo/voz e
participantes. O esquema varia entre versões do aplicativo, por isso cada
coluna é verificada antes de ser lida (ausente -> NULL).

Tabelas e colunas conhecidas (parsers públicos: iLEAPP, WhatsApp-Chat-Exporter):
  ZWACDCALLEVENT             evento de chamada: ZDATE, ZDURATION, ZOUTCOME,
                             ZCALLIDSTRING, ZGROUPJIDSTRING,
                             ZGROUPCALLCREATORUSERJIDSTRING, ZBYTESSENT,
                             ZBYTESRECEIVED, ZVIDEO (versões recentes),
                             Z1CALLEVENTS / ZAGGREGATECALLEVENT (-> agregado)
  ZWAAGGREGATECALLEVENT      resumo: ZINCOMING, ZMISSED, ZMISSEDREASON, ZVIDEO
  ZWACDCALLEVENTPARTICIPANT  participantes: Z1PARTICIPANTS (-> evento),
                             ZJIDSTRING, ZOUTCOME
"""
import sqlite3

from .dates import timestamp

# ZWACDCALLEVENT.ZOUTCOME. 0/1/4 conforme iLEAPP; 2 conforme WhatsApp-Chat-Exporter.
OUTCOMES = {0: "ended", 1: "missed", 2: "failed", 4: "rejected"}

EVENT_TABLE = "ZWACDCALLEVENT"
AGGREGATE_TABLE = "ZWAAGGREGATECALLEVENT"
PARTICIPANT_TABLE = "ZWACDCALLEVENTPARTICIPANT"


def _connect(path):
    conn = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _columns(conn, table):
    return {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}


def _has_table(conn, table):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def _first(cols, *candidates):
    return next((c for c in candidates if c in cols), None)


def load_call_history(path):
    """Lê o banco e devolve a lista bruta de chamadas (sem resolução de nomes)."""
    conn = _connect(path)
    try:
        if not _has_table(conn, EVENT_TABLE):
            return []
        ev_cols = _columns(conn, EVENT_TABLE)
        has_agg = _has_table(conn, AGGREGATE_TABLE)
        agg_cols = _columns(conn, AGGREGATE_TABLE) if has_agg else set()
        agg_fk = _first(ev_cols, "Z1CALLEVENTS", "ZAGGREGATECALLEVENT")
        use_agg = has_agg and agg_fk is not None

        def ev(c):
            return f"e.{c}" if c in ev_cols else "NULL"

        def ag(c):
            return f"a.{c}" if use_agg and c in agg_cols else "NULL"

        join = f"LEFT JOIN {AGGREGATE_TABLE} a ON a.Z_PK = e.{agg_fk}" if use_agg else ""
        rows = conn.execute(
            f"""SELECT e.Z_PK AS pk, {ev('ZDATE')} AS date, {ev('ZDURATION')} AS duration,
                       {ev('ZOUTCOME')} AS outcome, {ev('ZCALLIDSTRING')} AS call_id,
                       {ev('ZGROUPJIDSTRING')} AS group_jid,
                       {ev('ZGROUPCALLCREATORUSERJIDSTRING')} AS creator_jid,
                       {ev('ZBYTESSENT')} AS bytes_sent, {ev('ZBYTESRECEIVED')} AS bytes_received,
                       {ev('ZVIDEO')} AS video_event, {ag('ZVIDEO')} AS video_aggregate,
                       {ag('ZINCOMING')} AS incoming, {ag('ZMISSED')} AS missed,
                       {ag('ZMISSEDREASON')} AS missed_reason,
                       {ev(agg_fk) if agg_fk else 'NULL'} AS aggregate_id
                FROM {EVENT_TABLE} e {join}
                ORDER BY date, e.Z_PK"""
        ).fetchall()

        participants = {}
        if _has_table(conn, PARTICIPANT_TABLE):
            p_cols = _columns(conn, PARTICIPANT_TABLE)
            p_fk = _first(p_cols, "Z1PARTICIPANTS", "ZCALLEVENT")
            if p_fk and "ZJIDSTRING" in p_cols:
                p_outcome = "ZOUTCOME" if "ZOUTCOME" in p_cols else "NULL"
                for r in conn.execute(
                    f"SELECT Z_PK, {p_fk} AS call_pk, ZJIDSTRING AS jid, {p_outcome} AS outcome "
                    f"FROM {PARTICIPANT_TABLE} ORDER BY Z_PK"
                ):
                    participants.setdefault(r["call_pk"], []).append({
                        "id": r["Z_PK"],
                        "jid": r["jid"],
                        "outcome_code": r["outcome"],
                        "outcome": _outcome(r["outcome"]),
                    })

        calls = []
        for r in rows:
            video = r["video_event"] if r["video_event"] is not None else r["video_aggregate"]
            duration = float(r["duration"]) if r["duration"] is not None else None
            outcome_code = r["outcome"]
            outcome = _outcome(outcome_code)
            if outcome is None and r["missed"] is not None:
                outcome = "missed" if r["missed"] else "ended"
            end = None
            if r["date"] is not None and duration:
                end = timestamp(float(r["date"]) + duration)
            calls.append({
                "id": r["pk"],
                "call_id": r["call_id"],
                "timestamp": timestamp(r["date"]),
                "end_timestamp": end,
                "duration": duration,
                "outcome": outcome,
                "outcome_code": outcome_code,
                "kind": "video" if video else ("voice" if video is not None else "unknown"),
                "video_raw": video,
                "incoming_raw": r["incoming"],
                "missed_raw": r["missed"],
                "missed_reason": r["missed_reason"],
                "group_jid": r["group_jid"],
                "creator_jid": r["creator_jid"],
                "bytes_sent": r["bytes_sent"],
                "bytes_received": r["bytes_received"],
                "aggregate_id": r["aggregate_id"],
                "participants": participants.get(r["pk"], []),
            })
        return calls
    finally:
        conn.close()


def _outcome(code):
    if code is None:
        return None
    return OUTCOMES.get(code, f"unknown_{code}")
