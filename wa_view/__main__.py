"""CLI: ``python -m wa_view <export.zip|pasta> [--port 8000] [--workdir DIR]``."""
import argparse
import sys
import tempfile
import time
from pathlib import Path

from .extractor import extract
from .parser import ChatStore
from .server import serve
from .upload import AppState

DEFAULT_WORKDIR = Path(tempfile.gettempdir()) / "wa_view_extract"


def build_store(source, workdir=None, extra_media=()):
    workdir = Path(workdir) if workdir else DEFAULT_WORKDIR
    extraction = extract(source, workdir, extra_media)
    return ChatStore(extraction)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Visualizador forense de export do WhatsApp (iOS)")
    ap.add_argument("source", nargs="?",
                    help="arquivo .zip do export ou diretório já extraído (opcional: o ZIP pode ser enviado pela interface)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--workdir", help="diretório de extração (padrão: temp do sistema)")
    ap.add_argument(
        "--media", action="append", default=[], metavar="DIR",
        help="pasta extra com arquivos de mídia (pode repetir); vinculados pelo nome do arquivo",
    )
    ap.add_argument("--max-upload-mb", type=int, default=4096,
                    help="tamanho máximo do ZIP enviado pela interface, em MB (padrão 4096)")
    ap.add_argument("--uploads-dir", help="onde guardar ZIPs enviados pela interface (padrão: <workdir>/uploads)")
    ap.add_argument("--summary", action="store_true", help="só imprime o resumo da carga e sai")
    args = ap.parse_args(argv)

    store = None
    if args.source:
        t0 = time.time()
        try:
            store = build_store(args.source, args.workdir, args.media)
        except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
            print(f"[wa_view] erro: {exc}", file=sys.stderr)
            return 2
        s = store.summary()
        print(
            f"[wa_view] {s['chats']} chats ({s['groups']} grupos), {s['messages']} mensagens, "
            f"{s['media_linked']} mídias vinculadas, {s['contacts']} contatos "
            f"— carregado em {time.time() - t0:.1f}s",
            file=sys.stderr,
        )
        if args.summary:
            import json

            print(json.dumps(s, indent=2, ensure_ascii=False))
            return 0
    elif args.summary:
        ap.error("--summary exige o caminho do export")
    else:
        print("[wa_view] nenhum export informado: envie o .zip pela interface", file=sys.stderr)
    uploads = Path(args.uploads_dir) if args.uploads_dir else Path(args.workdir or DEFAULT_WORKDIR) / "uploads"
    state = AppState(store, uploads, args.max_upload_mb * 1024 ** 2, args.media)
    httpd = serve(state, args.host, args.port)
    print(f"[wa_view] http://{args.host}:{args.port}/", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
