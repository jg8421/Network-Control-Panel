[CmdletBinding()]
param([switch]$NoLaunch, [switch]$NoAutostart)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$localRoot = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $localRoot) { throw 'LocalApplicationData is unavailable.' }
$panelRoot = [IO.Path]::GetFullPath((Join-Path $localRoot 'JerryNetworkPanel')).TrimEnd('\')
$installRoot = [IO.Path]::GetFullPath((Join-Path $panelRoot 'app')).TrimEnd('\')
if (-not $installRoot.StartsWith($panelRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Install path is outside the expected application folder.' }

function Get-SafeTreeFiles([string]$Root) {
    $stack = New-Object 'Collections.Generic.Stack[string]'
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($file in @(Get-ChildItem -LiteralPath $dir -File -Force)) {
            if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { Write-Output $file }
        }
        foreach ($child in @(Get-ChildItem -LiteralPath $dir -Directory -Force)) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $stack.Push($child.FullName) }
        }
    }
}

function Copy-PanelFile([IO.FileInfo]$File) {
    $relative = $File.FullName.Substring($sourceRoot.Length).TrimStart('\')
    $target = [IO.Path]::GetFullPath((Join-Path $installRoot $relative))
    if (-not $target.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'File target is outside the installation folder.' }
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        if ((Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) { return }
    }
    [IO.File]::Copy($File.FullName, $target, $true)
    if ((Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) { throw ('File verification failed: ' + $relative) }
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'server.mjs') -PathType Leaf)) { throw 'server.mjs is missing. Extract the complete ZIP first.' }
    if ($sourceRoot -ne $installRoot) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'node_modules\yaml\package.json') -PathType Leaf)) {
            throw 'YAML dependency is missing. Use the portable ZIP or run npm ci inside the source folder.'
        }
        $running = $null
        try {
            $request = [Net.WebClient]::new()
            $request.Proxy = $null
            $running = $request.DownloadString('http://127.0.0.1:18791/api/health') | ConvertFrom-Json
        } catch {} finally { if ($request) { $request.Dispose() } }
        $release = (Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json).version
        if ($running.app -eq 'jerry-network-panel' -and $running.version -ne $release) {
            & (Join-Path $installRoot 'scripts\Stop-Panel.ps1') -Quiet
            if ($LASTEXITCODE) { throw 'Could not stop the previous version.' }
            Start-Sleep -Milliseconds 600
        }
        New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
        $rootNames = @('server.mjs', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'LICENSE.txt', 'VERSION')
        foreach ($file in @(Get-ChildItem -LiteralPath $sourceRoot -File -Force)) {
            if ($file.Name -in $rootNames -or $file.Extension -eq '.vbs') { Copy-PanelFile $file }
        }
        foreach ($folder in @('lib', 'public', 'scripts', 'runtime', 'node_modules\yaml')) {
            $directory = Join-Path $sourceRoot $folder
            if (Test-Path -LiteralPath $directory -PathType Container) {
                if (((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Unexpected link folder: ' + $folder) }
                foreach ($file in @(Get-SafeTreeFiles $directory)) { Copy-PanelFile $file }
            }
        }
    }
    $launcher = Join-Path $installRoot 'Start.vbs'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Start.vbs is missing.' }
    $displayName = -join @([char]0x7EBF, [char]0x8DEF, [char]0x63A7, [char]0x5236, [char]0x53F0)
    $wsh = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'Jerry Tools'
    New-Item -ItemType Directory -Path $programs -Force | Out-Null
    $chromePaths = @()
    if ($env:ProgramFiles) { $chromePaths += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
    if (${env:ProgramFiles(x86)}) { $chromePaths += (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe') }
    $chromePaths += (Join-Path $localRoot 'Google\Chrome\Application\chrome.exe')
    $chrome = @($chromePaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)
    foreach ($shortcutPath in @((Join-Path $desktop ($displayName + '.lnk')), (Join-Path $programs ($displayName + '.lnk')))) {
        $shortcut = $wsh.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $shortcut.Arguments = '"' + $launcher + '"'
        $shortcut.WorkingDirectory = $installRoot
        $shortcut.Description = 'Local network route and connection panel'
        if ($chrome.Count -gt 0) { $shortcut.IconLocation = $chrome[0] + ',0' }
        else { $shortcut.IconLocation = (Join-Path $env:WINDIR 'System32\shell32.dll') + ',17' }
        $shortcut.Save()
    }
    if (-not $NoAutostart) {
        $startupRoot = [Environment]::GetFolderPath('Startup')
        if (-not $startupRoot) { throw 'The current-user Startup folder is unavailable.' }
        $startupRoot = [IO.Path]::GetFullPath($startupRoot).TrimEnd('\')
        $startupEntry = [IO.Path]::GetFullPath((Join-Path $startupRoot 'JerryNetworkPanel.lnk'))
        if (-not $startupEntry.StartsWith($startupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Startup entry is outside the current-user Startup folder.' }
        $autoLauncher = Join-Path $installRoot 'AutoStart.vbs'
        if (-not (Test-Path -LiteralPath $autoLauncher -PathType Leaf)) { throw 'AutoStart.vbs is missing.' }
        $expectedWscript = Join-Path $env:WINDIR 'System32\wscript.exe'
        $expectedArguments = '"' + $autoLauncher + '"'
        if (Test-Path -LiteralPath $startupEntry -PathType Leaf) {
            $existing = $wsh.CreateShortcut($startupEntry)
            if ($existing.TargetPath -ne $expectedWscript -or $existing.Arguments -ne $expectedArguments -or $existing.WorkingDirectory.TrimEnd('\') -ne $installRoot) {
                throw 'The Startup entry belongs to a different target. It was not replaced.'
            }
        }
        New-Item -ItemType Directory -Path $startupRoot -Force | Out-Null
        $startup = $wsh.CreateShortcut($startupEntry)
        $startup.TargetPath = $expectedWscript
        $startup.Arguments = $expectedArguments
        $startup.WorkingDirectory = $installRoot
        $startup.WindowStyle = 7
        $startup.Description = 'Start the local Network Panel silently after sign-in'
        if ($chrome.Count -gt 0) { $startup.IconLocation = $chrome[0] + ',0' }
        $startup.Save()
        $verified = $wsh.CreateShortcut($startupEntry)
        if ($verified.TargetPath -ne $expectedWscript -or $verified.Arguments -ne $expectedArguments -or $verified.WorkingDirectory.TrimEnd('\') -ne $installRoot) { throw 'Startup shortcut verification failed.' }
        $approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
        New-Item -Path $approvedKey -Force | Out-Null
        $enabledBytes = New-Object byte[] 12
        $enabledBytes[0] = 2
        New-ItemProperty -Path $approvedKey -Name 'JerryNetworkPanel.lnk' -PropertyType Binary -Value $enabledBytes -Force | Out-Null
        $verifiedApproval = (Get-ItemProperty -LiteralPath $approvedKey -Name 'JerryNetworkPanel.lnk').'JerryNetworkPanel.lnk'
        if ($verifiedApproval.Length -ne 12 -or $verifiedApproval[0] -ne 2) { throw 'Startup approval verification failed.' }
        Write-Output ('Silent sign-in startup enabled: ' + $startupEntry)
    }
    Write-Output ('Installed: ' + $installRoot)
    if (-not $NoLaunch) { & (Join-Path $installRoot 'scripts\Start-Panel.ps1') }
} catch {
    if (-not $NoLaunch) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Network Panel', 'OK', 'Warning') | Out-Null
    }
    Write-Error $_.Exception.Message
    exit 1
}
