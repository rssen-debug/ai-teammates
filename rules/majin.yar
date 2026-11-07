/*
  MAJIN — egna RE-regler.
  Filen läses in av re.analyze / re.yara / re.iocs (tillsammans med de inbyggda reglerna).
  Lägg till en regel via agenten:  majin({"tool":"re.rules","args":{...}})  eller klipp in här.
  Syntax är en miniature av YARA som MAJIN tolkar själv (se src/core/binary/yara.js):
    - rule-namn, meta (string-fält), strings ($a = "text" / { 4D 5A 90 00 }), condition med
      any / all / N of / and / or / filesize / entrypoint / §offset.
*/

rule MAJIN_uspicious_Packer_Stubs
{
  meta:
    author = "MAJIN"
    purpose = "känd packare/crypter-signatur"
    severity = "medium"
  strings:
    $upx1 = "UPX0"
    $upx2 = "UPX1"
    $themida = "Themida" wide ascii
    $vmprot = "VMProtect" wide ascii
    $aspack = "aPLib"
  condition:
    any of them
}

rule MAJIN_alware_Imports
{
  meta:
    author = "MAJIN"
    purpose = "importer som är ovanliga i vanliga program"
    severity = "high"
  strings:
    $v1 = "VirtualAlloc"
    $v2 = "WriteProcessMemory"
    $v3 = "CreateRemoteThread"
    $v4 = "SetWindowsHookEx"
    $k1 = "GetAsyncKeyState"
    $k2 = "keybd_event"
    $c1 = "CryptEncrypt"
    $r1 = "URLDownloadToFile"
    $s1 = "ShellExecute"
    $reg = "Software\\Microsoft\\Windows\\CurrentVersion\\Run"
  condition:
    uint16be(0) == 0x4D5A and 2 of them
}

rule MAJIN_oader_Dropper_Behaviour
{
  meta:
    author = "MAJIN"
    purpose = "typiskt loader-/dropper-beteende"
    severity = "high"
  strings:
    $tmp = "\\AppData\\Local\\Temp\\" wide ascii
    $ex = ".exe" nocase
    $sv = "schtasks"
    $persistence = "CurrentVersion\\Run"
    $dump = "lsass.dmp"
    $mimikatz = "mimikatz"
    $cobalt = "beacon"
  condition:
    2 of them
}

rule MAJIN_mbedded_PE_Overlay
{
  meta:
    author = "MAJIN"
    purpose = "PE i overlay:en — ofta inbäddad payload"
    severity = "high"
  strings:
    $mz = { 4D 5A 90 00 03 00 00 00 }
  condition:
    $mz and filesize > 200000
}

rule MAJIN_ansomware_Notes
{
  meta:
    author = "MAJIN"
    purpose = "lossennote-liknande text"
    severity = "critical"
  strings:
    $n1 = "HOW TO DECRYPT"
    $n2 = "your files have been encrypted" nocase
    $n3 = "bitcoin" nocase
    $n4 = "readme_for_decrypt" nocase
    $ext = ".locked"
  condition:
    2 of them
}

rule MAJIN_nstaller_Signature
{
  meta:
    author = "MAJIN"
    purpose = "oskyldig: vanliga installers (Inno/NSIS/MSI)"
    severity = "info"
  strings:
    $inno = "Inno Setup"
    $nsis = "Nullsoft"
    $msi = { D0 CF 11 E0 A1 B1 1A E1 }
    $electron = "electron.asar"
  condition:
    any of them
}

rule MAJIN_ndroid_Suspicious
{
  meta:
    author = "MAJIN"
    purpose = "apk med riskfyllda tillstånd/api"
    severity = "medium"
  strings:
    $a1 = "android.permission.SEND_SMS"
    $a2 = "android.permission.READ_CONTACTS"
    $a3 = "android.permission.ACCESS_FINE_LOCATION"
    $a4 = "getRuntime().exec"
    $a5 = "SmsManager"
    $a6 = "startActivityForResult"
  condition:
    2 of them
}

rule MAJIN_rypto_Miner
{
  meta:
    author = "MAJIN"
    purpose = "miner-strängar/pooler"
    severity = "high"
  strings:
    $x1 = "stratum+tcp://"
    $x2 = "xmrig" nocase
    $x3 = "--donate-level"
    $x4 = "miner" nocase
    $x5 = "monero" nocase
  condition:
    2 of them
}
