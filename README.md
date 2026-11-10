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
  com prévia, eventos de grupo, chamadas perdidas (cartão com ícone vermelho e
  horário) e o aviso de ativação da criptografia de ponta a ponta (mensagem de
  sistema amarela com cadeado). Mídias ausentes no export são exibidas como
  placeholder com nome e tamanho declarados.
- **Chamadas** (ícone de telefone no cabeçalho da barra lateral): histórico
  consolidado de todas as chamadas registradas nas conversas, mais recentes
  primeiro, agrupado por dia, com ranking dos contatos mais frequentes e busca
  por nome/telefone/JID/ID da chamada. Clicar em uma chamada abre a conversa,
  rola até o registro e exibe seus dados.
- **Apoio forense** (discreto, no painel direito):
  - clique em qualquer mensagem: `Z_PK`, `ZSORT`, tipo/status com códigos
    brutos, timestamps (local, UTC ISO e valor bruto), `ZSTANZAID`,
    `ZFROMJID`/`ZTOJID`, push name, recibos por destinatário (entregue /
    lido / reproduzido, decodificados de `ZRECEIPTINFO`), metadados da mídia
    (caminho original, MIME detectado por conteúdo, tamanho declarado × real,
    SHA-256 sob demanda);
  - registro de chamada: tipo (voz), direção, interlocutor com JID, JID do
    titular, ID da chamada (`ZSTANZAID`) e os códigos brutos
    `ZMESSAGETYPE`/`ZGROUPEVENTTYPE` que fundamentam a interpretação;
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

### Chamadas (`ZMESSAGETYPE = 10`)

O export não traz `CallHistory.sqlite`, logo não há registro de chamadas
atendidas, duração ou participantes de chamadas em grupo. O que existe são os
avisos embutidos nas conversas, todos com `ZMESSAGETYPE = 10`, `ZISFROMME = 0`,
`ZTEXT` vazio e `ZTOJID` igual ao JID do titular. O subtipo fica em
`ZGROUPEVENTTYPE` e foi interpretado a partir do próprio export:

| `ZGROUPEVENTTYPE` | Qtd. | Interpretação | Evidência |
| --- | --- | --- | --- |
| 1 | 11 | chamada de voz perdida (recebida e não atendida) | ocorrem em horários dispersos, repetem-se no mesmo contato e são seguidas de textos como "só agora que vi suas ligações" |
| 2 | 140 | ativação da criptografia de ponta a ponta na conversa | exatamente um por conversa (140 das 163); 92 deles concentrados em 05–07/04/2016, data do lançamento do E2E no WhatsApp; nas conversas criadas depois, coincide com a primeira mensagem |

Versões anteriores do visualizador exibiam todos os 151 registros como
"Chamada". Agora só o subtipo 1 entra no histórico de chamadas; o subtipo 2 é
mostrado como aviso de sistema. Outros subtipos, se aparecerem em outro export
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
  dates.py      conversão de datas Core Data (inclui datas truncadas)
  server.py     servidor HTTP (stdlib) — API JSON (/api/chats, /api/calls, ...), mídias com Range, estáticos
  static/       index.html, style.css, app.js, icons.js (frontend sem dependências)
```
