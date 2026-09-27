#requires -Version 7.2
[CmdletBinding()]
param([string] $ArchivePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$plugin = Get-Content -LiteralPath (Join-Path $repo 'Plugin.cs') -Raw
$version = [regex]::Match($plugin, 'PluginVersion = "([0-9]+\.[0-9]+\.[0-9]+)"').Groups[1].Value
if (-not $version) { throw 'No stable plugin version.' }
if (-not $ArchivePath) { $ArchivePath = Join-Path $repo "artifacts/release/maschine-CombatLog-$version.zip" }
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$manifestPath = [IO.Path]::ChangeExtension($archive, '.build.json')
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
$scratch = $null

function Assert-That([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}
function Get-Sha([string] $Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Assert-Entries([string[]] $Names, [string[]] $Expected) {
    Assert-That ($Names.Count -eq $Expected.Count) 'Archive entry count differs from the allowlist.'
    Assert-That (@($Names | Sort-Object -Unique).Count -eq $Names.Count) 'Archive contains duplicate entries.'
    foreach ($name in $Names) {
        Assert-That ($Expected -ccontains $name) "Unexpected archive entry: $name"
        Assert-That ($name.StartsWith('BepInEx/', [StringComparison]::Ordinal) -and
            $name -notmatch '(^|/)\.\.?(/|$)|\\|:') "Unsafe archive path: $name"
    }
}

$expected = @('BepInEx/plugins/maschine-CombatLog.dll')
foreach ($document in @('README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md')) {
    $expected += "BepInEx/plugins/CombatLog/$document"
}
# Negative controls: the same allowlist oracle must reject root files,
# bundled dependencies, path traversal, omissions and duplicate entries.
Assert-Entries $expected $expected
$mutants = @(
    ,@($expected + 'README.md')
    ,@($expected + 'BepInEx/plugins/Anvil-WebOverlay.dll')
    ,@($expected[0..3] + 'BepInEx/../private.json')
    ,@($expected[0..3])
    ,@($expected[0..3] + $expected[0])
)
foreach ($mutant in $mutants) {
    $rejected = $false
    try { Assert-Entries $mutant $expected } catch { $rejected = $true }
    Assert-That $rejected 'Package allowlist accepted a negative control.'
}

Assert-That ($manifest.schema -eq 1 -and $manifest.version -eq $version) 'Manifest schema/version mismatch.'
Assert-That (-not $manifest.build.deployed -and $manifest.build.configuration -eq 'Release') 'Manifest is not an isolated Release build.'
Assert-That ($manifest.zip.name -ceq [IO.Path]::GetFileName($archive)) 'Manifest names another ZIP.'
$zipHash = Get-Sha $archive
Assert-That ($zipHash -eq $manifest.zip.sha256) 'ZIP hash differs from the build manifest.'
$checksum = (Get-Content -LiteralPath "$archive.sha256" -Raw).Trim()
Assert-That ($checksum -ceq "$zipHash  $([IO.Path]::GetFileName($archive))") 'Checksum sidecar differs.'
Assert-That ($manifest.liveDllBefore -eq $manifest.liveDllAfter) 'Packaging changed the live DLL.'
foreach ($entry in $manifest.sourceInputs.GetEnumerator()) {
    Assert-That ((Get-Sha (Join-Path $repo $entry.Key)) -eq $entry.Value) "Current source differs from built input: $($entry.Key)"
}
Push-Location $repo
try {
    $files = @(& git -c core.quotepath=false ls-files --cached --others --exclude-standard)
    Assert-That ($LASTEXITCODE -eq 0) 'Cannot enumerate current source.'
    $current = @($files | Sort-Object -Unique | Where-Object {
        ($_ -match '\.(cs|csproj|props|targets)$' -or $_ -match '^(web|assets)/') -and
        (Test-Path -LiteralPath (Join-Path $repo $_) -PathType Leaf)
    })
    Assert-That ($current.Count -eq $manifest.sourceInputs.Count) 'Production input count changed.'
    foreach ($name in $current) { Assert-That ($manifest.sourceInputs.Contains($name)) "Unbuilt source input: $name" }
} finally { Pop-Location }

$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try { Assert-Entries @($zip.Entries.FullName) $expected } finally { $zip.Dispose() }
try {
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('combatlog-extract-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $scratch | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $scratch)
    foreach ($name in $expected) {
        $file = Join-Path $scratch $name
        Assert-That ((Get-Sha $file) -eq $manifest.entries[$name]) "Extracted file hash mismatch: $name"
        if ($name -ne $expected[0]) {
            Assert-That ((Get-Sha $file) -eq (Get-Sha (Join-Path $repo ([IO.Path]::GetFileName($name))))) "Packaged document differs from source: $name"
        }
    }
    $dll = Join-Path $scratch $expected[0]
    Assert-That ([Reflection.AssemblyName]::GetAssemblyName($dll).Name -ceq 'maschine-CombatLog') 'Wrong assembly identity.'
    Assert-That ([Reflection.AssemblyName]::GetAssemblyName($dll).Version.ToString(3) -eq $version) 'Wrong assembly version.'
    $fileVersion = (Get-Item -LiteralPath $dll).VersionInfo
    Assert-That (([Version] $fileVersion.FileVersion).ToString(3) -eq $version -and
        $fileVersion.FilePrivatePart -eq 0) 'Wrong file version.'
    $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($dll))
    $resources = [ordered]@{
        'CombatLog.combatlog.html' = 'web/combatlog.html'
        'CombatLog.mannequin.js' = 'web/mannequin.js'
        'CombatLog.records.js' = 'web/records.js'
        'CombatLog.task-bar-icon.png' = 'assets/task-bar-icon.png'
    }
    Assert-That ($assembly.GetManifestResourceNames().Count -eq $resources.Count) 'Unexpected embedded resource count.'
    foreach ($entry in $resources.GetEnumerator()) {
        $stream = $assembly.GetManifestResourceStream($entry.Key)
        Assert-That ($null -ne $stream) "Missing embedded resource: $($entry.Key)"
        try {
            $resourceHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
            Assert-That ($resourceHash -eq (Get-Sha (Join-Path $repo $entry.Value))) "Stale embedded resource: $($entry.Value)"
        } finally { $stream.Dispose() }
    }
    Write-Output "Archive: $([IO.Path]::GetFileName($archive))"
    Write-Output "Files: $($expected.Count); ZIP SHA256: $zipHash"
    Write-Output 'COMBATLOG RELEASE PACKAGE VERIFIED'
}
finally {
    if ($scratch -and (Test-Path -LiteralPath $scratch)) {
        $resolved = (Resolve-Path -LiteralPath $scratch).Path
        $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        if ([IO.Path]::GetDirectoryName($resolved) -ne $tempParent -or
            [IO.Path]::GetFileName($resolved) -notmatch '^combatlog-extract-[0-9a-f]{32}$') {
            throw "Refusing cleanup of unexpected path: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
