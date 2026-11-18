# Registers the dashboard as a scheduled task with two triggers: at logon, and every
# 5 min as a watchdog. IgnoreNew makes the watchdog a no-op while server.vbs runs.
$ErrorActionPreference = 'Stop'
$vbs = Join-Path $PSScriptRoot 'server.vbs'
$name = 'dev-dashboard'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $name -Action $action -Trigger $atLogon, $watchdog -Settings $settings -Principal $principal -Force | Out-Null

# A server started by hand would hold the port, and the new one would keep failing to start.
Get-NetTCPConnection -LocalPort 8138 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Confirm:$false }

Start-ScheduledTask -TaskName $name
"registered '$name'; dashboard on http://localhost:8138"
