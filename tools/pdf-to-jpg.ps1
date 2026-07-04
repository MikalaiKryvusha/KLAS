# tools/pdf-to-jpg.ps1 — конвертация PDF → JPG постранично, в высоком разрешении, БЕЗ установок.
# Использует встроенный в Windows WinRT Windows.Data.Pdf (рендер страниц в битмап) + System.Drawing
# (сохранение в JPEG). Выход — папка pdf2jpg/ (вне git).
#
# Запуск:
#   powershell -File tools\pdf-to-jpg.ps1                 # README.pdf + LINKS.local.pdf
#   powershell -File tools\pdf-to-jpg.ps1 -Pdf путь.pdf   # конкретный файл
#   -Scale 3 (плотность; 3 ≈ ~288dpi) · -Quality 92 · -OutDir pdf2jpg
param(
    [string]$Pdf = '',
    [string]$OutDir = 'pdf2jpg',
    [int]$Scale = 3,
    [int]$Quality = 92
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot            # корень KLAS

# --- WinRT + System.Drawing ---
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# --- Хелперы await для WinRT-асинхронщины ---
$asTasks = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$opMethod = $asTasks | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$actMethod = $asTasks | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function AwaitOp($op, $type) { $t = $opMethod.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAct($act) { $t = $actMethod.Invoke($null, @($act)); $t.Wait(-1) | Out-Null }

# JPEG-энкодер с качеством
$jpegEnc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

function Convert-Pdf($pdfPath, $outDir) {
    $pdfPath = (Resolve-Path $pdfPath).Path
    $base = [System.IO.Path]::GetFileNameWithoutExtension($pdfPath)
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfPath)) ([Windows.Storage.StorageFile])
    $doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    for ($i = 0; $i -lt $doc.PageCount; $i++) {
        $page = $doc.GetPage($i)
        $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
        $opt.DestinationHeight = [uint32]([math]::Round($page.Size.Height * $Scale))   # высокое разрешение
        AwaitAct ($page.RenderToStreamAsync($stream, $opt))
        $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
        $img = [System.Drawing.Image]::FromStream($net)
        $out = Join-Path $outDir ("{0}.p{1}.jpg" -f $base, ($i + 1))
        $w = $img.Width; $h = $img.Height
        $img.Save($out, $jpegEnc, $encParams)
        $img.Dispose(); $net.Dispose(); $page.Dispose()
        Write-Host ("[ok] {0}  ({1}x{2})" -f $out, $w, $h)
    }
}

$outAbs = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $root $OutDir }
$targets = if ($Pdf) { @($Pdf) } else { @("$root\README.pdf", "$root\LINKS.local.pdf") }
foreach ($t in $targets) {
    if (Test-Path $t) { Convert-Pdf $t $outAbs } else { Write-Host "пропуск (нет файла): $t" }
}
Write-Host "Готово. JPG в: $outAbs"
