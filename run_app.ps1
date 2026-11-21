[System.Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "$PSScriptRoot\node_modules\electron\dist\electron.exe"
$psi.Arguments = "`"$PSScriptRoot`""
$psi.WorkingDirectory = $PSScriptRoot
$psi.UseShellExecute = $false
$psi.Environment.Remove("ELECTRON_RUN_AS_NODE")
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "Started electron PID: $($proc.Id)"
