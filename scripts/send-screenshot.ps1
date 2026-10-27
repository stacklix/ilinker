<#
.SYNOPSIS
Send an existing screenshot to the configured iLinker WebHook.
.EXAMPLE
pwsh -NoProfile -File C:\Users\xliqi\.codex\scripts\send-screenshot.ps1 -ImagePath C:\temp\screenshot.png
.NOTES
Configuration: CODEX_HOME/screenshot-hook.json, or USERPROFILE/.codex/screenshot-hook.json.
Exit codes: 0 = provider accepted (or explicitly requested -NoWait); 1 = failure/unknown;
2 = still queued/sending when the wait deadline expires. No automatic POST retries.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][Alias('Path')][string]$ImagePath,
    [string]$ConfigPath,
    [string]$WebHookUrl,
    [ValidatePattern('^[\x21-\x7E]{1,128}$')][string]$IdempotencyKey,
    [ValidateRange(1, 900)][int]$WaitTimeoutSeconds = 120,
    [switch]$NoWait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$screenshotClient = $null
$screenshotTarget = $null
$screenshotToken = ''
$screenshotExitCode = 1
if (-not $IdempotencyKey) { $IdempotencyKey = 'screenshot-' + [Guid]::NewGuid().ToString('N') }
$screenshotResult = [ordered]@{
    requestId = $null; messageId = $null; status = 'error'; providerAccepted = $false
    idempotencyKey = $IdempotencyKey; timedOut = $false; error = $null
}

function Get-WebHookField($Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    $screenshotProperty = $Value.PSObject.Properties[$Name]
    if ($null -ne $screenshotProperty) { return $screenshotProperty.Value }
    return $null
}

function Protect-WebHookSecret([string]$Message) {
    if ($WebHookUrl) { $Message = $Message.Replace($WebHookUrl, '[WEBHOOK_URL_REDACTED]') }
    if ($screenshotToken) { $Message = $Message.Replace($screenshotToken, '[TOKEN_REDACTED]') }
    return [regex]::Replace($Message, 'hk_[A-Za-z0-9_-]{43}', '[TOKEN_REDACTED]')
}

function Invoke-WebHookRequest([string]$Method, [Uri]$Uri, [string]$Json, [int]$TimeoutSeconds = 15) {
    $screenshotRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), $Uri)
    $screenshotCancellation = [Threading.CancellationTokenSource]::new()
    $screenshotResponse = $null
    try {
        $screenshotCancellation.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
        if ($Method -eq 'POST') {
            $screenshotRequest.Headers.Add('Idempotency-Key', $IdempotencyKey)
            $screenshotRequest.Content = [Net.Http.StringContent]::new($Json, [Text.Encoding]::UTF8, 'application/json')
        }
        $screenshotResponse = $screenshotClient.SendAsync($screenshotRequest, $screenshotCancellation.Token).GetAwaiter().GetResult()
        $screenshotRaw = $screenshotResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $screenshotBody = $null
        try { $screenshotBody = ConvertFrom-Json -InputObject $screenshotRaw -ErrorAction Stop } catch { }
        if (-not $screenshotResponse.IsSuccessStatusCode) {
            $screenshotCode = Get-WebHookField $screenshotBody 'code'
            $screenshotDetail = Get-WebHookField $screenshotBody 'message'
            if (-not $screenshotDetail) { $screenshotDetail = 'WebHook request rejected.' }
            throw ('HTTP {0} [{1}] {2}' -f [int]$screenshotResponse.StatusCode, $screenshotCode, (Protect-WebHookSecret $screenshotDetail))
        }
        if ($null -eq $screenshotBody) { throw 'WebHook returned an invalid JSON response.' }
        return $screenshotBody
    } finally {
        if ($null -ne $screenshotResponse) { $screenshotResponse.Dispose() }
        $screenshotRequest.Dispose()
        $screenshotCancellation.Dispose()
    }
}

