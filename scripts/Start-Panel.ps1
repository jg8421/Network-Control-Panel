[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 18791,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$localRoot = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $localRoot) { throw 'LocalApplicationData is unavailable.' }
$stateRoot = Join-Path $localRoot 'JerryNetworkPanel'
$logRoot = Join-Path $stateRoot 'logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$baseUrl = 'http://127.0.0.1:' + $Port
$launcherLog = Join-Path $logRoot 'launcher.log'
$mutex = $null
$locked = $false

function Write-LauncherLog([string]$Text) {
    [IO.File]::AppendAllText($launcherLog, ((Get-Date).ToString('o') + ' ' + $Text + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

function Get-PanelHealth {
    $response = $null
    $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create($baseUrl + '/api/health')
        $request.Proxy = $null
        $request.Timeout = 900
        $request.ReadWriteTimeout = 900
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } catch { return $null }
    finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Test-LocalPort {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(350)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false }
    finally { $client.Dispose() }
}

function Open-PanelBrowser {
    $chromePaths = @()
    if ($env:ProgramFiles) { $chromePaths += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
    if (${env:ProgramFiles(x86)}) { $chromePaths += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
    $chromePaths += (Join-Path $localRoot 'Google\Chrome\Application\chrome.exe')
    $chrome = @($chromePaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
    if ($chrome.Count -eq 0) { throw 'Google Chrome is required to open this panel. Install Chrome and try again.' }
    Start-Process -FilePath $chrome[0] -ArgumentList @(('--app=' + $baseUrl), '--new-window', '--no-first-run') | Out-Null
}

try {
    $mutex = New-Object Threading.Mutex($false, ('Local\JerryNetworkPanel-Launcher-' + $Port))
    $locked = $mutex.WaitOne(10000)
    if (-not $locked) { throw 'Another panel launcher is still starting. Try again in a few seconds.' }
    $health = Get-PanelHealth
    if ($health -and $health.app -ne 'jerry-network-panel') { throw 'This local port is used by another application.' }
    if (-not ($health -and $health.app -eq 'jerry-network-panel' -and $health.ok)) {
        if (Test-LocalPort) { throw 'This local port is busy, but the panel is not responding. Close the previous panel process or select another port.' }
        $nodeExe = Join-Path $appRoot 'runtime\node.exe'
        if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
            $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
            if (-not $nodeCommand) { throw 'Node.js is missing. Use the portable ZIP that includes the runtime folder.' }
            $nodeExe = $nodeCommand.Source
        }
        $server = Join-Path $appRoot 'server.mjs'
        if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw 'server.mjs is missing. Extract the complete ZIP first.' }
        $env:PANEL_STATE_DIR = $stateRoot
        $env:PANEL_PORT = [string]$Port
        $launchId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + $PID
        $stdout = Join-Path $logRoot ('server-' + $launchId + '.log')
        $stderr = Join-Path $logRoot ('server-' + $launchId + '.error.log')
        $child = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + $server + '"'), '--port', [string]$Port) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        Write-LauncherLog ('Started panel pid=' + $child.Id + ' port=' + $Port)
        $deadline = (Get-Date).AddSeconds(18)
        do {
            Start-Sleep -Milliseconds 250
            $health = Get-PanelHealth
            if ($health -and $health.app -eq 'jerry-network-panel' -and $health.ok) { break }
            if ($child.HasExited) { throw ('Panel startup failed. See ' + $stderr) }
        } while ((Get-Date) -lt $deadline)
        if (-not ($health -and $health.app -eq 'jerry-network-panel' -and $health.ok)) { throw ('Panel startup timed out. See ' + $stderr) }
    }
    if (-not $NoBrowser) { Open-PanelBrowser }
    Write-Output ('Ready: ' + $baseUrl)
} catch {
    Write-LauncherLog ('Error: ' + $_.Exception.Message)
    if (-not $NoBrowser) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Network Panel', 'OK', 'Warning') | Out-Null
    }
    Write-Error $_.Exception.Message
    exit 1
} finally {
    if ($locked -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
