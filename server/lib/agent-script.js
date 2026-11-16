// Printer dasturi: bitta .cmd fayl (ichida PowerShell). Windows 10/11 da hech narsa o'rnatmasdan ishlaydi.
// Admin panel "Dasturni yuklab olish" tugmasi bosilganda sayt manzili va yangi kalit bilan yasaladi.
// Fayl boshidagi (batch) qism har versiyada bayt-baybayt bir xil bo'lishi shart — yangi nusxa eski nusxa
// ustiga yozilganda ishlab turgan cmd.exe xato qatorni o'qib qolmasligi uchun. O'zgaruvchilar faqat pastda.

export const AGENT_VERSION = '1.0.0';

const HEAD = [
  '<# : batch portion',
  '@echo off',
  'title Oqtosh printer',
  'set "OQ_SELF=%~f0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:OQ_SELF))"',
  'if errorlevel 1 pause',
  'exit /b',
  ': end batch / begin PowerShell #>',
];

const BODY = String.raw`
# ================================================================
#  Oqtosh restoran - printer dasturi (kassa kompyuterida ishlaydi)
#  * Wi-Fi / LAN tarmoqdagi chek printerlarini topadi (9100-port)
#  * Windows'ga ulangan (USB) printerlarni ko'radi
#  * Saytdan kelgan oshxona va kassa cheklarini printerlarga chiqaradi
#  Bu faylni boshqalarga bermang: ichida restoraningiz kaliti bor.
# ================================================================
$ErrorActionPreference = 'Stop'
$AgentVersion = '__VERSION__'
$EmbeddedSite = '__SITE__'
$EmbeddedKey = '__KEY__'

# Windows PowerShell 5.1: ro'yxatlar JSON'da {"value":[...],"Count":n} bo'lib ketmasligi uchun
try { Remove-TypeData System.Array -ErrorAction SilentlyContinue } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch {}
try { [Net.ServicePointManager]::DefaultConnectionLimit = 16; [Net.ServicePointManager]::Expect100Continue = $false } catch {}

$AppDir = Join-Path $env:APPDATA 'OqtoshPrinter'
$InstalledCmd = Join-Path $AppDir 'oqtosh-printer.cmd'
$LogFile = Join-Path $AppDir 'log.txt'
$StopFile = Join-Path $AppDir 'stop.flag'
$ConfigFile = Join-Path $AppDir 'config.json'
if (-not (Test-Path -LiteralPath $AppDir)) { [void](New-Item -ItemType Directory -Path $AppDir -Force) }

function Say([string]$text, [string]$color = 'Gray') {
  $line = (Get-Date).ToString('dd.MM HH:mm:ss') + '  ' + $text
  try { Write-Host $line -ForegroundColor $color } catch { Write-Host $line }
  try {
    if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 1048576)) {
      Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.old') -Force
    }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  } catch {}
}

function Set-Title([string]$t) {
  try { $Host.UI.RawUI.WindowTitle = 'Oqtosh printer - ' + $t } catch {}
}

function Sleep-Smart([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Path -LiteralPath $StopFile) { return }
    Start-Sleep -Seconds 1
  }
}

# ---------- sozlama (sayt manzili o'zgarsa config.json ga yoziladi) ----------
$script:Site = $EmbeddedSite
$script:Key = $EmbeddedKey
try {
  if (Test-Path -LiteralPath $ConfigFile) {
    $saved = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if ([string]$saved.key -eq $EmbeddedKey -and [string]$saved.site -match '^https?://') { $script:Site = [string]$saved.site }
  }
} catch {}

function Save-Config {
  try {
    $o = @{ site = $script:Site; key = $script:Key }
    Set-Content -LiteralPath $ConfigFile -Value (ConvertTo-Json -InputObject $o -Compress) -Encoding UTF8
  } catch {}
}

# ---------- bitta nusxa: yangi fayl ishga tushsa eskisi o'zi yopiladi ----------
$Mutex = New-Object Threading.Mutex($false, 'Local\OqtoshPrinterAgent')
$have = $false
try { $have = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $have = $true }
if (-not $have) {
  Say 'Oldingi oyna ishlab turibdi - uni yopib, yangisini ishga tushiraman (1 daqiqagacha)...' 'Yellow'
  Set-Content -LiteralPath $StopFile -Value '1'
  try { $have = $Mutex.WaitOne(90000) } catch [Threading.AbandonedMutexException] { $have = $true }
  if (-not $have) {
    Say 'Oldingi oyna yopilmadi. Uni qo''lda yoping va qayta ishga tushiring.' 'Red'
    Start-Sleep -Seconds 20
    exit 1
  }
}
Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue

# ---------- kompyuter yoqilganda o'zi ishga tushsin ----------
function Install-Self {
  try {
    $self = [string]$env:OQ_SELF
    if ($self -and (Test-Path -LiteralPath $self) -and ($self -ne $InstalledCmd)) {
      Copy-Item -LiteralPath $self -Destination $InstalledCmd -Force
    }
    if (Test-Path -LiteralPath $InstalledCmd) {
      $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Oqtosh printer.lnk'
      $sh = New-Object -ComObject WScript.Shell
      $s = $sh.CreateShortcut($lnk)
      $s.TargetPath = $InstalledCmd
      $s.WorkingDirectory = $AppDir
      $s.WindowStyle = 7
      $s.Description = 'Oqtosh restoran - printer dasturi'
      $s.Save()
      return $true
    }
  } catch {
    Say ('Avtomatik ishga tushishni sozlab bo''lmadi: ' + $_.Exception.Message) 'Yellow'
  }
  return $false
}

# ---------- USB / Windows printerlariga to'g'ridan-to'g'ri (RAW) yozish ----------
$WinRaw = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OqRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DocInfo {
    [MarshalAs(UnmanagedType.LPWStr)] public string Name;
    [MarshalAs(UnmanagedType.LPWStr)] public string Output;
    [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr handle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DocInfo info);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
  public static string Send(string printer, byte[] data, string title) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "printer ochilmadi (" + Marshal.GetLastWin32Error() + ")";
    try {
      DocInfo di = new DocInfo();
      di.Name = title;
      di.DataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "chek boshlanmadi (" + Marshal.GetLastWin32Error() + ")";
      try {
        StartPagePrinter(h);
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != data.Length) return "printerga yozilmadi (" + Marshal.GetLastWin32Error() + ")";
      } finally {
        EndDocPrinter(h);
      }
      return "";
    } finally {
      ClosePrinter(h);
    }
  }
}
'@
  $WinRaw = $true
} catch {
  Say ('USB printer moduli yuklanmadi (Wi-Fi printerlar baribir ishlaydi): ' + $_.Exception.Message) 'Yellow'
}

# ---------- tarmoq ----------
function Get-LocalIPs {
  $ips = @()
  try {
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { [string]$_.IPAddress -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { [string]$_.IPAddress })
  } catch {}
  if ($ips.Count -eq 0) {
    try {
      $ips = @(Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = True' -ErrorAction Stop | ForEach-Object { $_.IPAddress } | Where-Object { [string]$_ -match '^\d+\.\d+\.\d+\.\d+$' -and [string]$_ -notmatch '^(127\.|169\.254\.)' } | ForEach-Object { [string]$_ })
    } catch {}
  }
  return ,@($ips | Select-Object -Unique)
}

function Get-Mac([string]$ip) {
  try {
    $n = Get-NetNeighbor -IPAddress $ip -ErrorAction Stop | Select-Object -First 1
    $m = ([string]$n.LinkLayerAddress) -replace '[^0-9A-Fa-f]', ''
    if ($m.Length -eq 12 -and $m -ne '000000000000') { return $m.ToUpper() }
  } catch {}
  try {
    foreach ($line in @(arp -a $ip)) {
      if ([string]$line -match '([0-9a-fA-F]{2}[-:]){5}[0-9a-fA-F]{2}') { return ($matches[0] -replace '[^0-9A-Fa-f]', '').ToUpper() }
    }
  } catch {}
  return ''
}

# SNMP (faqat o'qish): printer modelini bilish uchun. 9100-portga hech narsa yuborilmaydi -
# oddiy ofis printerlari ham shu portda bo'ladi va keraksiz qog'oz chiqarmasligi kerak.
function Get-SnmpName([string]$ip) {
  $u = New-Object Net.Sockets.UdpClient
  try {
    $u.Client.ReceiveTimeout = 700
    $pkt = [byte[]](0x30,0x29,0x02,0x01,0x00,0x04,0x06,0x70,0x75,0x62,0x6c,0x69,0x63,0xa0,0x1c,0x02,0x04,0x00,0x00,0x00,0x01,0x02,0x01,0x00,0x02,0x01,0x00,0x30,0x0e,0x30,0x0c,0x06,0x08,0x2b,0x06,0x01,0x02,0x01,0x01,0x01,0x00,0x05,0x00)
    [void]$u.Send($pkt, $pkt.Length, $ip, 161)
    $ep = New-Object Net.IPEndPoint([Net.IPAddress]::Any, 0)
    $r = $u.Receive([ref]$ep)
    $oid = [byte[]](0x06,0x08,0x2b,0x06,0x01,0x02,0x01,0x01,0x01,0x00)
    for ($i = 0; $i -lt ($r.Length - $oid.Length - 2); $i++) {
      $hit = $true
      for ($j = 0; $j -lt $oid.Length; $j++) { if ($r[$i + $j] -ne $oid[$j]) { $hit = $false; break } }
      if (-not $hit) { continue }
      $k = $i + $oid.Length
      if ($r[$k] -ne 0x04) { return '' }
      $len = [int]$r[$k + 1]
      $start = $k + 2
      if ($len -eq 0x81) { $len = [int]$r[$k + 2]; $start = $k + 3 }
      elseif ($len -eq 0x82) { $len = [int]$r[$k + 2] * 256 + [int]$r[$k + 3]; $start = $k + 4 }
      if ($start + $len -gt $r.Length) { $len = $r.Length - $start }
      if ($len -le 0) { return '' }
      $s = [Text.Encoding]::ASCII.GetString($r, $start, $len)
      $s = ($s -replace '[^\x20-\x7e]', ' ') -replace '\s+', ' '
      if ($s.Length -gt 100) { $s = $s.Substring(0, 100) }
      return $s.Trim()
    }
  } catch {} finally { $u.Close() }
  return ''
}

# Butun tarmoqni bir vaqtda tekshirish: 254 manzil x 9100-port, ~3 soniya
function Find-Printers9100($subnets, $probe, $own) {
  $targets = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($s in @($subnets)) {
    for ($i = 1; $i -le 254; $i++) {
      $ip = [string]$s + '.' + $i
      if (@($own) -contains $ip) { continue }
      $key = $ip + ':9100'
      if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; [void]$targets.Add(@($ip, 9100)) }
    }
  }
  foreach ($p in @($probe)) {
    if ($null -eq $p -or -not $p.ip) { continue }
    $port = [int]$p.port
    if ($port -le 0) { $port = 9100 }
    $key = [string]$p.ip + ':' + $port
    if (-not $seen.ContainsKey($key)) { $seen[$key] = 1; [void]$targets.Add(@([string]$p.ip, $port)) }
  }
  $pending = New-Object System.Collections.ArrayList
  foreach ($t in $targets) {
    $c = New-Object Net.Sockets.TcpClient
    try {
      $ar = $c.BeginConnect([string]$t[0], [int]$t[1], $null, $null)
      [void]$pending.Add(@([string]$t[0], [int]$t[1], $c, $ar))
    } catch { $c.Close() }
  }
  Start-Sleep -Milliseconds 2500
  $found = New-Object System.Collections.ArrayList
  foreach ($p in $pending) {
    $ok = $false
    if ($p[3].IsCompleted) { try { $p[2].EndConnect($p[3]); $ok = $true } catch {} }
    try { $p[2].Close() } catch {}
    if ($ok) { [void]$found.Add(@{ ip = $p[0]; port = $p[1] }) }
  }
  return ,$found.ToArray()
}

function Get-WinPrinters {
  $hosts = @{}
  try {
    foreach ($p in @(Get-WmiObject Win32_TCPIPPrinterPort -ErrorAction Stop)) { $hosts[[string]$p.Name] = [string]$p.HostAddress }
  } catch {}
  $list = New-Object System.Collections.ArrayList
  try {
    foreach ($p in @(Get-WmiObject Win32_Printer -ErrorAction Stop)) {
      $n = [string]$p.Name
      if ($n -match 'PDF|XPS|OneNote|Fax|Send To|AnyDesk|Snagit|Microsoft') { continue }
      $h = ''
      if ($hosts.ContainsKey([string]$p.PortName)) { $h = [string]$hosts[[string]$p.PortName] }
      [void]$list.Add(@{ type = 'win'; name = $n; port = [string]$p.PortName; driver = [string]$p.DriverName; host = $h; offline = [bool]$p.WorkOffline })
    }
  } catch {}
  return ,$list.ToArray()
}

function Send-Net([string]$ip, [int]$port, [byte[]]$data) {
  if ($port -le 0) { $port = 9100 }
  $c = New-Object Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect($ip, $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(4000)) { throw ('printer javob bermadi (' + $ip + ')') }
    $c.EndConnect($ar)
    $c.SendTimeout = 10000
    $st = $c.GetStream()
    $st.Write($data, 0, $data.Length)
    $st.Flush()
    Start-Sleep -Milliseconds 300
  } finally {
    $c.Close()
  }
}

# ---------- sayt bilan aloqa ----------
function Call-Api([string]$method, [string]$path, $body) {
  $uri = $script:Site.TrimEnd('/') + $path
  $headers = @{ 'X-Oq-Agent' = $script:Key }
  if ($null -ne $body) {
    $json = ConvertTo-Json -InputObject $body -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30 -UseBasicParsing
  }
  return Invoke-RestMethod -Method $method -Uri $uri -Headers $headers -TimeoutSec 30 -UseBasicParsing
}

$script:RingUrl = ''
$script:RingReader = $null
$script:RingResp = $null
$script:RingFails = 0
$script:RingSaid = $false
$script:RingOffUntil = [DateTime]::MinValue
$script:Poll = 15
$script:IdlePoll = 60
$script:Probe = @()
$script:NeedScan = $true
$script:LastScan = [DateTime]::MinValue
$script:LastJobAt = Get-Date
$script:Done = @{}
$script:Printed = 0
$script:Fails = 0
$script:RetrySoon = $false

function Close-Ring {
  try { if ($null -ne $script:RingReader) { $script:RingReader.Dispose() } } catch {}
  try { if ($null -ne $script:RingResp) { $script:RingResp.Close() } } catch {}
  $script:RingReader = $null
  $script:RingResp = $null
}

function Apply-Reply($r) {
  if ($null -eq $r) { return }
  if ($null -ne $r.ring) {
    $u = [string]$r.ring
    if ($u -ne $script:RingUrl) { Close-Ring; $script:RingUrl = $u; $script:RingSaid = $false; $script:RingFails = 0 }
  }
  if ($r.poll) { $script:Poll = [Math]::Max(5, [int]$r.poll) }
  if ($r.idlePoll) { $script:IdlePoll = [Math]::Max(5, [int]$r.idlePoll) }
  if ($null -ne $r.probe) { $script:Probe = @($r.probe) }
  if ($r.scan) { $script:NeedScan = $true }
  if ($r.site -and ([string]$r.site -match '^https://') -and ([string]$r.site -ne $script:Site)) {
    $script:Site = [string]$r.site
    Save-Config
    Say ('Sayt manzili yangilandi: ' + $script:Site) 'Cyan'
  }
}

function Do-Hello([bool]$scan) {
  $ips = Get-LocalIPs
  $subnets = @($ips | ForEach-Object { (([string]$_ -split '\.')[0..2]) -join '.' } | Select-Object -Unique | Select-Object -First 4)
  $printers = New-Object System.Collections.ArrayList
  if ($scan) {
    Set-Title 'printerlar qidirilmoqda...'
    Say ('Printerlar qidirilmoqda: ' + ((@($subnets) | ForEach-Object { $_ + '.*' }) -join ', '))
    foreach ($n in (Find-Printers9100 $subnets $script:Probe $ips)) {
      $mac = Get-Mac ([string]$n.ip)
      $model = Get-SnmpName ([string]$n.ip)
      [void]$printers.Add(@{ type = 'net'; ip = [string]$n.ip; port = [int]$n.port; mac = $mac; model = $model })
      $extra = ''
      if ($model) { $extra = '  ' + $model }
      Say ('  Wi-Fi/LAN printer: ' + $n.ip + ':' + $n.port + $extra) 'Green'
    }
    foreach ($w in (Get-WinPrinters)) {
      [void]$printers.Add($w)
      Say ('  Windows printer: ' + $w.name) 'Green'
    }
    if ($printers.Count -eq 0) { Say '  Printer topilmadi. Printer yoqilganini va shu Wi-Fi tarmoqqa ulanganini tekshiring.' 'Yellow' }
  }
  $body = @{ host = [string]$env:COMPUTERNAME; user = [string]$env:USERNAME; version = $AgentVersion; ips = @($ips); subnets = @($subnets); scanned = $scan; printers = $printers.ToArray(); winRaw = $WinRaw }
  $r = Call-Api 'POST' '/api/print-agent/hello' $body
  Apply-Reply $r
  if ($scan) { $script:LastScan = Get-Date; $script:NeedScan = $false }
}

function Print-Job($j) {
  $id = [string]$j.id
  $type = [string]$j.printer.type
  $where = [string]$j.printer.ip
  if ($type -eq 'win') { $where = [string]$j.printer.name }
  if (-not $script:Done.ContainsKey($id)) {
    $err = ''
    try {
      $bytes = [Convert]::FromBase64String([string]$j.data)
      $copies = [Math]::Max(1, [int]$j.copies)
      for ($n = 0; $n -lt $copies; $n++) {
        if ($type -eq 'win') {
          if (-not $WinRaw) { throw 'USB printer moduli ishlamayapti' }
          $e = [OqRawPrint]::Send([string]$j.printer.name, $bytes, [string]$j.title)
          if ($e) { throw $e }
        } else {
          Send-Net ([string]$j.printer.ip) ([int]$j.printer.port) $bytes
        }
      }
    } catch {
      $err = $_.Exception.Message
    }
    if ($err) {
      Say ('XATO: ' + [string]$j.title + ' -> ' + $where + ': ' + $err) 'Red'
      if ($type -ne 'win') { $script:NeedScan = $true }
      $script:RetrySoon = $true
      try { [void](Call-Api 'POST' ('/api/print-agent/jobs/' + $id) @{ status = 'retry'; error = $err }) } catch {}
      return
    }
    $script:Done[$id] = Get-Date
    $script:Printed++
    $script:LastJobAt = Get-Date
    Say ('Chiqdi: ' + [string]$j.title + '  -> ' + $where) 'Green'
  }
  try {
    [void](Call-Api 'POST' ('/api/print-agent/jobs/' + $id) @{ status = 'done' })
  } catch {
    Say ('Saytga "chiqdi" deb yozilmadi (keyin qayta yuboriladi): ' + $_.Exception.Message) 'Yellow'
  }
}

function Do-Jobs {
  $r = Call-Api 'GET' '/api/print-agent/jobs' $null
  Apply-Reply $r
  $script:RetrySoon = $false
  if ($r.jobs) {
    foreach ($j in @($r.jobs)) { Print-Job $j }
  }
  if ($script:Done.Count -gt 400) {
    $old = (Get-Date).AddHours(-12)
    foreach ($k in @($script:Done.Keys)) { if ($script:Done[$k] -lt $old) { $script:Done.Remove($k) } }
  }
  if ($script:NeedScan) { Do-Hello $true }
}

# "Qo'ng'iroq": yangi chek paydo bo'lishi bilan sayt shu ulanish orqali xabar beradi (SSE)
function Wait-Ring([int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  try {
    if ($null -eq $script:RingReader) {
      $req = [Net.HttpWebRequest]::Create($script:RingUrl)
      $req.Accept = 'text/event-stream'
      $req.Timeout = 20000
      $req.ReadWriteTimeout = 70000
      $resp = $req.GetResponse()
      $script:RingResp = $resp
      $script:RingReader = New-Object IO.StreamReader($resp.GetResponseStream())
      if (-not $script:RingSaid) { Say "Qo'ng'iroq ulandi - cheklar darhol chiqadi." 'Green'; $script:RingSaid = $true }
    }
    $evt = ''
    while ((Get-Date) -lt $until) {
      if (Test-Path -LiteralPath $StopFile) { return $false }
      $line = $script:RingReader.ReadLine()
      if ($null -eq $line) { throw 'ulanish yopildi' }
      if ($line.StartsWith('event:')) { $evt = $line.Substring(6).Trim(); continue }
      if ($line.StartsWith('data:')) {
        if ($evt -eq 'put' -or $evt -eq 'patch') { $script:RingFails = 0; return $true }
        if ($evt -eq 'cancel' -or $evt -eq 'auth_revoked') { throw ('ruxsat yo''q (' + $evt + ')') }
      }
    }
    return $false
  } catch {
    Close-Ring
    $script:RingFails++
    $script:RingSaid = $false
    if ($script:RingFails -ge 3) {
      $script:RingOffUntil = (Get-Date).AddMinutes(10)
      $script:RingFails = 0
      Say ("Qo'ng'iroq ishlamayapti (" + $_.Exception.Message + ') - 10 daqiqa oddiy tekshiruv bilan ishlaydi.') 'Yellow'
    }
    Sleep-Smart 3
    return $true
  }
}

# ================================ ishga tushish ================================
Set-Title 'ishga tushmoqda'
Write-Host ''
Write-Host '  OQTOSH PRINTER' -ForegroundColor Cyan
Write-Host '  Oshxona va kassa cheklarini printerlarga chiqaradi.' -ForegroundColor Cyan
Write-Host '  Bu oynani yopmang (kichraytirib qo''yish mumkin). Kompyuter yoqilganda o''zi ishga tushadi.' -ForegroundColor Cyan
Write-Host ''
if (Install-Self) { Say 'O''rnatildi: kompyuter har yoqilganda o''zi ishga tushadi.' }
Say ('Versiya ' + $AgentVersion + ' | sayt: ' + $script:Site)

while ($true) {
  if (Test-Path -LiteralPath $StopFile) { Say 'Yangi nusxa ishga tushdi - bu oyna yopiladi.' 'Yellow'; break }
  try {
    if ($script:NeedScan -or ((Get-Date) - $script:LastScan).TotalMinutes -ge 30) { Do-Hello $true }
    Do-Jobs
    if ($script:Fails -gt 0) { Say 'Sayt bilan aloqa tiklandi.' 'Green' }
    $script:Fails = 0
    Set-Title ('ishlayapti - ' + $script:Printed + ' ta chek chiqdi')
  } catch {
    $script:Fails++
    $code = 0
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 401) {
      Say 'Kalit eskirgan: admin panel -> Tayyorlash joylari -> dasturni qayta yuklab oling va ishga tushiring.' 'Red'
      Set-Title 'KALIT ESKIRGAN - yangi faylni yuklab oling'
      $script:Fails = 12
    } elseif ($script:Fails -le 3 -or ($script:Fails % 20) -eq 0) {
      Say ('Sayt bilan aloqa yo''q: ' + $_.Exception.Message) 'Yellow'
      Set-Title 'internet yo''q - kutilmoqda'
    }
  }
  if ($script:Fails -gt 0) { Sleep-Smart ([Math]::Min(60, 5 * $script:Fails)); continue }
  if ($script:RetrySoon) { Sleep-Smart 20; continue }
  if ($script:RingUrl -and ((Get-Date) -gt $script:RingOffUntil)) {
    [void](Wait-Ring $script:Poll)
  } else {
    $wait = $script:Poll
    if (((Get-Date) - $script:LastJobAt).TotalMinutes -ge 15) { $wait = $script:IdlePoll }
    Sleep-Smart $wait
  }
}
Close-Ring
try { $Mutex.ReleaseMutex() } catch {}
exit 0
`;

const SITE_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const KEY_RE = /^oqa_[A-Za-z0-9_-]{20,64}$/;

export function buildAgentScript({ site, key }) {
  const s = String(site || '').replace(/\/+$/, '');
  if (!SITE_RE.test(s)) throw new Error('Sayt manzili noto‘g‘ri');
  if (!KEY_RE.test(String(key))) throw new Error('Kalit noto‘g‘ri');
  const body = BODY.replace('__VERSION__', AGENT_VERSION).replace('__SITE__', s).replace('__KEY__', key);
  // Windows uchun CRLF qator oxirlari va faqat ASCII belgilar
  return [...HEAD, ...body.split('\n')].map((l) => l.replace(/\r$/, '')).join('\r\n');
}
