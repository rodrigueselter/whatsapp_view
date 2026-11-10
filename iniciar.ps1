<#
.SYNOPSIS
    Inicia o visualizador forense WhatsApp (wa_view) no Windows sem usar o terminal.

.DESCRIPTION
    Localiza o Python 3, escolhe o export (.zip ou pasta) numa janela de seleção
    de arquivo — ou sobe a interface para enviar o .zip pelo navegador —, inicia
    o servidor local e abre o navegador. Feche a janela ou pressione Ctrl+C para
    encerrar.

    Equivale a:
        py -m wa_view "C:\caminho\para\export.zip" --port 8000
        py -m wa_view --port 8000            (interface de upload)

.PARAMETER Export
    Caminho do .zip (ou pasta já extraída). Se omitido, abre uma janela para escolher.

.PARAMETER Interface
    Não pergunta pelo arquivo: sobe o servidor vazio e o .zip é enviado pela interface.

.PARAMETER Port
    Porta de escuta (padrão 8000). Se estiver ocupada, usa a próxima livre.

.PARAMETER Media
    Pastas extras de mídia (equivale a --media, pode repetir: -Media A,B).

.PARAMETER NoBrowser
    Não abre o navegador automaticamente.

.EXAMPLE
    .\iniciar.ps1
    .\iniciar.ps1 -Export "D:\casos\export.zip" -Port 8080
    .\iniciar.ps1 -Interface
#>
[CmdletBinding()]
param(
    [string]$Export,
    [switch]$Interface,
    [int]$Port = 8000,
    [string[]]$Media,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "wa_view — visualizador forense WhatsApp"

function Write-Step($msg) { Write-Host "[wa_view] $msg" -ForegroundColor Cyan }
function Write-Fail($msg) {
    Write-Host "[wa_view] ERRO: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "Pressione Enter para fechar" | Out-Null
    exit 1
}

# ---------------------------------------------------------------- pasta
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
if (-not (Test-Path (Join-Path $root "wa_view\__main__.py"))) {
    Write-Fail "Este script deve ficar na pasta do repositório (ao lado da pasta 'wa_view')."
}

# ---------------------------------------------------------------- python
# Tenta o inicializador 'py' primeiro (python.org), depois 'python'/'python3'.
# O atalho da Microsoft Store responde a 'python' sem Python instalado, por isso
# cada candidato é validado executando a versão.
function Find-Python {
    $candidates = @(
        @{ Exe = "py";      Args = @("-3") },
        @{ Exe = "python";  Args = @() },
        @{ Exe = "python3"; Args = @() }
    )
    foreach ($c in $candidates) {
        $cmd = Get-Command $c.Exe -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        try {
            $ver = & $c.Exe @($c.Args + @("-c", "import sys;print('%d.%d' % sys.version_info[:2])")) 2>$null
        } catch { continue }
        if ($LASTEXITCODE -ne 0 -or -not $ver) { continue }
        $parts = "$ver".Trim().Split(".")
        if ([int]$parts[0] -gt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 9)) {
            return @{ Exe = $c.Exe; Args = $c.Args; Version = "$ver".Trim() }
        }
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    Write-Fail "Python 3.9+ não encontrado. Instale em https://www.python.org/downloads/ marcando 'Add python.exe to PATH'."
}
Write-Step "Python $($py.Version) ($($py.Exe))"

# ---------------------------------------------------------------- export
if (-not $Interface -and -not $Export) {
    Write-Step "Escolha o export (.zip). Cancele para enviar pelo navegador."
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Title = "Selecione o export do WhatsApp (.zip) — Cancelar = enviar pela interface"
        $dlg.Filter = "Export WhatsApp (*.zip)|*.zip|Todos os arquivos (*.*)|*.*"
        $dlg.CheckFileExists = $true
        if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $Export = $dlg.FileName }
    } catch {
        $typed = Read-Host "Caminho do .zip (vazio = enviar pela interface)"
        if ($typed) { $Export = $typed.Trim('"') }
    }
}
if ($Export) {
    if (-not (Test-Path $Export)) { Write-Fail "Export não encontrado: $Export" }
    $Export = (Resolve-Path $Export).Path
    Write-Step "Export: $Export"
} else {
    Write-Step "Sem export: o .zip será enviado pela interface no navegador."
}

# ---------------------------------------------------------------- porta
function Test-PortFree([int]$p) {
    try {
        $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop(); return $true
    } catch { return $false }
}
$chosen = $Port
while (-not (Test-PortFree $chosen)) {
    Write-Host "[wa_view] porta $chosen ocupada, tentando $($chosen + 1)" -ForegroundColor Yellow
    $chosen++
    if ($chosen -gt $Port + 50) { Write-Fail "Nenhuma porta livre entre $Port e $chosen." }
}
$url = "http://127.0.0.1:$chosen/"

# ---------------------------------------------------------------- servidor
$pyArgs = @($py.Args + @("-m", "wa_view"))
if ($Export) { $pyArgs += $Export }
$pyArgs += @("--port", "$chosen")
foreach ($m in $Media) { if ($m) { $pyArgs += @("--media", $m) } }
# Start-Process recebe uma única linha; caminhos com espaço precisam de aspas.
$argLine = ($pyArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '

Write-Step "Iniciando: $($py.Exe) $argLine"
$proc = Start-Process -FilePath $py.Exe -ArgumentList $argLine -NoNewWindow -PassThru

# Abre o navegador assim que o servidor responder (carga do export pode levar segundos).
$ready = $false
for ($i = 0; $i -lt 600; $i++) {
    if ($proc.HasExited) { break }
    try {
        $null = Invoke-WebRequest -Uri "$($url)api/status" -UseBasicParsing -TimeoutSec 2
        $ready = $true; break
    } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) {
    if ($proc.HasExited) { Write-Fail "O servidor encerrou antes de ficar disponível (veja as mensagens acima)." }
    Write-Host "[wa_view] o servidor ainda não respondeu; abra $url manualmente." -ForegroundColor Yellow
} elseif (-not $NoBrowser) {
    Write-Step "Abrindo $url"
    Start-Process $url
} else {
    Write-Step "Disponível em $url"
}

Write-Host ""
Write-Host "Feche esta janela ou pressione Ctrl+C para encerrar o visualizador." -ForegroundColor Green
try {
    Wait-Process -Id $proc.Id
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
