"""Leitura de ChatStorage.sqlite / Contacts.sqlite (WhatsApp iOS, Core Data).

Produz um modelo em memória, serializável em JSON, com chats, participantes
e mensagens em ordem cronológica (``ZSORT``), já vinculados a contatos.
"""
import re
import sqlite3
from collections import defaultdict

from .dates import timestamp
from .extractor import sha256_file, sniff_mime
from .receipts import parse_receipts

# ZWAMESSAGE.ZMESSAGETYPE
MESSAGE_TYPES = {
    0: "text", 1: "image", 2: "video", 3: "audio", 4: "contact",
    5: "location", 6: "group_event", 7: "link", 8: "document", 10: "call",
    11: "gif", 14: "deleted", 15: "sticker",
}
# ZWAMESSAGE.ZMESSAGESTATUS (relevante para mensagens enviadas)
STATUS_LABELS = {
    0: "received", 1: "pending", 2: "sent", 3: "failed", 5: "played",
    6: "delivered", 8: "read",
}
# ZWAMESSAGE.ZGROUPEVENTTYPE
GROUP_EVENTS = {
    1: "created", 2: "member_added", 3: "member_removed", 4: "picture_changed",
    5: "settings_changed", 7: "admin_changed", 9: "member_promoted",
    10: "description_changed", 12: "subject_changed",
}

_ANON_SUFFIX = re.compile(r"~\d+")


def normalize_jid(jid):
    """Remove sufixos de anonimização (``~N``) para permitir correlação."""
    if not jid:
        return None
    return _ANON_SUFFIX.sub("", jid)


def jid_user(jid):
    jid = normalize_jid(jid)
    return jid.split("@", 1)[0] if jid else None


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


class ContactBook:
    """Índice de contatos (Contacts.sqlite) por identificador WhatsApp."""

    def __init__(self, path=None):
        self.by_wa_id = {}
        if path:
            self._load(path)

    def _load(self, path):
        conn = _connect(path)
        try:
            if not (_has_table(conn, "ZWAPHONE") and _has_table(conn, "ZWACONTACT")):
                return
            rows = conn.execute(
                """SELECT p.ZWHATSAPPID AS wa_id, p.ZPHONE AS phone, p.ZLABEL AS label,
                          c.ZFULLNAME AS full_name, c.ZFIRSTNAME AS first_name,
                          c.ZNICKNAME AS nickname, c.ZABUSERID AS ab_id
                   FROM ZWAPHONE p JOIN ZWACONTACT c ON c.Z_PK = p.ZCONTACT
                   WHERE p.ZWHATSAPPID IS NOT NULL"""
            )
            for r in rows:
                label = (r["label"] or "").replace("_$!<", "").replace(">!$_", "")
                self.by_wa_id.setdefault(
                    str(r["wa_id"]),
                    {
                        "full_name": r["full_name"],
                        "first_name": r["first_name"],
                        "nickname": r["nickname"],
                        "phone": r["phone"],
                        "phone_label": label or None,
                        "address_book_id": r["ab_id"],
                    },
                )
        finally:
            conn.close()

    def lookup(self, jid):
        user = jid_user(jid)
        return self.by_wa_id.get(user) if user else None


