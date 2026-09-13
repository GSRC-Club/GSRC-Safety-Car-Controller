$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$synth = Join-Path $PSScriptRoot 'synth-speech.ps1'
$target = Join-Path $root 'assets\voice'
New-Item -ItemType Directory -Path $target -Force | Out-Null

$phrases = [ordered]@{
    'code80-deploying' = 'Attention drivers. GSRC Code eighty is deploying in ten seconds. Lift now. Limit eighty kilometres per hour. No overtaking.'
    'code80-active' = 'Code eighty is active. Eighty kilometres per hour maximum. No overtaking.'
    'field-stable' = 'Field stable. Hold eighty kilometres per hour and maintain order.'
    'no-overtaking' = 'Reminder. No overtaking. Maintain the locked order unless Race Control directs you.'
    'one-to-green' = 'One to green. The leader controls the pace. Hold order. No overtaking until the control line.'
    'restart-armed' = 'Restart armed. The leader may accelerate in the restart zone. No overtaking before the control line.'
    'green' = 'Green flag. Racing resumed.'
    'wave-prefix' = 'You are waved around number'
}
foreach ($entry in $phrases.GetEnumerator()) {
    & $synth -Text $entry.Value -OutputPath (Join-Path $target ($entry.Key + '.wav')) -Rate 1 -Volume 100
}
foreach ($digit in 0..9) {
    $word = @('zero','one','two','three','four','five','six','seven','eight','nine')[$digit]
    & $synth -Text $word -OutputPath (Join-Path $target ("digit-$digit.wav")) -Rate 1 -Volume 100
}
