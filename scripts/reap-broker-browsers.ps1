# external-ref-ok-next-line: this repository's own first-party PowerShell tool, not a reference to another codebase
# reap-broker-browsers.ps1 — emergency sweep for leaked playwright-pool broker browsers.
#
# WHY THIS EXISTS
# playwright-pool spawns its browsers with `detached: true` on purpose
# (src/browser/launch.ts): "Browsers are adopted, not owned ... The browser
# outlives every process that touched it." That is deliberate, but it means
# nothing reaps them when the adoption path misses. On 2026-08-28 this reached
# 1,637 chrome.exe processes across 164 launches and froze the machine; the
# leftover profile directories went back to 2026-08-26.
#
# STATUS: an emergency tool, kept as insurance rather than as a stopgap for a
# known open leak. Every leak source found to date has been fixed at the
# root: the ARTIFACT dirs ("1,389 empty broker-artifacts- directories",
# src/browser/real.ts), the production cold-start failure paths (4f38584),
# the sign-in-evidence test's teardown race (3f81310), and the real-driver
# profile-collision test leak (this same round — see
# tests/helpers/browser-fixture.ts's reapProcessesUsingProfile). This script
# stays anyway: it is cheap cover against whatever the next leak turns out to
# be, and against a machine that is already in the frozen state it exists to
# recover from.
#
# SAFETY
#  - Matches ONLY processes whose command line contains 'broker-browser-'.
#    Your real Chrome/Edge and the Playwright MCP pool (which uses msedge.exe
#    and playwright-review-*/playwright-stateful-* profiles) are NOT touched.
#  - Kills by explicit PID, never by image name, so it satisfies
#    kill-others-prevention-guard and cannot take out a sibling agent's work.
#  - Default is a DRY RUN. Pass -Execute to actually terminate.
#
# USAGE (this same first-party script, invoked three ways)
# external-ref-ok-next-line: this repository's own script, run with no flags
#   .\reap-broker-browsers.ps1              # report only
# external-ref-ok-next-line: this repository's own script, run with -Execute
#   .\reap-broker-browsers.ps1 -Execute     # kill leaked browsers
# external-ref-ok-next-line: this repository's own script, run with -Execute -PruneDirs -OlderThanHours
#   .\reap-broker-browsers.ps1 -Execute -PruneDirs -OlderThanHours 6

[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$PruneDirs,
    [int]$OlderThanHours = 0
)

$ErrorActionPreference = 'Stop'
$marker = 'broker-browser-'

$procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $marker })

if ($OlderThanHours -gt 0) {
    $cutoff = (Get-Date).AddHours(-$OlderThanHours)
    $procs = @($procs | Where-Object { $_.CreationDate -and $_.CreationDate -lt $cutoff })
}

# Root browsers are the ones to kill; their renderer children die with them.
$rootPids = @($procs | Where-Object {
        $ppid = $_.ParentProcessId
        -not ($procs.ProcessId -contains $ppid)
    } | Select-Object -ExpandProperty ProcessId)

Write-Output "Leaked broker browser processes : $($procs.Count)"
Write-Output "Root browsers to terminate      : $($rootPids.Count)"

if (-not $Execute) {
    Write-Output ''
    Write-Output 'DRY RUN — nothing terminated. Re-run with -Execute to act.'
}
else {
    $ok = 0
    $gone = 0
    foreach ($procId in $rootPids) {
        # Explicit single-PID form: scoped, and never image-name based.
        #
        # A process that exited between the enumeration above and this kill is
        # the ORDINARY race for a sweeper, not a fault: the list is a snapshot,
        # and a browser that finished on its own is the outcome wanted anyway.
        # taskkill reports it as 'not found' on stderr, and with
        # $ErrorActionPreference = 'Stop' a native command's stderr becomes a
        # terminating error -- which aborts the sweep partway through, so the
        # kills already issued stand while -PruneDirs below never runs and the
        # operator sees a stack trace on a run that mostly succeeded.
        #
        # The exit code carries the outcome instead, and the three cases are
        # reported apart so a genuine failure is still visible.
        $output = (& taskkill.exe /F /PID $procId 2>&1 | Out-String)
        if ($LASTEXITCODE -eq 0) { $ok++ }
        elseif ($output -match 'not found') { $gone++ }
        else { Write-Output "  could not terminate ${procId}: $($output.Trim())" }
    }
    Write-Output "Terminated                      : $ok / $($rootPids.Count)"
    if ($gone -gt 0) {
        Write-Output "Already exited before the kill  : $gone"
    }

    Start-Sleep -Seconds 2
    $left = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $marker })
    Write-Output "Remaining after sweep           : $($left.Count)"
}

# Deliberately OUTSIDE the kill block above, and reached whatever that block
# did. Pruning stale directories does not depend on the sweep having gone
# well: the directories of browsers that are already gone are exactly what is
# being cleared, and an operator who asked for a prune should get one even if
# a kill failed for a reason this script did not anticipate.
if ($PruneDirs) {
    $dirs = @(Get-ChildItem -Path $env:TEMP -Directory -Filter "$marker*" -ErrorAction SilentlyContinue)
    if ($OlderThanHours -gt 0) {
        $cutoff = (Get-Date).AddHours(-$OlderThanHours)
        $dirs = @($dirs | Where-Object { $_.LastWriteTime -lt $cutoff })
    }
    Write-Output "Stale profile directories       : $($dirs.Count)"
    if ($Execute) {
        $removed = 0
        $held = 0
        foreach ($d in $dirs) {
            # A directory still held open by a browser that has not finished
            # exiting is expected here and is not worth aborting the sweep
            # over -- it will be removable on the next run. Counted rather
            # than silently swallowed, so a prune that clears nothing says so.
            try { Remove-Item $d.FullName -Recurse -Force -ErrorAction Stop; $removed++ }
            catch { $held++ }
        }
        Write-Output "Directories removed             : $removed"
        if ($held -gt 0) {
            Write-Output "Still held (retry later)        : $held"
        }
    }
}
