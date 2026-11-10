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

Windows, sem digitar comandos: clique com o botão direito em `iniciar.ps1` e
escolha **Executar com o PowerShell**. Ele localiza o Python 3.9+ (`py`,
`python` ou `python3`, ignorando o atalho da Microsoft Store), usa a próxima
porta livre se a 8000 estiver ocupada, abre o navegador e encerra o servidor
quando a janela é fechada. O `.zip` do export é enviado pela própria interface.
Se o Windows bloquear o script, rode uma vez no PowerShell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File .\iniciar.ps1
```

Parâmetros opcionais, úteis em um atalho:

```powershell
.\iniciar.ps1 -Port 8080 -AskKey                 # pergunta a chave do OpenCode (oculta)
.\iniciar.ps1 -Media "D:\casos\Media" -NoBrowser # pasta extra de mídias, sem abrir o navegador
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

## Análise por IA (OpenCode, modelos gratuitos)

Dois pontos de entrada, ambos abrem o painel lateral "Análise por IA":

- **Por conversa**: ícone de estrela no cabeçalho da conversa, ou o botão em
  "Dados do contato/grupo". Gera resumo, participantes, linha do tempo com
  citações `#id` (clicáveis, levam à mensagem), temas recorrentes, chamadas e
  mídias e pontos de atenção.
- **Geral**: botão "Análise geral com IA" no painel de análise forense de
  mídias. Gera panorama, atividade mensal, maiores conversas, chamadas, mídias
  e sugestões de conferência manual.

Como funciona:

- Usa a API compatível com OpenAI do OpenCode Zen
  (`https://opencode.ai/zen/v1/chat/completions`, `Authorization: Bearer`).
  `OPENCODE_BASE_URL` sobrescreve o endereço.
- **Só modelos gratuitos**: a lista (Beam, Big Pickle, DeepSeek V4.1 Flash,
  Flint 40B, GLM-5.3-Flash, Iceman, Inkling 2 Small, Jev 1.13, LongCat 2.5,
  MiMo-V2.6-Flash, MiniMax M3.1 Flash, Nemotron 3.5 Lightning, Nemotron 3.5
  Super VL) é fixa no servidor; qualquer outro modelo é recusado, então o saldo
  da conta não é consumido. "testar modelo" valida chave e modelo.
- **Chave**: variável de ambiente `OPENCODE_API_KEY`, `./iniciar.ps1 -AskKey`
  ou o campo do painel. Fica só na memória do servidor: não é gravada, não vai
  para log e a API nunca a devolve. Informar a chave só é aceito por acesso
  local (`127.0.0.1`).
- **O que sai do computador**: na análise por conversa, o texto das mensagens
  (imagens, vídeos e áudios não são enviados; aparecem como `[imagem]`,
  `[áudio]`). Na geral, só estatísticas e metadados, mais, se marcado, os
  resultados das análises por conversa já geradas. O envio exige marcar a
  autorização a cada abertura do painel, e o servidor recusa pedidos sem ela.
  **Modelos gratuitos podem registrar e reutilizar os dados**; confirme a
  política do OpenCode antes de usar com material sigiloso.
- Conversas longas são lidas em blocos de ~20 mil caracteres, com notas por
  bloco e síntese final (estimativa de chamadas exibida antes). Acima de 60
  blocos só os mais recentes são analisados, e o resultado informa a cobertura.
- Uma análise por vez, com barra de progresso e cancelamento; tentativas
  automáticas em limite de uso (429) e erros temporários. Resultados ficam em
  memória (até 6 por escopo, de modelos diferentes), com "copiar Markdown" e
  "baixar .md". Trocar o export descarta tudo.
- O texto das mensagens é tratado como dado, não como instrução, e a resposta
  do modelo é desenhada sem HTML. O resultado é **apoio gerado por IA**: confira
  cada afirmação nas mensagens citadas; não substitui a análise pericial.

API: `GET /api/ai/status`, `GET /api/ai/estimate?chat=`,
`GET /api/ai/results[?chat=]`, `GET /api/ai/jobs/<id>`, `POST /api/ai/key`,
`POST /api/ai/test`, `POST /api/ai/analyze`, `POST /api/ai/jobs/<id>/cancel`
(os POST exigem `Content-Type: application/json` e mesma origem).

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
iniciar.ps1   inicializador Windows (abre a interface de upload)
wa_view/
  __main__.py   CLI
  extractor.py  extração segura do ZIP (limites, CRC), índice de mídias, SHA-256, MIME
  upload.py     recebimento do .zip pela interface e troca do export ativo
  media_analysis.py  integridade, filtros e sumarização das mídias
  parser.py     leitura dos bancos → modelo (chats, participantes, mensagens)
  ai.py         análise por IA (OpenCode, modelos gratuitos, jobs, resumo geral)
  receipts.py   decodificação de ZRECEIPTINFO (NSKeyedArchiver)
  calls.py      leitura de CallHistory.sqlite (tolerante a variações de esquema)
  dates.py      conversão de datas Core Data (inclui datas truncadas)
  server.py     servidor HTTP (stdlib) — API JSON (/api/chats, /api/calls, /api/media-items, ...), mídias com Range, estáticos
  static/       index.html, style.css, app.js, media.js, ai.js, icons.js (frontend sem dependências)
```

## Colaboradores
- Elter Rodrigues
- Gabriel Duarte
