[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 18791,
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:' + $Port

function Invoke-PanelJson([string]$Path, [string]$Method = 'GET', [string]$Token = '') {
    $response = $null
    $reader = $null
    $request = [Net.HttpWebRequest]::Create($baseUrl + $Path)
    $request.Proxy = $null
    $request.Method = $Method
    $request.Timeout = 20000
    $request.ReadWriteTimeout = 20000
    $request.KeepAlive = $false
    if ($Method -eq 'POST') {
        $request.Headers.Add('X-Panel-Request', '1')
        $request.Headers.Add('X-CSRF-Token', $Token)
        $request.ContentType = 'application/json; charset=utf-8'
        $payload = [Text.Encoding]::UTF8.GetBytes('{}')
        $request.ContentLength = $payload.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($payload, 0, $payload.Length) } finally { $stream.Dispose() }
    }
    try {
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        if ($text) { return ($text | ConvertFrom-Json) }
        return $null
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

try {
    try { $health = Invoke-PanelJson '/api/health' }
    catch [Net.WebException] {
        if ($_.Exception.Status -eq [Net.WebExceptionStatus]::ConnectFailure) {
            Write-Output 'The panel is already stopped.'
            exit 0
        }
        throw
    }
    if (-not $health -or $health.app -ne 'jerry-network-panel' -or -not $health.ok) { throw 'This port does not belong to Network Panel. Nothing was stopped.' }
    $status = Invoke-PanelJson '/api/status'
    if (-not $status.csrfToken -or [string]$status.csrfToken -notmatch '^[a-fA-F0-9]{64}$') { throw 'The panel did not provide a valid stop token. Nothing was stopped.' }
    $result = Invoke-PanelJson '/api/shutdown' 'POST' ([string]$status.csrfToken)
    if (-not $result.ok) { throw 'The panel did not confirm the shutdown request.' }
    Write-Output 'Panel shutdown requested. The proxy backend remains running.'
} catch {
    if (-not $Quiet) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Network Panel', 'OK', 'Warning') | Out-Null
    }
    Write-Error $_.Exception.Message
    exit 1
}
