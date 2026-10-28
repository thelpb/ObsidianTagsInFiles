<#
.SYNOPSIS
    Copies the plugin into an Obsidian vault.
.DESCRIPTION
    Puts main.js, manifest.json and styles.css in <Vault>\.obsidian\plugins\property-bubbles.
    Existing settings (data.json) are left alone. Reload Obsidian, or turn the plugin off and on,
    to pick up a new version.
.EXAMPLE
    .\install.ps1 -Vault "C:\Notes\Work"
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Vault
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $Vault '.obsidian'))) {
    throw "No .obsidian folder in '$Vault'. Pass the vault's root folder."
}

$id = (Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json).id
$target = Join-Path $Vault ".obsidian\plugins\$id"
New-Item -ItemType Directory -Force $target | Out-Null

foreach ($file in 'main.js', 'manifest.json', 'styles.css') {
    Copy-Item (Join-Path $PSScriptRoot $file) $target -Force
}

Write-Host "Installed $id into $target"
