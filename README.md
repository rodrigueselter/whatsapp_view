# whatsapp_view

Visualizador forense (somente leitura) de exports do WhatsApp iOS, com
interface que reproduz o layout do WhatsApp Web.

## O que é lido

| Arquivo no export | Uso |
| --- | --- |
| `ChatStorage*.sqlite` | sessões de chat, mensagens, membros de grupo, mídias, recibos de entrega/leitura |
| `Contacts*.sqlite` | agenda (nome completo, telefone, rótulo) vinculada por identificador WhatsApp |
| `CallHistory*.sqlite` | histórico de chamadas (atendidas, efetuadas, perdidas, recusadas, duração, participantes), quando presente no export |
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

Abra `http://127.0.0.1:8000/`. Opções:

- `--workdir DIR` diretório de extração (padrão: `<temp>/wa_view_extract`); uma
  pasta já extraída também pode ser passada no lugar do ZIP;
- `--media DIR` pasta extra com arquivos de mídia (pode ser repetida). Use
  quando o ZIP não traz todas as mídias referenciadas no banco, por exemplo
  apontando para a pasta `Message/Media` de uma extração completa do aparelho;
- `--summary` apenas imprime o resumo da carga (contagens e SHA-256) e sai;
- `--host` endereço de escuta (padrão `127.0.0.1`).

## Interface

- **Painel lateral**: lista de conversas ordenada pela última mensagem, busca
  por nome/telefone/JID, filtro grupos/individuais, prévia da última mensagem
  com ícone de mídia e status de envio, contador de não lidas.
- **Conversa**: balões de envio/recebimento com cauda, separadores de data,
  nome colorido do remetente em grupos, status (relógio / ✓ / ✓✓ / ✓✓ azul),
  imagens (com lightbox), vídeos, áudios (player), vCards, localização, links
  com prévia, eventos de grupo e chamadas (cartão com ícone, horário e, quando
  o `CallHistory.sqlite` existe, resultado e duração). Mídias ausentes no
  export são exibidas como placeholder com nome e tamanho declarados. O aviso
  de ativação da criptografia de ponta a ponta fica oculto por padrão (não é
  chamada nem mensagem); pode ser exibido pelo menu ⋮ → Exibição, e sua data
  continua nos dados do contato/grupo.
- **Chamadas** (ícone de telefone no cabeçalho da barra lateral): histórico
  consolidado, mais recentes primeiro, agrupado por dia, com ranking dos
  contatos mais frequentes e busca por nome/telefone/JID/ID da chamada. Une
  os registros do `CallHistory.sqlite` (atendidas, efetuadas, perdidas,
  recusadas, com duração) aos avisos de chamada perdida embutidos nas
  conversas; a mesma chamada presente nos dois lugares (mesmo ID) aparece uma
  vez, com o registro completo. Clicar em uma chamada abre a conversa, rola
  até o aviso correspondente e exibe os dados da chamada.
- **Apoio forense** (discreto, no painel direito):
  - clique em qualquer mensagem: `Z_PK`, `ZSORT`, tipo/status com códigos
    brutos, timestamps (local, UTC ISO e valor bruto), `ZSTANZAID`,
    `ZFROMJID`/`ZTOJID`, push name, recibos por destinatário (entregue /
    lido / reproduzido, decodificados de `ZRECEIPTINFO`), metadados da mídia
    (caminho original, MIME detectado por conteúdo, tamanho declarado × real,
    SHA-256 sob demanda);
  - registro de chamada: tipo (voz/vídeo), resultado, direção, início/fim,
    duração, interlocutor com JID, JID do titular, grupo e criador da chamada,
    ID da chamada, bytes enviados/recebidos, participantes com resultado
    individual e os códigos brutos (`ZMESSAGETYPE`/`ZGROUPEVENTTYPE`,
    `ZOUTCOME`, `ZINCOMING`, `ZVIDEO`, `ZMISSED`) que fundamentam a
    interpretação;
  - cabeçalho da conversa: JID bruto/normalizado, flags da sessão, dados da
    agenda, participantes com JID e status de admin, criador/dono do grupo;
  - menu ⋮ do painel lateral: contagens da carga (inclusive chamadas e avisos
    de criptografia), JID do titular inferido e SHA-256 do ZIP e dos bancos.

## Observações sobre o export analisado

- Muitos `ZMESSAGEDATE`/`ZSENTDATE` estão truncados para 5 dígitos. O
  visualizador reconstitui a data (×10⁴) e marca o horário com `~` /
  `(aprox.)`; a janela de incerteza é de ~2h47min. A ordem cronológica vem de
  `ZSORT`, que não é afetado.
- JIDs trazem sufixos de anonimização (`~N`). São exibidos brutos nos
  detalhes e normalizados para correlação com agenda e membros de grupo.
