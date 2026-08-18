<#
  make-icons.ps1 — 生成 Tab Volume 999 扩展图标（16 / 32 / 48 / 128）
  运行方式：
      powershell -ExecutionPolicy Bypass -File .\tools\make-icons.ps1
#>

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Icon {
  param([int]$S, [string]$Path)

  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # ---- 圆角矩形背景（纯黑，无渐变） ----
  $bgPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $radius = $S * 0.22
  $d = $radius * 2
  $bgPath.AddArc(0, 0, $d, $d, 180, 90)
  $bgPath.AddArc($S - $d, 0, $d, $d, 270, 90)
  $bgPath.AddArc($S - $d, $S - $d, $d, $d, 0, 90)
  $bgPath.AddArc(0, $S - $d, $d, $d, 90, 90)
  $bgPath.CloseFigure()

  # 纯黑背景（呼应面板“主黑”）
  $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::Black)
  $g.FillPath($brush, $bgPath)

  $white = [System.Drawing.Brushes]::White

  if ($S -ge 32) {
    # ---- 扬声器箱体（圆角矩形） ----
    $g.FillRectangle($white, [System.Drawing.RectangleF]::new($S * 0.14, $S * 0.40, $S * 0.18, $S * 0.20))

    # ---- 锥形号角（三角形） ----
    $cone = [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new($S * 0.32, $S * 0.40),
      [System.Drawing.PointF]::new($S * 0.32, $S * 0.60),
      [System.Drawing.PointF]::new($S * 0.50, $S * 0.74),
      [System.Drawing.PointF]::new($S * 0.50, $S * 0.26)
    )
    $g.FillPolygon($white, $cone)

    # ---- 声波（两道紧贴喇叭口的弧线） ----
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, [math]::Max(1, $S * 0.05))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    # 第一道：圆心 (0.55S, 0.50S)，半径 0.08S
    $g.DrawArc($pen, [System.Drawing.RectangleF]::new($S * 0.47, $S * 0.42, $S * 0.16, $S * 0.16), -50, 100)
    # 第二道：圆心 (0.60S, 0.50S)，半径 0.13S
    $g.DrawArc($pen, [System.Drawing.RectangleF]::new($S * 0.47, $S * 0.37, $S * 0.26, $S * 0.26), -45, 90)
    $pen.Dispose()
  } else {
    # ---- 16px：只保留箱体 + 锥形，保证小尺寸辨识度 ----
    $g.FillRectangle($white, [System.Drawing.RectangleF]::new($S * 0.18, $S * 0.38, $S * 0.20, $S * 0.24))
    $cone = [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new($S * 0.38, $S * 0.38),
      [System.Drawing.PointF]::new($S * 0.38, $S * 0.62),
      [System.Drawing.PointF]::new($S * 0.58, $S * 0.76),
      [System.Drawing.PointF]::new($S * 0.58, $S * 0.24)
    )
    $g.FillPolygon($white, $cone)
  }

  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $bgPath.Dispose(); $brush.Dispose()
  Write-Host "已生成: $Path"
}

foreach ($size in @(16, 32, 48, 128)) {
  New-Icon -S $size -Path (Join-Path $outDir "icon$size.png")
}

Write-Host '图标生成完毕。'
