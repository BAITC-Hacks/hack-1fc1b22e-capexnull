$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
Set-Location -LiteralPath $PSScriptRoot
$checkpointDate = (Get-Date).Date
$expectedRemote = 'https://github.com/BAITC-Hacks/hack-1fc1b22e-capexnull.git'

function Invoke-Git {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "git $args failed: $LASTEXITCODE" }
}

foreach ($checkpointTime in @('15:00', '16:00', '17:00', '17:55')) {
    $target = $checkpointDate.Add([TimeSpan]::Parse($checkpointTime))
    if ((Get-Date) -gt $target) { continue }
    while ((Get-Date) -lt $target) {
        Start-Sleep -Seconds ([Math]::Min(30, [Math]::Max(1, [Math]::Ceiling(($target - (Get-Date)).TotalSeconds))))
    }
    try {
        $branch = Invoke-Git branch --show-current
        $remote = Invoke-Git remote get-url origin
        if ($branch -ne 'main' -or $remote -ne $expectedRemote) {
            throw 'Checkpoint cancelled: branch or official repository does not match.'
        }
        Invoke-Git add .
        & git diff --cached --quiet
        $diffStatus = $LASTEXITCODE
        if ($diffStatus -eq 1) {
            Invoke-Git commit -m "HackAlem hourly checkpoint $checkpointTime"
        } elseif ($diffStatus -ne 0) {
            throw "Unable to check staged changes: $diffStatus"
        }
        Invoke-Git push origin main
        Write-Output "$(Get-Date -Format s) checkpoint $checkpointTime completed"
    } catch {
        Write-Warning "$(Get-Date -Format s) checkpoint $checkpointTime failed: $_"
    }
}
