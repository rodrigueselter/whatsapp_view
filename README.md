# whatsapp_view

Visualizador forense (somente leitura) de exports do WhatsApp iOS, com
interface que reproduz o layout do WhatsApp Web.

## O que é lido

| Arquivo no export | Uso |
| --- | --- |
| `ChatStorage*.sqlite` | sessões de chat, mensagens, membros de grupo, mídias, recibos de entrega/leitura |
| `Contacts*.sqlite` | agenda (nome completo, telefone, rótulo) vinculada por identificador WhatsApp |
| `Media/**` | arquivos de mídia, vinculados às mensagens pelo nome do arquivo (hash) |

O ZIP é extraído para um diretório de trabalho; os bancos são abertos em modo
somente leitura (`immutable=1`). Nada é gravado de volta no export.

## Execução

Requer apenas Python 3.9+ (sem dependências externas).

Linux / macOS:

```bash
python3 -m wa_view caminho/para/export.zip --port 8000
```

Windows (PowerShell), dentro da pasta do repositório:

```powershell
py -m wa_view "C:\caminho\para\export.zip" --port 8000
```

No Windows, `python3` costuma abrir o atalho da Microsoft Store. Use o
inicializador `py` (instalado junto com o Python de python.org) ou `python`.
Se nenhum funcionar, instale o Python 3 marcando "Add python.exe to PATH".

O caminho do export é opcional: sem ele, o servidor sobe vazio e o `.zip`
é enviado pela própria interface (botão de upload ou arrastar o arquivo para a
janela).

```bash
python3 -m wa_view --port 8000
```

Abra `http://127.0.0.1:8000/`. Opções:

- `--workdir DIR` diretório de extração (padrão: `<temp>/wa_view_extract`); uma
  pasta já extraída também pode ser passada no lugar do ZIP;
- `--media DIR` pasta extra com arquivos de mídia (pode ser repetida). Use
  quando o ZIP não traz todas as mídias referenciadas no banco, por exemplo
  apontando para a pasta `Message/Media` de uma extração completa do aparelho;
- `--max-upload-mb N` tamanho máximo do ZIP aceito pela interface (padrão 4096);
- `--uploads-dir DIR` onde guardar o ZIP recebido e sua extração (padrão
  `<workdir>/uploads`; o upload anterior é removido quando um novo é carregado);
- `--summary` apenas imprime o resumo da carga (contagens e SHA-256) e sai;
- `--host` endereço de escuta (padrão `127.0.0.1`).

## Interface

- **Painel lateral**: lista de conversas ordenada pela última mensagem, busca
  por nome/telefone/JID, filtro grupos/individuais, prévia da última mensagem
  com ícone de mídia e status de envio, contador de não lidas.
- **Conversa**: balões de envio/recebimento com cauda, separadores de data,
  nome colorido do remetente em grupos, status (relógio / ✓ / ✓✓ / ✓✓ azul),
  imagens (com lightbox), vídeos, áudios (player), vCards, localização, links
  com prévia, eventos de grupo e chamadas. Mídias ausentes no export são
  exibidas como placeholder com nome e tamanho declarados.
- **Apoio forense** (discreto, no painel direito):
  - clique em qualquer mensagem: `Z_PK`, `ZSORT`, tipo/status com códigos
    brutos, timestamps (local, UTC ISO e valor bruto), `ZSTANZAID`,
    `ZFROMJID`/`ZTOJID`, push name, recibos por destinatário (entregue /
    lido / reproduzido, decodificados de `ZRECEIPTINFO`), metadados da mídia
    (caminho original, MIME detectado por conteúdo, tamanho declarado × real,
    SHA-256 sob demanda);
  - cabeçalho da conversa: JID bruto/normalizado, flags da sessão, dados da
    agenda, participantes com JID e status de admin, criador/dono do grupo;
  - menu ⋮ do painel lateral: contagens da carga e SHA-256 do ZIP e dos bancos.

## Upload pela interface

O arquivo é enviado em fluxo para o servidor, com SHA-256 calculado durante a
recepção. Antes de substituir o export ativo, o servidor valida:

- extensão `.zip`, tamanho máximo e assinatura do arquivo;
- caminhos das entradas (bloqueia path traversal), links simbólicos (ignorados),
  ZIP com senha, taxa de compressão suspeita e volume real descompactado;
- CRC de cada entrada e a presença do banco `ChatStorage.sqlite`.

Erros retornam mensagem legível (400, 409, 411, 413, 415 ou 422) e nenhum
arquivo parcial fica em disco.

## Análise forense de mídias

Botão de gráfico no painel lateral (ou "Galeria e análise forense desta
conversa" nos dados do chat):

- **Integridade de cada mídia**: `Íntegra`, `Ausente` (referenciada no banco,
  não incluída no export) ou `Corrompida / divergente` (vazia, truncada, tipo
  de conteúdo incompatível ou tamanho diferente do declarado em `ZFILESIZE`).
  Extensão diferente do conteúdo é registrada como aviso;
- **indicadores**: totais por situação, volume declarado × presente, período;
- **por tipo**: contagens e volume, com barra de situação;
- **linha do tempo mensal** empilhada por tipo, com dica por mês e tabela;
- **por conversa e por participante**: quantidades, situação e volume;
- **galeria filtrável** por situação e tipo, com visualizador (imagem, vídeo,
  áudio, PDF/documento ou ficha da mídia ausente), navegação por setas,
  metadados, SHA-256 sob demanda, download do original e "abrir na conversa".

Na lista de conversas, o filtro **Com mídia** isola as conversas com mídias, e
cada uma mostra `disponíveis/total` (com alerta quando há divergentes).

API: `GET /api/status`, `POST /api/upload`, `GET /api/media-summary[?chat=]`,
`GET /api/media-items?chat=&status=ok,missing,corrupted&kind=&offset=&limit=`.

## Observações sobre o export analisado

- Muitos `ZMESSAGEDATE`/`ZSENTDATE` estão truncados para 5 dígitos. O
  visualizador reconstitui a data (×10⁴) e marca o horário com `~` /
  `(aprox.)`; a janela de incerteza é de ~2h47min. A ordem cronológica vem de
  `ZSORT`, que não é afetado.
- JIDs trazem sufixos de anonimização (`~N`). São exibidos brutos nos
  detalhes e normalizados para correlação com agenda e membros de grupo.
- O banco referencia 3.006 mídias de arquivo, mas o ZIP traz só 233 delas
  (223 íntegras e 10 imagens com tamanho divergente do declarado).
  Nenhum dos 114 vídeos está no ZIP. Os demais
  aparecem como "não incluído no export", com nome e tamanho declarados.
  Para exibi-los é preciso obter os arquivos originais e usar `--media`.
- Arquivos `.aac` do export são, na prática, Ogg/Opus; o MIME é detectado
  pelo conteúdo para que o navegador reproduza corretamente.

## Estrutura

```
wa_view/
  __main__.py   CLI
  extractor.py  extração segura do ZIP (limites, CRC), índice de mídias, SHA-256, MIME
  upload.py     recebimento do .zip pela interface e troca do export ativo
  media_analysis.py  integridade, filtros e sumarização das mídias
  parser.py     leitura dos bancos → modelo (chats, participantes, mensagens)
  receipts.py   decodificação de ZRECEIPTINFO (NSKeyedArchiver)
  dates.py      conversão de datas Core Data (inclui datas truncadas)
  server.py     servidor HTTP (stdlib) — API JSON, mídias com Range, estáticos
  static/       index.html, style.css, app.js, media.js, icons.js (frontend sem dependências)
```
