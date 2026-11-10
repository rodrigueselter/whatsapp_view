"""CLI: ``python -m wa_view <export.zip|pasta> [--port 8000] [--workdir DIR]``."""
import argparse
import sys
import tempfile
import time
from pathlib import Path

from .extractor import extract
from .parser import ChatStore
from .server import serve


def build_store(source, workdir=None):
    workdir = Path(workdir) if workdir else Path(tempfile.gettempdir()) / "wa_view_extract"
    extraction = extract(source, workdir)
    return ChatStore(extraction)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Visualizador forense de export do WhatsApp (iOS)")
    ap.add_argument("source", help="arquivo .zip do export ou diretório já extraído")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--workdir", help="diretório de extração (padrão: temp do sistema)")
    ap.add_argument("--summary", action="store_true", help="só imprime o resumo da carga e sai")
    args = ap.parse_args(argv)

    t0 = time.time()
    store = build_store(args.source, args.workdir)
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
    httpd = serve(store, args.host, args.port)
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
