# Vault Curator — export pour diagnostic.
# Rassemble, pour les dossiers gérés par le plug-in : la liste de tous les fichiers (chemin, taille),
# le contenu des notes (.md), canvas et cartes (_curator.json), et les données du plug-in sans la clé API.
# Les photos et PDF ne sont PAS copiés (seulement listés), sauf avec -WithMedia.
# Usage : powershell -ExecutionPolicy Bypass -File export-diagnostic.ps1 -Vault "C:\Obsidian"
param(
  [string]$Vault = "C:\Obsidian",
  [switch]$WithMedia
)
$ErrorActionPreference = "Stop"
$plugin = Join-Path $Vault ".obsidian\plugins\course-curator"
$dataFile = Join-Path $plugin "data.json"
if (-not (Test-Path $dataFile)) { throw "data.json introuvable dans $plugin : le plug-in a-t-il déjà été utilisé ?" }
$out = Join-Path ([Environment]::GetFolderPath("Desktop")) "vault-curator-diagnostic"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null

# Plugin data without secrets.
$data = Get-Content $dataFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($data.settings.apiKey) { $data.settings.apiKey = "" }
$data | ConvertTo-Json -Depth 50 | Set-Content (Join-Path $out "data.json") -Encoding UTF8

$folders = @($data.settings.spaces | ForEach-Object { $_.folder })
if ($folders.Count -eq 0) { $folders = @("") }
$listing = @()
foreach ($f in $folders) {
  $root = if ($f) { Join-Path $Vault $f } else { $Vault }
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -Recurse -File | Where-Object { $_.FullName -notmatch "\\\.obsidian\\" } | ForEach-Object {
    $rel = $_.FullName.Substring($Vault.Length).TrimStart("\")
    $listing += [pscustomobject]@{ chemin = $rel; ko = [math]::Round($_.Length / 1KB, 1); modifie = $_.LastWriteTime.ToString("s") }
    $copy = $_.Extension -in ".md", ".canvas", ".json" -or ($WithMedia -and $_.Extension -in ".jpg", ".jpeg", ".png", ".pdf")
    if ($copy) {
      $dest = Join-Path $out ("vault\" + $rel)
      New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
      Copy-Item $_.FullName $dest
    }
  }
}
$archive = Join-Path $Vault "Archive"
if (Test-Path $archive) {
  Get-ChildItem $archive -Recurse -File | ForEach-Object {
    $listing += [pscustomobject]@{ chemin = $_.FullName.Substring($Vault.Length).TrimStart("\"); ko = [math]::Round($_.Length / 1KB, 1); modifie = $_.LastWriteTime.ToString("s") }
  }
}
$listing | Export-Csv (Join-Path $out "fichiers.csv") -NoTypeInformation -Encoding UTF8
$zip = "$out.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$out\*" -DestinationPath $zip
Remove-Item $out -Recurse -Force
Write-Host "Export prêt : $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) Mo)"
