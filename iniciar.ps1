<#
.SYNOPSIS
    Inicia o visualizador forense WhatsApp (wa_view) no Windows, sem usar o terminal.

.DESCRIPTION
    Localiza o Python 3.9+, inicia o servidor local e abre a interface no
    navegador. O export (.zip) é enviado pela própria interface (botão de upload
    ou arrastando o arquivo para a janela). Feche a janela ou pressione Ctrl+C
    para encerrar.

    Equivale a:  py -m wa_view --port 8000

    Como executar: clique com o botão direito em iniciar.ps1 e escolha
    "Executar com o PowerShell". Se o Windows bloquear o script, execute uma vez:
        Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
        Unblock-File .\iniciar.ps1

.PARAMETER Port
    Porta de escuta (padrão 8000). Se estiver ocupada, usa a próxima livre.

.PARAMETER Media
    Pastas extras de mídia (equivale a --media; várias: -Media A,B).

.PARAMETER NoBrowser
    Não abre o navegador automaticamente.

.EXAMPLE
    .\iniciar.ps1
    .\iniciar.ps1 -Port 8080
    .\iniciar.ps1 -Media "D:\casos\Media" -NoBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string[]]$Media,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "wa_view - visualizador forense WhatsApp"

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
$pyArgs = @($py.Args + @("-m", "wa_view", "--port", "$chosen"))
foreach ($m in $Media) { if ($m) { $pyArgs += @("--media", $m) } }
# Start-Process recebe uma única linha; caminhos com espaço precisam de aspas.
$argLine = ($pyArgs | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '

Write-Step "Iniciando: $($py.Exe) $argLine"
$proc = Start-Process -FilePath $py.Exe -ArgumentList $argLine -NoNewWindow -PassThru

# Abre o navegador assim que o servidor responder.
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
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
Write-Host "Envie o .zip do export pela interface. Feche esta janela ou pressione Ctrl+C para encerrar." -ForegroundColor Green
try {
    Wait-Process -Id $proc.Id
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
