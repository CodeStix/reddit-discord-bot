$redisPath = ".\bin\redisbin64\redis-cli.exe"

$(Invoke-Expression "$redisPath keys *") | ForEach-Object { 
    Write-Host "$(($_).PadRight(50)) ttl=$(Invoke-Expression "$redisPath ttl $_")" 
    
}