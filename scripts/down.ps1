$ErrorActionPreference = "Stop"

Write-Host "[DOWN] Buscando servidor en puerto 3000..." -ForegroundColor Cyan
$conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -eq $conn) {
  Write-Host "[DOWN] No hay ningun proceso escuchando en el puerto 3000." -ForegroundColor Yellow
  exit 0
}

Write-Host "[DOWN] Cerrando proceso PID $($conn.OwningProcess)..." -ForegroundColor Green
Stop-Process -Id $conn.OwningProcess -Force
Write-Host "[DOWN] Servidor detenido." -ForegroundColor Green
