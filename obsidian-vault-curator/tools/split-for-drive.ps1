# Vault Curator - decoupe les zips de l'export en morceaux de 9 Mo (limite de lecture depuis Google Drive).
# Les morceaux (nom.zip.001, nom.zip.002...) sont recolles a l'identique de l'autre cote.
# Usage : powershell -ExecutionPolicy Bypass -File split-for-drive.ps1
param(
  [string]$Folder = (Join-Path ([Environment]::GetFolderPath("Desktop")) "vault-curator-cours"),
  [int]$PartMB = 9
)
$ErrorActionPreference = "Stop"
$out = Join-Path ([Environment]::GetFolderPath("Desktop")) "vault-curator-morceaux"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out | Out-Null
$size = $PartMB * 1MB
$buffer = New-Object byte[] $size
foreach ($zip in Get-ChildItem $Folder -Filter *.zip) {
  if ($zip.Length -le $size) { continue }
  $in = [IO.File]::OpenRead($zip.FullName)
  try {
    $n = 0
    while (($read = $in.Read($buffer, 0, $size)) -gt 0) {
      $n++
      $part = Join-Path $out ("{0}.{1:D3}" -f $zip.Name, $n)
      $fs = [IO.File]::Create($part)
      try { $fs.Write($buffer, 0, $read) } finally { $fs.Close() }
    }
    Write-Host ("{0,-45} {1,3} morceaux" -f $zip.Name, $n)
  } finally { $in.Close() }
}
Write-Host "`nMorceaux prets dans $out - depose ce dossier dans Google Drive (les petits zips y sont deja)."
