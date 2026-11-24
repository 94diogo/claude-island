# Abre a Claude Island no logon e a reabre se ela fechar.
# Tarefa "Claude Island" no Agendador do Windows, só para o usuário atual (sem admin):
#  - roda no logon;
#  - repete a cada 5 min; se a ilha já está aberta, a nova cópia sai sozinha (instância única).
# Uso:  powershell -File autostart.ps1            (liga)
#       powershell -File autostart.ps1 -Remove    (desliga)
param([switch]$Remove)

$name = 'Claude Island'
$exe = Join-Path $env:LOCALAPPDATA 'Claude Island\claude-island.exe'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Island.lnk'

if (Test-Path $lnk) { Remove-Item $lnk -Force }   # atalho antigo da pasta Inicializar

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  'Inicialização automática desligada.'
  return
}

if (-not (Test-Path $exe)) { throw "Não achei $exe. Instale a Claude Island antes." }

$user = "$env:USERDOMAIN\$env:USERNAME"
# aspas: o caminho pode ter espaços (nome de usuário com espaço) e sem elas o Agendador dá 0x80070002
$action = New-ScheduledTaskAction -Execute "`"$exe`"" -WorkingDirectory (Split-Path $exe)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $logon, $every5 -Settings $settings `
  -Principal $principal -Description 'Abre a Claude Island no logon e reabre se ela fechar.' -Force | Out-Null
"Tarefa '$name' criada: abre no logon e confere a cada 5 min."
