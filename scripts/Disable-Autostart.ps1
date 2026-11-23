[CmdletBinding()]
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
try {
    $localRoot = [Environment]::GetFolderPath('LocalApplicationData')
    $startupRoot = [Environment]::GetFolderPath('Startup')
    if (-not $localRoot -or -not $startupRoot) { throw 'The current-user application or Startup folder is unavailable.' }
    $panelRoot = [IO.Path]::GetFullPath((Join-Path $localRoot 'JerryNetworkPanel')).TrimEnd('\')
    $installRoot = [IO.Path]::GetFullPath((Join-Path $panelRoot 'app')).TrimEnd('\')
    if (-not $installRoot.StartsWith($panelRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The expected installation path is invalid.' }
    $startupRoot = [IO.Path]::GetFullPath($startupRoot).TrimEnd('\')
    $startupEntry = [IO.Path]::GetFullPath((Join-Path $startupRoot 'JerryNetworkPanel.lnk'))
    if (-not $startupEntry.StartsWith($startupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The Startup entry is outside the current-user Startup folder.' }
    if (Test-Path -LiteralPath $startupEntry -PathType Leaf) {
        $beforeHash = (Get-FileHash -LiteralPath $startupEntry -Algorithm SHA256).Hash
        $wsh = New-Object -ComObject WScript.Shell
        $entry = $wsh.CreateShortcut($startupEntry)
        $expectedWscript = Join-Path $env:WINDIR 'System32\wscript.exe'
        $expectedArguments = '"' + (Join-Path $installRoot 'AutoStart.vbs') + '"'
        if ($entry.TargetPath -ne $expectedWscript -or $entry.Arguments -ne $expectedArguments -or $entry.WorkingDirectory.TrimEnd('\') -ne $installRoot) {
            throw 'The Startup entry belongs to a different target. Nothing was removed.'
        }
        if ((Get-FileHash -LiteralPath $startupEntry -Algorithm SHA256).Hash -ne $beforeHash) { throw 'The Startup entry changed. Nothing was removed.' }
        Remove-Item -LiteralPath $startupEntry -Force
        if (Test-Path -LiteralPath $startupEntry) { throw 'The Startup entry could not be removed.' }
        $approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
        $approval = Get-ItemProperty -LiteralPath $approvedKey -Name 'JerryNetworkPanel.lnk' -ErrorAction SilentlyContinue
        if ($null -ne $approval) { Remove-ItemProperty -LiteralPath $approvedKey -Name 'JerryNetworkPanel.lnk' }
    }
    Write-Output 'Network Panel automatic startup is disabled.'
    if (-not $Quiet) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show('Network Panel automatic startup is disabled.', 'Network Panel', 'OK', 'Information') | Out-Null
    }
} catch {
    if (-not $Quiet) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Network Panel', 'OK', 'Warning') | Out-Null
    }
    Write-Error $_.Exception.Message
    exit 1
}