try {
    $screenshotFile = Get-Item -LiteralPath $ImagePath -ErrorAction Stop
    if ($screenshotFile.PSIsContainer) { throw 'ImagePath must refer to an image file.' }
    if ($screenshotFile.Extension.ToLowerInvariant() -notin @('.png', '.jpg', '.jpeg', '.gif', '.webp')) {
        throw 'Supported screenshot formats: PNG, JPEG, GIF, WebP.'
    }
    if ($screenshotFile.Length -eq 0 -or $screenshotFile.Length -gt 8MB) { throw 'Screenshot must be nonempty and no larger than 8 MB.' }
    if (-not $WebHookUrl) {
        if (-not $ConfigPath) {
            $screenshotCodexRoot = $env:CODEX_HOME
            if (-not $screenshotCodexRoot) { $screenshotCodexRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
            $ConfigPath = Join-Path $screenshotCodexRoot 'screenshot-hook.json'
        }
        if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Screenshot WebHook configuration file was not found.' }
        $screenshotConfig = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $WebHookUrl = [string](Get-WebHookField $screenshotConfig 'webhookUrl')
    }
    if (-not [Uri]::TryCreate($WebHookUrl, [UriKind]::Absolute, [ref]$screenshotTarget) -or
        $screenshotTarget.Scheme -notin @('http', 'https') -or $screenshotTarget.UserInfo -or
        $screenshotTarget.Query -or $screenshotTarget.Fragment -or
        $screenshotTarget.AbsolutePath -notmatch '^/webhook/message/(hk_[A-Za-z0-9_-]{43})$') {
        throw 'Invalid WebHook URL. Expected http(s)://host/webhook/message/{token} without query, fragment or credentials.'
    }
    $screenshotToken = $Matches[1]
    Add-Type -AssemblyName System.Net.Http
    $screenshotHandler = [Net.Http.HttpClientHandler]::new()
    $screenshotHandler.AllowAutoRedirect = $false
    $screenshotHandler.UseProxy = $false
    $screenshotClient = [Net.Http.HttpClient]::new($screenshotHandler)
    $screenshotClient.Timeout = [TimeSpan]::FromSeconds(60)
    $screenshotPayload = @{ type = 'image'; image = @{ base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($screenshotFile.FullName)) } } | ConvertTo-Json -Depth 4 -Compress
    $screenshotAccepted = Invoke-WebHookRequest -Method 'POST' -Uri $screenshotTarget -Json $screenshotPayload -TimeoutSeconds 45
    $screenshotResult.requestId = Get-WebHookField $screenshotAccepted 'requestId'
    $screenshotResult.messageId = Get-WebHookField $screenshotAccepted 'messageId'
    $screenshotResult.status = [string](Get-WebHookField $screenshotAccepted 'status')
    if (-not $screenshotResult.messageId -or $screenshotResult.status -notin @('queued', 'sending', 'provider_accepted', 'failed', 'unknown')) {
        throw 'WebHook returned an invalid message identifier or status.'
    }
    $screenshotDeadline = [Diagnostics.Stopwatch]::StartNew()
    while (-not $NoWait -and $screenshotResult.status -in @('queued', 'sending')) {
        $screenshotRemaining = $WaitTimeoutSeconds - $screenshotDeadline.Elapsed.TotalSeconds
        if ($screenshotRemaining -le 0) { $screenshotResult.timedOut = $true; break }
        $screenshotStatusUri = [Uri]::new($screenshotTarget.AbsoluteUri + '/status/' + [Uri]::EscapeDataString([string]$screenshotResult.messageId))
        $screenshotState = Invoke-WebHookRequest -Method 'GET' -Uri $screenshotStatusUri -TimeoutSeconds ([Math]::Max(1, [Math]::Min(15, [Math]::Ceiling($screenshotRemaining))))
        if ((Get-WebHookField $screenshotState 'messageId') -ne $screenshotResult.messageId) { throw 'WebHook status response does not match the requested message.' }
        $screenshotResult.status = [string](Get-WebHookField $screenshotState 'status')
        if ($screenshotResult.status -notin @('queued', 'sending', 'provider_accepted', 'failed', 'unknown')) { throw 'WebHook returned an invalid message status.' }
        $screenshotResult.error = Protect-WebHookSecret ([string](Get-WebHookField $screenshotState 'error'))
        if ($screenshotResult.status -in @('queued', 'sending')) {
            Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min(2000, [Math]::Ceiling(($WaitTimeoutSeconds - $screenshotDeadline.Elapsed.TotalSeconds) * 1000))))
        }
    }
    $screenshotResult.providerAccepted = $screenshotResult.status -eq 'provider_accepted'
    if ($screenshotResult.providerAccepted -or ($NoWait -and $screenshotResult.status -in @('queued', 'sending'))) { $screenshotExitCode = 0 }
    elseif ($screenshotResult.timedOut) { $screenshotExitCode = 2; $screenshotResult.error = 'Still queued or sending. Keep messageId and idempotencyKey; do not create a duplicate task.' }
    elseif (-not $screenshotResult.error) { $screenshotResult.error = 'Screenshot submission failed or has an unknown outcome; inspect the message before retrying.' }
} catch {
    $screenshotResult.error = Protect-WebHookSecret $_.Exception.Message
} finally {
    if ($null -ne $screenshotClient) { $screenshotClient.Dispose() }
}
$screenshotResult | ConvertTo-Json -Depth 4 -Compress
exit $screenshotExitCode
