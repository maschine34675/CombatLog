#requires -Version 7.2
<#
Build a local installable archive from the current working source. This does
not publish, tag, commit, or deploy. Game and WebOverlay references must already
be installed at the paths used by CombatLog.csproj. Requires .NET SDK and Node.
The snapshot project has only reference paths rebased and DeployToSpt removed.
#>
[CmdletBinding()]
param([string] $OutputDirectory = 'artifacts/release')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$scratch = $null

function Get-Sha([string] $Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Exit([string] $Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit $LASTEXITCODE)." }
}

Push-Location $repo
try {
    # Do not silently overwrite an earlier candidate or write outside artifacts.
    $artifactRoot = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts')) + [IO.Path]::DirectorySeparatorChar
    if (-not $output.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'OutputDirectory must be a subdirectory of this repository''s artifacts directory.'
    }
    $plugin = Get-Content -LiteralPath (Join-Path $repo 'Plugin.cs') -Raw
    $version = [regex]::Match($plugin, 'PluginVersion = "([0-9]+\.[0-9]+\.[0-9]+)"').Groups[1].Value
    if (-not $version) { throw 'Cannot determine a stable plugin version.' }
    [xml] $project = Get-Content -LiteralPath (Join-Path $repo 'CombatLog.csproj') -Raw
    if ([string] $project.Project.PropertyGroup[0].AssemblyVersion -ne $version) {
        throw 'Plugin and project versions differ.'
    }
    $stem = "maschine-CombatLog-$version"
    $zipPath = Join-Path $output "$stem.zip"
    $manifestPath = Join-Path $output "$stem.build.json"
    $checksumPath = Join-Path $output "$stem.zip.sha256"
    foreach ($path in @($zipPath, $manifestPath, $checksumPath)) {
        if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite candidate: $path" }
    }
    & node tests/verify-release-docs.mjs
    Assert-Exit 'Public documentation verification'

    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('combatlog-package-' + [guid]::NewGuid().ToString('N'))
    $source = Join-Path $scratch 'source'
    $built = Join-Path $scratch 'output'
    $stage = Join-Path $scratch 'package'
    New-Item -ItemType Directory -Path $source, $built, $stage -Force | Out-Null

    $liveDll = [IO.Path]::GetFullPath((Join-Path $repo '../../BepInEx/plugins/maschine-CombatLog.dll'))
    $liveBefore = if (Test-Path -LiteralPath $liveDll) { Get-Sha $liveDll } else { $null }
    $head = (& git rev-parse HEAD).Trim()
    Assert-Exit 'Source revision lookup'
    $dirty = @(& git status --porcelain)
    Assert-Exit 'Source status lookup'
    $files = @(& git -c core.quotepath=false ls-files --cached --others --exclude-standard)
    Assert-Exit 'Source file enumeration'
    $inputs = @($files | Sort-Object -Unique | Where-Object {
        ($_ -match '\.(cs|csproj|props|targets)$' -or $_ -match '^(web|assets)/') -and
        (Test-Path -LiteralPath (Join-Path $repo $_) -PathType Leaf)
    })
    if ($inputs.Count -lt 5) { throw 'Production input inventory is incomplete.' }
    $sourceHashes = [ordered]@{}
    foreach ($relative in $inputs) {
        $from = Join-Path $repo $relative
        $to = Join-Path $source $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
        Copy-Item -LiteralPath $from -Destination $to
        $sourceHashes[$relative] = Get-Sha $from
        if ((Get-Sha $to) -ne $sourceHashes[$relative]) { throw "Input copy differs: $relative" }
    }
    $references = @()
    foreach ($hint in @($project.SelectNodes('//Reference/HintPath'))) {
        $reference = [IO.Path]::GetFullPath((Join-Path $repo $hint.InnerText))
        if (-not (Test-Path -LiteralPath $reference -PathType Leaf)) { throw "Missing build reference: $reference" }
        $references += [ordered]@{
            name = [IO.Path]::GetFileName($reference)
            sha256 = Get-Sha $reference
            version = (Get-Item -LiteralPath $reference).VersionInfo.FileVersion
        }
        $hint.InnerText = $reference
    }
    $deploy = $project.SelectSingleNode('//Target[@Name="DeployToSpt"]')
    if ($null -eq $deploy) { throw 'Expected deployment target is missing; review packaging isolation.' }
    [void] $deploy.ParentNode.RemoveChild($deploy)
    $snapshotProject = Join-Path $source 'CombatLog.csproj'
    $project.Save($snapshotProject)

    $sdk = (& dotnet --version).Trim()
    Assert-Exit 'SDK version lookup'
    & dotnet build $snapshotProject -c Release "-p:OutputPath=$built/" '-p:DebugType=None' '-p:DebugSymbols=false' "-p:PathMap=$source=/_/CombatLog" --nologo
    Assert-Exit 'Isolated Release build'
    $dlls = @(Get-ChildItem -LiteralPath $built -Filter 'maschine-CombatLog.dll' -Recurse -File)
    if ($dlls.Count -ne 1) { throw "Expected one output DLL; got $($dlls.Count)." }
    $dll = $dlls[0].FullName
    if ([Reflection.AssemblyName]::GetAssemblyName($dll).Version.ToString(3) -ne $version) {
        throw 'Built assembly version differs from plugin version.'
    }
    $packageFiles = [ordered]@{ 'BepInEx/plugins/maschine-CombatLog.dll' = $dll }
    foreach ($document in @('README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md')) {
        $packageFiles["BepInEx/plugins/CombatLog/$document"] = Join-Path $repo $document
    }
    $entries = [ordered]@{}
    foreach ($entry in $packageFiles.GetEnumerator()) {
        $destination = Join-Path $stage $entry.Key
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $entry.Value -Destination $destination
        $entries[$entry.Key] = Get-Sha $destination
    }
    foreach ($entry in $sourceHashes.GetEnumerator()) {
        if ((Get-Sha (Join-Path $repo $entry.Key)) -ne $entry.Value) { throw "Source changed during build: $($entry.Key)" }
    }
    $liveAfter = if (Test-Path -LiteralPath $liveDll) { Get-Sha $liveDll } else { $null }
    if ($liveBefore -ne $liveAfter) { throw 'Live CombatLog DLL changed during packaging.' }

    New-Item -ItemType Directory -Path $output -Force | Out-Null
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $zipHash = Get-Sha $zipPath
    [IO.File]::WriteAllText($checksumPath, "$zipHash  $stem.zip`n", [Text.UTF8Encoding]::new($false))
    $manifest = [ordered]@{
        schema = 1
        version = $version
        sourceHead = $head
        workingTreeChanges = $dirty
        sourceInputs = $sourceHashes
        snapshotProjectSha256 = Get-Sha $snapshotProject
        build = [ordered]@{ configuration = 'Release'; sdk = $sdk; deployed = $false; debugSymbols = $false }
        references = $references
        zip = [ordered]@{ name = "$stem.zip"; sha256 = $zipHash }
        entries = $entries
        liveDllBefore = $liveBefore
        liveDllAfter = $liveAfter
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
    & (Join-Path $repo 'tests/verify-release-package.ps1') -ArchivePath $zipPath
    Write-Output "LOCAL RELEASE ZIP CREATED: $zipPath"
}
finally {
    if ($scratch -and (Test-Path -LiteralPath $scratch)) {
        $resolved = (Resolve-Path -LiteralPath $scratch).Path
        $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
        if ([IO.Path]::GetDirectoryName($resolved) -ne $tempParent -or
            [IO.Path]::GetFileName($resolved) -notmatch '^combatlog-package-[0-9a-f]{32}$') {
            throw "Refusing cleanup of unexpected path: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    Pop-Location
}