- O banco referencia 2.984 arquivos de mídia, mas o ZIP traz só 230
  (63 de 1.136 imagens, 0 de 113 vídeos, 170 de 1.735 áudios). Os demais
  aparecem como "não incluído no export", com nome e tamanho declarados.
  Para exibi-los é preciso obter os arquivos originais e usar `--media`.
- Arquivos `.aac` do export são, na prática, Ogg/Opus; o MIME é detectado
  pelo conteúdo para que o navegador reproduza corretamente.

### Chamadas

O WhatsApp iOS guarda as chamadas em dois lugares:

1. **`CallHistory.sqlite`** (banco separado, no container compartilhado do
   app): todas as chamadas, atendidas ou não, com duração e participantes. É
   lido automaticamente quando está no ZIP/pasta. Esquema reconhecido (cada
   coluna é verificada antes de ser lida, pois varia entre versões):
   `ZWACDCALLEVENT` (`ZDATE`, `ZDURATION`, `ZOUTCOME`, `ZCALLIDSTRING`,
   `ZGROUPJIDSTRING`, `ZGROUPCALLCREATORUSERJIDSTRING`, `ZBYTESSENT`,
   `ZBYTESRECEIVED`, `ZVIDEO`, `Z1CALLEVENTS`), `ZWAAGGREGATECALLEVENT`
   (`ZINCOMING`, `ZMISSED`, `ZMISSEDREASON`, `ZVIDEO`) e
   `ZWACDCALLEVENTPARTICIPANT` (`ZJIDSTRING`, `ZOUTCOME`). Códigos de
   `ZOUTCOME`, conforme parsers forenses públicos (iLEAPP,
   WhatsApp-Chat-Exporter): 0 atendida/encerrada, 1 perdida, 2 falhou,
   4 recusada; outros valores são exibidos como "resultado N". A direção vem
   de `ZINCOMING` ou, na falta dele, de quem criou a chamada versus o JID do
   titular.
2. **Avisos de chamada perdida em `ChatStorage.sqlite`** (`ZWAMESSAGE`,
   `ZMESSAGETYPE = 10`): só chamadas não atendidas viram "mensagem" na
   conversa; chamadas atendidas e efetuadas nunca aparecem ali.

**O export analisado não traz `CallHistory.sqlite`**, logo nele só há os
avisos do item 2: todos com `ZMESSAGETYPE = 10`, `ZISFROMME = 0`, `ZTEXT`
vazio e `ZTOJID` igual ao JID do titular. O subtipo fica em `ZGROUPEVENTTYPE`
e foi interpretado a partir do próprio export:

| `ZGROUPEVENTTYPE` | Qtd. | Interpretação | Evidência |
| --- | --- | --- | --- |
| 1 | 11 | chamada de voz perdida (recebida e não atendida) | ocorrem em horários dispersos, repetem-se no mesmo contato e são seguidas de textos como "só agora que vi suas ligações" |
| 2 | 140 | ativação da criptografia de ponta a ponta na conversa | exatamente um por conversa (140 das 163); 92 deles concentrados em 05–07/04/2016, data do lançamento do E2E no WhatsApp; nas conversas criadas depois, coincide com a primeira mensagem |

Versões anteriores do visualizador exibiam todos os 151 registros como
"Chamada". Agora só o subtipo 1 entra no histórico de chamadas; o subtipo 2 é
tratado como aviso de sistema, oculto por padrão. Outros subtipos, se aparecerem em outro export
(ex.: chamadas de vídeo, lançadas em novembro de 2016, depois do período deste
banco), são exibidos como "aviso do sistema não interpretado" com os códigos
brutos, e contados separadamente no menu ⋮.

Observações úteis para a análise:

- `ZSTANZAID` das chamadas perdidas é o identificador da chamada (18 caracteres
  hexadecimais), diferente dos IDs de mensagem;
- `ZMESSAGEDATE` desses registros tem precisão total (não sofreu o truncamento
  que afeta as demais mensagens), portanto o horário exibido é exato;
- o JID do titular é inferido como o `ZTOJID` mais frequente entre as mensagens
  recebidas e exibido no menu ⋮ e nos detalhes de cada chamada;
- em grupos o banco guarda apenas o JID do grupo como origem, por isso o
  interlocutor individual de uma chamada em grupo não pode ser identificado.

## Estrutura

```
wa_view/
  __main__.py   CLI
  extractor.py  extração segura do ZIP, índice de mídias, SHA-256, sniff de MIME
  parser.py     leitura dos bancos → modelo (chats, participantes, mensagens)
  receipts.py   decodificação de ZRECEIPTINFO (NSKeyedArchiver)
  calls.py      leitura de CallHistory.sqlite (tolerante a variações de esquema)
  dates.py      conversão de datas Core Data (inclui datas truncadas)
  server.py     servidor HTTP (stdlib) — API JSON (/api/chats, /api/calls, ...), mídias com Range, estáticos
  static/       index.html, style.css, app.js, icons.js (frontend sem dependências)
```
