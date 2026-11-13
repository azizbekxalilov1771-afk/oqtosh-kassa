'use strict';
// Windows printeriga (USB yoki Windows'ga o'rnatilgan) ESC/POS baytlarini o'zgartirmasdan (RAW) yuborish.
// winspool.drv → OpenPrinter / StartDocPrinter(RAW) / WritePrinter. PowerShell yordamchi skripti userData'ga yoziladi.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const PS = String.raw`param([string]$Printer, [string]$DataPath, [string]$Title = 'Oqtosh')
$ErrorActionPreference = 'Stop'
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
$bytes = [IO.File]::ReadAllBytes($DataPath)
$err = [OqRawPrint]::Send($Printer, $bytes, $Title)
if ($err) { [Console]::Error.WriteLine($err); exit 2 }
exit 0
`;

function makeRawPrint(dir) {
  const script = path.join(dir, 'raw-print.ps1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(script, PS.replace(/\n/g, '\r\n'), 'utf8');
  return (printer, data, title = 'Oqtosh') => new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `oqtosh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(tmp, data);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', printer, '-DataPath', tmp, '-Title', String(title).replace(/[^\x20-\x7e]/g, '').slice(0, 60) || 'Oqtosh'],
      { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
        fs.rm(tmp, { force: true }, () => {});
        if (err) reject(new Error(String(stderr || err.message).trim().split(/\r?\n/).pop() || 'printerga yozilmadi'));
        else resolve();
      });
  });
}

module.exports = { makeRawPrint };
