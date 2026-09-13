param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [int]$Rate = 0,
    [int]$Volume = 100
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$voice = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $voice.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
    $voice.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $voice.SetOutputToWaveFile($OutputPath, $format)
    $voice.Speak($Text)
} finally {
    $voice.Dispose()
}
