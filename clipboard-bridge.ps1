[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32ClipboardSeq {
    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();
}
"@

$sha256 = [System.Security.Cryptography.SHA256]::Create()

function Get-ClipboardBitmap {
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        try {
            if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
                $img = [System.Windows.Forms.Clipboard]::GetImage()
                if ($null -ne $img) { return $img }
            }
            if ([System.Windows.Forms.Clipboard]::ContainsData("PNG")) {
                $pngData = [System.Windows.Forms.Clipboard]::GetData("PNG")
                if ($pngData -is [System.IO.Stream]) {
                    return [System.Drawing.Image]::FromStream($pngData)
                }
            }
            if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
                $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
                if ($files.Count -gt 0) {
                    $firstFile = $files[0]
                    if ($firstFile -match '\.(png|jpg|jpeg|bmp|gif|webp)$' -and (Test-Path $firstFile)) {
                        $bytes = [System.IO.File]::ReadAllBytes($firstFile)
                        $ms = New-Object System.IO.MemoryStream(,$bytes)
                        return [System.Drawing.Image]::FromStream($ms)
                    }
                }
            }
            return $null
        } catch {
            Start-Sleep -Milliseconds 60
        }
    }
    return $null
}

function Set-ClipboardBitmapWithRetry($bmp) {
    $lastErr = $null
    for ($i = 0; $i -lt 6; $i++) {
        try {
            [System.Windows.Forms.Clipboard]::SetImage($bmp)
            return $true
        } catch {
            $lastErr = $_
            Start-Sleep -Milliseconds 80
        }
    }
    try {
        [System.Windows.Forms.Clipboard]::SetDataObject($bmp, $true, 8, 80)
        return $true
    } catch {
        throw $lastErr
    }
}

function Write-JsonResponse($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

Write-JsonResponse @{ status = "READY" }

while ($null -ne ($line = [Console]::In.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $reqId = $null
    try {
        $req = $line | ConvertFrom-Json
        $cmd = $req.cmd
        $id = $req.id
        $reqId = $id

        if ($cmd -eq "GET_IMAGE") {
            $seq = [Win32ClipboardSeq]::GetClipboardSequenceNumber()
            $lastSeq = $req.lastSeq
            if ($lastSeq -and ($lastSeq -eq $seq)) {
                Write-JsonResponse @{
                    id = $id
                    ok = $true
                    hasImage = $true
                    unchanged = $true
                    seq = $seq
                    hash = $req.lastHash
                }
                continue
            }

            $img = Get-ClipboardBitmap
            if ($null -eq $img) {
                Write-JsonResponse @{ id = $id; ok = $true; hasImage = $false; seq = $seq }
            } else {
                $ms = New-Object System.IO.MemoryStream
                $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $bytes = $ms.ToArray()
                $hashBytes = $sha256.ComputeHash($bytes)
                $hash = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToLower()

                $lastHash = $req.lastHash
                if ($lastHash -and ($lastHash -eq $hash)) {
                    Write-JsonResponse @{
                        id = $id
                        ok = $true
                        hasImage = $true
                        unchanged = $true
                        seq = $seq
                        hash = $hash
                        width = $img.Width
                        height = $img.Height
                    }
                } else {
                    $b64 = [System.Convert]::ToBase64String($bytes)
                    Write-JsonResponse @{
                        id = $id
                        ok = $true
                        hasImage = $true
                        unchanged = $false
                        seq = $seq
                        hash = $hash
                        width = $img.Width
                        height = $img.Height
                        dataUrl = "data:image/png;base64," + $b64
                    }
                }
                $ms.Dispose()
                $img.Dispose()
            }
        }
        elseif ($cmd -eq "SET_IMAGE") {
            $filePath = $req.filePath
            if (-not (Test-Path $filePath)) {
                Write-JsonResponse @{ id = $id; ok = $false; error = "File not found: $filePath" }
            } else {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $hashBytes = $sha256.ComputeHash($bytes)
                $hash = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToLower()

                $ms = New-Object System.IO.MemoryStream(,$bytes)
                $tempImg = [System.Drawing.Image]::FromStream($ms)
                $bmp = New-Object System.Drawing.Bitmap($tempImg)
                $null = Set-ClipboardBitmapWithRetry $bmp

                $width = $bmp.Width
                $height = $bmp.Height
                $bmp.Dispose()
                $tempImg.Dispose()
                $ms.Dispose()

                $seq = [Win32ClipboardSeq]::GetClipboardSequenceNumber()

                # 回读系统剪贴板实际存储的图像并计算 GDI+ PNG 指纹
                $readBackImg = Get-ClipboardBitmap
                if ($null -ne $readBackImg) {
                    $rbMs = New-Object System.IO.MemoryStream
                    $readBackImg.Save($rbMs, [System.Drawing.Imaging.ImageFormat]::Png)
                    $rbBytes = $rbMs.ToArray()
                    $rbHashBytes = $sha256.ComputeHash($rbBytes)
                    $hash = [System.BitConverter]::ToString($rbHashBytes).Replace("-", "").ToLower()
                    $rbMs.Dispose()
                    $readBackImg.Dispose()
                }

                Write-JsonResponse @{
                    id = $id
                    ok = $true
                    seq = $seq
                    hash = $hash
                    width = $width
                    height = $height
                }
            }
        }
        elseif ($cmd -eq "SCREENCLIP") {
            Start-Process "ms-screenclip:"
            Write-JsonResponse @{ id = $id; ok = $true }
        }
        else {
            Write-JsonResponse @{ id = $id; ok = $false; error = "Unknown cmd: $cmd" }
        }
    } catch {
        Write-JsonResponse @{ id = $reqId; ok = $false; error = $_.Exception.Message }
    }
}