class ChatStore:
    def __init__(self, extraction):
        self.extraction = extraction
        self.contacts = ContactBook(extraction.contacts_db)
        self.chats = []
        self.chat_index = {}
        self.messages_by_chat = defaultdict(list)
        self.push_names = {}
        self._media_cache = {}
        self._load()

    # ------------------------------------------------------------------ load
    def _load(self):
        conn = _connect(self.extraction.chat_db)
        try:
            self._load_push_names(conn)
            members = self._load_members(conn)
            self._load_chats(conn, members)
            self._load_messages(conn, members)
        finally:
            conn.close()

    def _load_push_names(self, conn):
        if not _has_table(conn, "ZWAPROFILEPUSHNAME"):
            return
        for r in conn.execute("SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME"):
            if r["ZJID"] and r["ZPUSHNAME"]:
                self.push_names.setdefault(normalize_jid(r["ZJID"]), r["ZPUSHNAME"])

    def _load_members(self, conn):
        members = {}
        if not _has_table(conn, "ZWAGROUPMEMBER"):
            return members
        for r in conn.execute(
            "SELECT Z_PK, ZCHATSESSION, ZCONTACTNAME, ZFIRSTNAME, ZMEMBERJID, "
            "ZISACTIVE, ZISADMIN FROM ZWAGROUPMEMBER"
        ):
            members[r["Z_PK"]] = {
                "id": r["Z_PK"],
                "chat_id": r["ZCHATSESSION"],
                "jid": r["ZMEMBERJID"],
                "jid_normalized": normalize_jid(r["ZMEMBERJID"]),
                "name": self._display_name(r["ZMEMBERJID"], r["ZCONTACTNAME"]),
                "first_name": r["ZFIRSTNAME"],
                "active": bool(r["ZISACTIVE"]),
                "admin": bool(r["ZISADMIN"]),
                "contact": self.contacts.lookup(r["ZMEMBERJID"]),
            }
        return members

    def _display_name(self, jid, *candidates):
        for c in candidates:
            if c:
                return c
        contact = self.contacts.lookup(jid)
        if contact and (contact["full_name"] or contact["first_name"]):
            return contact["full_name"] or contact["first_name"]
        push = self.push_names.get(normalize_jid(jid))
        if push:
            return push
        user = jid_user(jid)
        return f"+{user}" if user else "Desconhecido"

    def _load_chats(self, conn, members):
        group_info = {}
        if _has_table(conn, "ZWAGROUPINFO"):
            for r in conn.execute(
                "SELECT ZCHATSESSION, ZCREATORJID, ZOWNERJID, ZCREATIONDATE, "
                "ZPICTUREPATH FROM ZWAGROUPINFO"
            ):
                group_info[r["ZCHATSESSION"]] = {
                    "creator_jid": r["ZCREATORJID"],
                    "owner_jid": r["ZOWNERJID"],
                    "created": timestamp(r["ZCREATIONDATE"]),
                    "picture_path": r["ZPICTUREPATH"],
                }
        members_by_chat = defaultdict(list)
        for m in members.values():
            members_by_chat[m["chat_id"]].append(m)

        cols = _columns(conn, "ZWACHATSESSION")
        optional = {c: (c if c in cols else "NULL") for c in ("ZARCHIVED", "ZREMOVED", "ZHIDDEN", "ZUNREADCOUNT", "ZMESSAGECOUNTER", "ZLASTMESSAGETEXT")}
        rows = conn.execute(
            f"""SELECT Z_PK, ZSESSIONTYPE, ZCONTACTJID, ZPARTNERNAME, ZLASTMESSAGEDATE,
                       {optional['ZARCHIVED']} AS ZARCHIVED, {optional['ZREMOVED']} AS ZREMOVED,
                       {optional['ZHIDDEN']} AS ZHIDDEN, {optional['ZUNREADCOUNT']} AS ZUNREADCOUNT,
                       {optional['ZMESSAGECOUNTER']} AS ZMESSAGECOUNTER,
                       {optional['ZLASTMESSAGETEXT']} AS ZLASTMESSAGETEXT
                FROM ZWACHATSESSION"""
        )
        for r in rows:
            jid = r["ZCONTACTJID"] or ""
            is_group = r["ZSESSIONTYPE"] == 1 or jid.endswith("@g.us")
            is_broadcast = jid.endswith("@broadcast")
            chat_type = "group" if is_group else ("broadcast" if is_broadcast else "individual")
            contact = None if is_group else self.contacts.lookup(jid)
            name = r["ZPARTNERNAME"] or self._display_name(jid)
            chat = {
                "id": r["Z_PK"],
                "type": chat_type,
                "jid": jid,
                "jid_normalized": normalize_jid(jid),
                "phone": None if is_group else jid_user(jid),
                "name": name,
                "contact": contact,
                "archived": bool(r["ZARCHIVED"]),
                "removed": bool(r["ZREMOVED"]),
                "hidden": bool(r["ZHIDDEN"]),
                "unread_count": r["ZUNREADCOUNT"] or 0,
                "message_counter": r["ZMESSAGECOUNTER"] or 0,
                "last_message_date": timestamp(r["ZLASTMESSAGEDATE"]),
                "last_message_text": r["ZLASTMESSAGETEXT"],
                "last_message": None,
                "message_count": 0,
                "participants": sorted(
                    members_by_chat.get(r["Z_PK"], []), key=lambda m: m["name"].lower()
                ),
                "group": group_info.get(r["Z_PK"]) if is_group else None,
            }
            self.chats.append(chat)
            self.chat_index[chat["id"]] = chat

    def _load_messages(self, conn, members):
        media = self._load_media_items(conn)
        link_meta = self._load_link_items(conn)
        receipts = self._load_receipts(conn)
        cols = _columns(conn, "ZWAMESSAGE")
        sel = lambda c: c if c in cols else f"NULL AS {c}"  # noqa: E731
        rows = conn.execute(
            f"""SELECT Z_PK, ZISFROMME, ZMESSAGESTATUS, ZMESSAGETYPE, ZSORT, ZCHATSESSION,
                       ZGROUPMEMBER, ZMEDIAITEM, ZMESSAGEDATE, ZSENTDATE, ZFROMJID, ZTOJID,
                       ZPUSHNAME, ZSTANZAID, ZTEXT, ZGROUPEVENTTYPE, ZFLAGS,
                       {sel('ZSTARRED')}, {sel('ZPARENTMESSAGE')}, {sel('ZMESSAGEERRORSTATUS')},
                       {sel('ZDOCID')}
                FROM ZWAMESSAGE ORDER BY ZCHATSESSION, ZSORT, Z_PK"""
        )
        for r in rows:
            chat = self.chat_index.get(r["ZCHATSESSION"])
            if chat is None:
                continue
            mtype = MESSAGE_TYPES.get(r["ZMESSAGETYPE"], f"unknown_{r['ZMESSAGETYPE']}")
            from_me = bool(r["ZISFROMME"])
            sender = self._resolve_sender(r, chat, members, from_me)
            msg = {
                "id": r["Z_PK"],
                "chat_id": chat["id"],
                "sort": r["ZSORT"],
                "from_me": from_me,
                "type": mtype,
                "type_code": r["ZMESSAGETYPE"],
                "text": r["ZTEXT"],
                "timestamp": timestamp(r["ZMESSAGEDATE"]),
                "sent_timestamp": timestamp(r["ZSENTDATE"]),
                "status": STATUS_LABELS.get(r["ZMESSAGESTATUS"], f"unknown_{r['ZMESSAGESTATUS']}"),
                "status_code": r["ZMESSAGESTATUS"],
                "error_status": r["ZMESSAGEERRORSTATUS"],
                "sender": sender,
                "from_jid": r["ZFROMJID"],
                "to_jid": r["ZTOJID"],
                "push_name": r["ZPUSHNAME"],
                "stanza_id": r["ZSTANZAID"],
                "flags": r["ZFLAGS"],
                "starred": bool(r["ZSTARRED"]),
                "parent_id": r["ZPARENTMESSAGE"],
                "media": media.get(r["ZMEDIAITEM"]) if r["ZMEDIAITEM"] else None,
                "link": link_meta.get(r["Z_PK"]),
                "receipts": receipts.get(r["Z_PK"], []),
                "group_event": None,
            }
            if mtype == "group_event":
                msg["group_event"] = self._group_event(r, chat)
            self.messages_by_chat[chat["id"]].append(msg)

        for chat in self.chats:
            msgs = self.messages_by_chat.get(chat["id"], [])
            chat["message_count"] = len(msgs)
            chat["last_message"] = self._preview(msgs[-1]) if msgs else None
        # Ordem da lista lateral: igual ao WhatsApp, mais recente primeiro.
        self.chats.sort(key=lambda c: -(self._chat_sort_key(c)))

    def _chat_sort_key(self, chat):
        lm = chat["last_message"]
        if lm and lm.get("timestamp"):
            return lm["timestamp"]["unix"]
        if chat["last_message_date"]:
            return chat["last_message_date"]["unix"]
        return 0

    def _resolve_sender(self, row, chat, members, from_me):
        if from_me:
            return {"jid": None, "name": "Você", "is_me": True}
        if chat["type"] == "group":
            member = members.get(row["ZGROUPMEMBER"]) if row["ZGROUPMEMBER"] else None
            if member:
                return {
                    "jid": member["jid"], "name": member["name"], "is_me": False,
                    "member_id": member["id"], "contact": member["contact"],
                }
            name = row["ZPUSHNAME"] or "Participante desconhecido"
            return {"jid": None, "name": name, "is_me": False, "unresolved": True}
        return {
            "jid": row["ZFROMJID"] or chat["jid"], "name": chat["name"], "is_me": False,
            "contact": chat["contact"],
        }

    def _group_event(self, row, chat):
        code = row["ZGROUPEVENTTYPE"]
        kind = GROUP_EVENTS.get(code, f"event_{code}")
        actor = self._display_name(row["ZTOJID"]) if row["ZTOJID"] else None
        text = row["ZTEXT"]
        subject_kinds = {"created", "subject_changed", "description_changed"}
        target = None
        if text and kind not in subject_kinds and "@" in text:
            target = self._display_name(text)
        return {
            "kind": kind,
            "code": code,
            "actor": actor,
            "actor_jid": row["ZTOJID"],
            "target": target,
            "target_jid": text if target else None,
            "subject": text if kind in subject_kinds else None,
        }

    def _load_media_items(self, conn):
        media = {}
        if not _has_table(conn, "ZWAMEDIAITEM"):
            return media
        cols = _columns(conn, "ZWAMEDIAITEM")
        sel = lambda c: c if c in cols else f"NULL AS {c}"  # noqa: E731
        rows = conn.execute(
            f"""SELECT Z_PK, ZMESSAGE, ZFILESIZE, ZMOVIEDURATION, ZMEDIALOCALPATH,
                       ZTHUMBNAILLOCALPATH, ZMEDIAURL, ZTITLE, ZVCARDNAME, ZVCARDSTRING,
                       ZLATITUDE, ZLONGITUDE, {sel('ZMEDIAORIGIN')}, {sel('ZCLOUDSTATUS')},
                       {sel('ZMEDIAKEY')}
                FROM ZWAMEDIAITEM"""
        )
        for r in rows:
            path = self.extraction.resolve_media(r["ZMEDIALOCALPATH"])
            media[r["Z_PK"]] = {
                "id": r["Z_PK"],
                "local_path": r["ZMEDIALOCALPATH"],
                "thumbnail_path": r["ZTHUMBNAILLOCALPATH"],
                "available": path is not None,
                "url": f"/media/{r['Z_PK']}" if path else None,
                "mime": sniff_mime(path) if path else None,
                "filename": path.name if path else None,
                "declared_size": r["ZFILESIZE"],
                "actual_size": path.stat().st_size if path else None,
                "duration": r["ZMOVIEDURATION"],
                "remote_url": r["ZMEDIAURL"],
                "title": r["ZTITLE"],
                "vcard_name": r["ZVCARDNAME"],
                "vcard": r["ZVCARDSTRING"],
                "latitude": r["ZLATITUDE"] if r["ZLATITUDE"] else None,
                "longitude": r["ZLONGITUDE"] if r["ZLONGITUDE"] else None,
                "origin": r["ZMEDIAORIGIN"],
                "cloud_status": r["ZCLOUDSTATUS"],
                "has_media_key": r["ZMEDIAKEY"] is not None,
                "sha256": None,  # calculado sob demanda (ver media_hash)
            }
            if path:
                self._media_cache[r["Z_PK"]] = path
        return media

    def _load_link_items(self, conn):
        links = {}
        if not _has_table(conn, "ZWAMESSAGEDATAITEM"):
            return links
        for r in conn.execute(
            "SELECT ZMESSAGE, ZCONTENT1, ZCONTENT2, ZTITLE, ZSUMMARY, ZTYPE FROM ZWAMESSAGEDATAITEM"
        ):
            links.setdefault(
                r["ZMESSAGE"],
                {"url": r["ZCONTENT1"], "canonical": r["ZCONTENT2"], "title": r["ZTITLE"],
                 "summary": r["ZSUMMARY"], "type": r["ZTYPE"]},
            )
        return links

    def _load_receipts(self, conn):
        receipts = {}
        if not _has_table(conn, "ZWAMESSAGEINFO"):
            return receipts
        for r in conn.execute("SELECT ZMESSAGE, ZRECEIPTINFO FROM ZWAMESSAGEINFO"):
            parsed = parse_receipts(r["ZRECEIPTINFO"])
            if parsed:
                receipts[r["ZMESSAGE"]] = parsed
        return receipts

    @staticmethod
    def _preview(msg):
        kind = msg["type"]
        text = msg["text"]
        if kind == "group_event":
            text = None
        return {
            "type": kind,
            "text": text,
            "from_me": msg["from_me"],
            "status": msg["status"],
            "sender_name": msg["sender"]["name"],
            "timestamp": msg["timestamp"],
        }

    # ------------------------------------------------------------------- api
    def summary(self):
        return {
            "chats": len(self.chats),
            "groups": sum(1 for c in self.chats if c["type"] == "group"),
            "messages": sum(len(m) for m in self.messages_by_chat.values()),
            "media_linked": len(self._media_cache),
            "contacts": len(self.contacts.by_wa_id),
            "integrity": self.extraction.integrity,
        }

    def chat_list(self):
        return [
            {k: v for k, v in c.items() if k not in ("participants", "group", "contact")}
            | {"participant_count": len(c["participants"])}
            for c in self.chats
        ]

    def chat(self, chat_id):
        return self.chat_index.get(chat_id)

    def messages(self, chat_id):
        return self.messages_by_chat.get(chat_id, [])

    def media_path(self, media_id):
        return self._media_cache.get(media_id)

    def media_hash(self, media_id):
        path = self._media_cache.get(media_id)
        return sha256_file(path) if path else None
