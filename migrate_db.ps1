# E:\propfirm\migrate_db.ps1

function Log($Message) {
    echo $Message
    Add-Content -Path "E:\propfirm\migration_log.txt" -Value "$(Get-Date) - $Message"
}

Log "Starting DB Migration..."

Log "Stopping PostgreSQL service..."
Stop-Service -Name "postgresql-x64-18" -Force -ErrorAction Continue

Log "Copying Data to E:\PostgreSQL\18\data..."
robocopy "C:\Program Files\PostgreSQL\18\data" "E:\PostgreSQL\18\data" /E /COPY:DATSO /MT:16 /R:1 /W:1
if ($LASTEXITCODE -ge 8) {
    Log "Robocopy failed! Exit code: $LASTEXITCODE"
    pause
    exit
}

Log "Setting permissions on new directory..."
icacls "E:\PostgreSQL\18\data" /grant "NETWORK SERVICE:(OI)(CI)F" /T

Log "Updating service binPath..."
$binPath = "`"C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe`" runservice -N `"postgresql-x64-18`" -D `"E:\PostgreSQL\18\data`" -w"
sc.exe config "postgresql-x64-18" binPath= $binPath

Log "Starting PostgreSQL Service..."
Start-Service -Name "postgresql-x64-18" -ErrorAction Continue

# Wait and check if running
Start-Sleep -Seconds 3
$Status = (Get-Service -Name "postgresql-x64-18").Status
if ($Status -eq 'Running') {
    Log "Service started successfully. Deleting old data directory..."
    Remove-Item "C:\Program Files\PostgreSQL\18\data" -Recurse -Force -ErrorAction Continue
} else {
    Log "Service failed to start! Status: $Status"
}

Log "Attempting to force delete c:\propfirm components..."
Get-ChildItem -Path "c:\propfirm" | Foreach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

Log "Migration script finished."
Start-Sleep -Seconds 3
