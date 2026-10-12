# Vault Curator - export des cours pour un essai complet sur une copie.
# Un zip par cours (sous-dossier du dossier des cours), avec tout son contenu (PDF, photos, notes,
# notebooks) et les images collees dans ses notes, retrouvees ou Obsidian les a rangees (pieces jointes).
# Ne sont pas copies : les fichiers de donnees (csv, zip, gros txt...) et les fichiers de plus de -MaxMB Mo
# (seulement listes). Un zip "_racine" contient le reste du dossier des cours (99 Archive, A faire...) et les
# donnees du plug-in sans la cle API.
# Usage : powershell -ExecutionPolicy Bypass -File export-courses.ps1 -Vault "C:\Obsidian" -Root "DDDF"
param(
  [string]$Vault = "C:\Obsidian",
  [string]$Root = "DDDF",
  [int]$MaxMB = 40
)
$ErrorActionPreference = "Stop"
$rootPath = Join-Path $Vault $Root
if (-not (Test-Path $rootPath)) { throw "Dossier introuvable : $rootPath" }
$out = Join-Path ([Environment]::GetFolderPath("Desktop")) "vault-curator-cours"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
$stage = Join-Path $env:TEMP "vault-curator-stage"

$dataExt = @(".csv", ".tsv", ".zip", ".gz", ".parquet", ".pkl", ".pickle", ".h5", ".hdf5", ".xlsx", ".xls", ".sav", ".dta", ".mat", ".rds", ".db", ".sqlite")
function Rel($full) { $full.Substring($Vault.Length).TrimStart("\") }
function Skip($file) {
  ($dataExt -contains $file.Extension.ToLower()) -or
  ($file.Extension -eq ".txt" -and $file.Length -gt 300KB) -or
  ($file.Length -gt $MaxMB * 1MB)
}

# Every file of the vault by name, to resolve ![[photo.jpg]] like Obsidian (shortest path).
$byName = @{}
Get-ChildItem $Vault -Recurse -File | Where-Object { $_.FullName -notmatch "\\\.obsidian\\|\\\.trash\\" } | ForEach-Object {
  if (-not $byName.ContainsKey($_.Name)) { $byName[$_.Name] = $_ }
}

$listing = @()
function Export-Set($name, $files) {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage | Out-Null
  $copied = 0
  foreach ($f in $files) {
    $rel = Rel $f.FullName
    $skipped = Skip $f
    $script:listing += [pscustomobject]@{ zip = $name; chemin = $rel; ko = [math]::Round($f.Length / 1KB, 1); copie = -not $skipped }
    if ($skipped) { continue }
    $dest = Join-Path $stage $rel
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Copy-Item -LiteralPath $f.FullName -Destination $dest
    $copied++
  }
  if ($copied -eq 0) { return }
  $zip = Join-Path $out "$name.zip"
  Compress-Archive -Path "$stage\*" -DestinationPath $zip
  Write-Host ("{0,-45} {1,4} fichiers  {2,7} Mo" -f "$name.zip", $copied, [math]::Round((Get-Item $zip).Length / 1MB, 1))
}

foreach ($course in Get-ChildItem $rootPath -Directory) {
  if ($course.Name -eq "99 Archive") { continue }
  $files = @(Get-ChildItem -LiteralPath $course.FullName -Recurse -File)
  $inside = @{}
  foreach ($f in $files) { $inside[$f.FullName] = $true }
  # Images and PDFs pasted into the course's notes, wherever they are stored.
  foreach ($md in $files | Where-Object { $_.Extension -eq ".md" }) {
    $text = Get-Content -LiteralPath $md.FullName -Raw -Encoding UTF8
    if (-not $text) { continue }
    $links = @()
    $links += [regex]::Matches($text, '!\[\[([^\]|#^]+)') | ForEach-Object { $_.Groups[1].Value.Trim() }
    $links += [regex]::Matches($text, '!\[[^\]]*\]\(<?([^)>\s]+)') | ForEach-Object { [uri]::UnescapeDataString($_.Groups[1].Value) }
    foreach ($l in $links) {
      if ($l -match '^[a-z]+:') { continue }
      $candidate = Join-Path $Vault ($l -replace '/', '\')
      $hit = if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate } else { $byName[(Split-Path $l -Leaf)] }
      if ($hit -and -not $inside.ContainsKey($hit.FullName)) { $files += $hit; $inside[$hit.FullName] = $true }
    }
  }
  Export-Set ($course.Name -replace '[^\w\- ]', '_') $files
}

# The rest of the courses folder, and the plug-in's data without secrets.
$rest = @(Get-ChildItem -LiteralPath $rootPath -File) + @(Get-ChildItem -LiteralPath (Join-Path $rootPath "99 Archive") -Recurse -File -ErrorAction SilentlyContinue)
$dataFile = Join-Path $Vault ".obsidian\plugins\course-curator\data.json"
if (Test-Path $dataFile) {
  $data = Get-Content $dataFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($data.settings.apiKey) { $data.settings.apiKey = "" }
  $data | ConvertTo-Json -Depth 50 | Set-Content (Join-Path $out "data.json") -Encoding UTF8
}
Export-Set "_racine" $rest
$listing | Export-Csv (Join-Path $out "fichiers.csv") -NoTypeInformation -Encoding UTF8
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Write-Host "`nExport pret dans $out - depose tout le dossier dans Google Drive."
