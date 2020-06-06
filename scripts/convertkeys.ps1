$redisPath = ".\bin\redisbin64\redis-cli.exe"

$(Invoke-Expression "$redisPath keys *top:idx") | ForEach-Object { 

    $value = Invoke-Expression "$redisPath get $_"

    $split = $_.Split(":");

    $newKey = "$($split[0]):top:all:$($split[1]):idx"

    Write-Host "$_ -> $newKey = $value"

    Invoke-Expression "$redisPath set $newKey $value"
    Invoke-Expression "$redisPath del $_"
    
}