$ErrorActionPreference = "Stop"

Write-Host "[UP] Comprobando puerto 3000..." -ForegroundColor Cyan
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $conn) {
  Write-Host "[UP] Puerto 3000 ocupado. Cerrando proceso PID $($conn.OwningProcess)..." -ForegroundColor Yellow
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Milliseconds 500
}

Write-Host "[UP] Iniciando servidor..." -ForegroundColor Green
npm start
