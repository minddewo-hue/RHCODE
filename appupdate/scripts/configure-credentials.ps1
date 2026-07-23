param(
  [string]$ImportPythonFile,
  [string]$CredentialFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "The encrypted credential store currently requires Windows DPAPI. Use environment variables on other platforms."
}

$updateRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([string]::IsNullOrWhiteSpace($CredentialFile)) {
  $CredentialFile = Join-Path $updateRoot ".minio-credentials.json"
} elseif (-not [IO.Path]::IsPathRooted($CredentialFile)) {
  $CredentialFile = [IO.Path]::GetFullPath((Join-Path $updateRoot $CredentialFile))
}

function Read-PythonCredential {
  param(
    [string]$Source,
    [string]$Name
  )

  $pattern = '(?m)^\s*' + [regex]::Escape($Name) + '\s*=\s*(?:"([^"]+)"|''([^'']+)'')'
  $match = [regex]::Match($Source, $pattern)
  if (-not $match.Success) {
    throw "Could not find $Name in $ImportPythonFile."
  }
  $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("<")) {
    throw "$Name does not contain a usable value."
  }
  return $value
}

function Protect-PlainText {
  param([string]$Value)

  $secure = ConvertTo-SecureString -String $Value -AsPlainText -Force
  return ConvertFrom-SecureString -SecureString $secure
}

if (-not [string]::IsNullOrWhiteSpace($ImportPythonFile)) {
  $resolvedImport = (Resolve-Path -LiteralPath $ImportPythonFile).Path
  $source = [IO.File]::ReadAllText($resolvedImport)
  $accessKey = Read-PythonCredential -Source $source -Name "MINIO_ACCESS_KEY"
  $secretKey = Read-PythonCredential -Source $source -Name "MINIO_SECRET_KEY"
} else {
  $accessKey = Read-Host "MinIO Access Key"
  if ([string]::IsNullOrWhiteSpace($accessKey)) {
    throw "MinIO Access Key is required."
  }
  $secretSecure = Read-Host "MinIO Secret Key" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secretSecure)
  try {
    $secretKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  if ([string]::IsNullOrWhiteSpace($secretKey)) {
    throw "MinIO Secret Key is required."
  }
}

$record = [ordered]@{
  version = 1
  provider = "windows-dpapi"
  accessKeyProtected = Protect-PlainText -Value $accessKey
  secretKeyProtected = Protect-PlainText -Value $secretKey
}
$directory = Split-Path -Parent $CredentialFile
[IO.Directory]::CreateDirectory($directory) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($CredentialFile, (($record | ConvertTo-Json) + [Environment]::NewLine), $utf8)

$accessKey = $null
$secretKey = $null
$source = $null
Write-Host "Saved encrypted MinIO credentials for the current Windows user: $CredentialFile"
