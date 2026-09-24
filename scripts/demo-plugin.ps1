#!/usr/bin/env pwsh
<#
Claude Code plugin demo: verifies the demo hub is reachable, runs the
plugin's mapper end-to-end once (SessionStart -> PreToolUse -> PostToolUse
for one session, through hooks/emit.mjs, exactly as Claude Code would invoke
it), confirms the resulting flow landed on the hub, then prints the exact
command to launch a real Claude Code session with the plugin pointed at that
hub.

Usage: pwsh scripts/demo-plugin.ps1
Env overrides: TRACERY_HUB_URL, TRACERY_API_KEY, TRACERY_WORKSPACE

TRACERY_API_KEY defaults to the demo hub's fixed key (tdk_a7f3c9e2b1d4). Task
("local mode"): to target a local-mode hub instead (one started with
`npx @atriarch-systems/tracery-hub` and no TRACERY_API_KEYS -- auth off), set it to
an explicitly empty string: `$env:TRACERY_API_KEY = ''` before running this.
#>
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir '..')
$PluginDir = Resolve-Path (Join-Path $RepoRoot 'plugins/claude-code')
$FixturesDir = Join-Path $PluginDir 'tests/fixtures'

$HubUrl = if ($env:TRACERY_HUB_URL) { $env:TRACERY_HUB_URL } else { 'http://127.0.0.1:8971' }
# Only a truly *unset* TRACERY_API_KEY falls back to the demo key -- an
# explicitly empty one (Test-Path sees it either way) opts into no-key mode.
$ApiKey = if (Test-Path env:TRACERY_API_KEY) { $env:TRACERY_API_KEY } else { 'tdk_a7f3c9e2b1d4' }
$Workspace = if ($env:TRACERY_WORKSPACE) { $env:TRACERY_WORKSPACE } else { 'default' }
$SessionId = 'demo-plugin-smoke'

Write-Host "[demo-plugin] hub: $HubUrl (workspace: $Workspace)"

# --- 1. verify the hub is reachable -----------------------------------------
try {
  Invoke-RestMethod -Uri "$HubUrl/healthz" -Method Get -TimeoutSec 5 | Out-Null
} catch {
  Write-Error "[demo-plugin] ERROR: hub at $HubUrl is not reachable (GET /healthz failed): $_"
  exit 1
}
Write-Host "[demo-plugin] hub is reachable"

# --- 2. run the mapper end to end for one session ---------------------------
$StateDir = New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName()))

function Invoke-Emit([string]$FixtureName) {
  $fixturePath = Join-Path $FixturesDir $FixtureName
  $payload = node (Join-Path $ScriptDir 'demo-plugin-fixture.mjs') $fixturePath $SessionId

  $env:CLAUDE_PLUGIN_DATA = $StateDir.FullName
  $env:TRACERY_HUB_URL = $HubUrl
  $env:TRACERY_API_KEY = $ApiKey
  $env:TRACERY_WORKSPACE = $Workspace
  $payload | node (Join-Path $PluginDir 'hooks/emit.mjs')
}

try {
  Write-Host "[demo-plugin] piping SessionStart through hooks/emit.mjs (session: $SessionId)"
  Invoke-Emit 'session-start.json'

  Write-Host "[demo-plugin] piping PreToolUse (Bash) through hooks/emit.mjs"
  Invoke-Emit 'pre-tool-use-bash.json'

  Write-Host "[demo-plugin] piping PostToolUse (Bash) through hooks/emit.mjs"
  Invoke-Emit 'post-tool-use-bash.json'

  # --- 3. confirm it landed on the hub ---------------------------------------
  $flowUrl = "$HubUrl/v1/flows/$SessionId"
  $headers = @{}
  if ($ApiKey) { $headers['authorization'] = "Bearer $ApiKey" }
  try {
    $response = Invoke-WebRequest -Uri $flowUrl -Method Get -Headers $headers -TimeoutSec 5
  } catch {
    Write-Error "[demo-plugin] ERROR: GET $flowUrl failed: $_"
    exit 1
  }
  if ($response.StatusCode -ne 200) {
    Write-Error "[demo-plugin] ERROR: GET $flowUrl returned $($response.StatusCode), expected 200."
    exit 1
  }
  Write-Host "[demo-plugin] confirmed: GET /v1/flows/$SessionId -> 200"
  Write-Host $response.Content

  # --- 4. print the deep link pattern the /tracery:activity skill produces ---
  Write-Host ""
  Write-Host "[demo-plugin] smoke-test flow's deep link: $HubUrl/ui/flows/$SessionId"
  Write-Host "[demo-plugin] general pattern (what /tracery:activity prints for the running session):"
  Write-Host "  $HubUrl/ui/flows/<session_id>"

  # --- 5. print the launch command for a new Claude Code session ------------
  Write-Host ""
  Write-Host "[demo-plugin] launch command for a new Claude Code session with the plugin"
  Write-Host "[demo-plugin] pointed at the demo hub:"
  Write-Host ""
  if ($ApiKey) {
    Write-Host "`$env:TRACERY_HUB_URL = '$HubUrl'; `$env:TRACERY_API_KEY = '$ApiKey'; `$env:TRACERY_WORKSPACE = '$Workspace'; claude --plugin-dir `"$PluginDir`""
  } else {
    Write-Host "`$env:TRACERY_HUB_URL = '$HubUrl'; `$env:TRACERY_WORKSPACE = '$Workspace'; claude --plugin-dir `"$PluginDir`"   # no TRACERY_API_KEY needed against a local-mode hub"
  }
} finally {
  Remove-Item -Recurse -Force $StateDir -ErrorAction SilentlyContinue
}
