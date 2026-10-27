[CmdletBinding()]
param(
    [string]$LocalAddress = '192.168.0.10',
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [string]$ResultFile
)

$ErrorActionPreference = 'Stop'
try {
    if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $LocalAddress })) {
        throw "The requested IP address does not belong to this computer: $LocalAddress"
    }
    $gatewayRuleName = "iLinker-LAN-TCP-$Port"
    $gatewayRule = Get-NetFirewallRule -Name $gatewayRuleName -ErrorAction SilentlyContinue
    if ($gatewayRule) {
        $gatewayPorts = $gatewayRule | Get-NetFirewallPortFilter
        $gatewayAddresses = $gatewayRule | Get-NetFirewallAddressFilter
        if ($gatewayRule.Enabled -ne 'True' -or $gatewayRule.Action -ne 'Allow' -or $gatewayRule.Direction -ne 'Inbound' -or
            $gatewayPorts.Protocol -ne 'TCP' -or $gatewayPorts.LocalPort -ne "$Port" -or
            $gatewayAddresses.LocalAddress -ne $LocalAddress -or $gatewayAddresses.RemoteAddress -ne 'LocalSubnet') {
            throw "An existing rule has different settings. Review it manually: $gatewayRuleName"
        }
    } else {
        $gatewayRule = New-NetFirewallRule -Name $gatewayRuleName -DisplayName "iLinker LAN TCP $Port" `
            -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $LocalAddress `
            -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any
    }
    $gatewayResult = @{ ok = $true; rule = $gatewayRule.Name; address = $LocalAddress; port = $Port }
    if ($ResultFile) { $gatewayResult | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }
    $gatewayResult | ConvertTo-Json
} catch {
    if ($ResultFile) { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }
    Write-Error $_ -ErrorAction Continue
    exit 1
}
