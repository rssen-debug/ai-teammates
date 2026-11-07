$ErrorActionPreference='Stop'
$dir=Join-Path $PSScriptRoot 'models'
New-Item -ItemType Directory -Force $dir | Out-Null
$py=if(Get-Command py -ErrorAction SilentlyContinue){'py'}elseif(Get-Command python -ErrorAction SilentlyContinue){'python'}else{throw 'Install Python 3 first'}
$argsPy=if($py -eq 'py'){@('-3','-m','pip','install','--user','kokoro-onnx','soundfile')}else{@('-m','pip','install','--user','kokoro-onnx','soundfile')}
& $py @argsPy
if($LASTEXITCODE -ne 0){throw 'Python dependency install failed'}
$files=@(
  @{Name='kokoro-v1.0.onnx';Url='https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx';Min=20000000},
  @{Name='voices-v1.0.bin';Url='https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin';Min=100000}
)
foreach($f in $files){
  $dest=Join-Path $dir $f.Name
  if((Test-Path $dest) -and (Get-Item $dest).Length -gt $f.Min){continue}
  $temp=$dest+'.partial'
  try {
    Invoke-WebRequest -Uri $f.Url -OutFile $temp -MaximumRedirection 6
    if((Get-Item $temp).Length -lt $f.Min){throw 'Incomplete Kokoro model download'}
    Move-Item -Force $temp $dest
  } finally {if(Test-Path $temp){Remove-Item -Force $temp}}
}
Get-ChildItem $dir | Get-FileHash -Algorithm SHA256 | Format-Table Hash,Path
Write-Host 'Kokoro voice installed. Start local service: python scripts/majin-kokoro-voice.py'
Write-Host 'This is an opt-in CPU voice pack; never auto-started and no recorded microphone audio is uploaded by this service.'
