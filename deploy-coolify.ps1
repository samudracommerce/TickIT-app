#Requires -Version 5.1
<#
  deploy-coolify.ps1  -  Deploy app fleet Voyage (pola SSO relying-party seperti CreatorCrew,
                         Hands, Sonar, dst) ke Coolify (build pack: Dockerfile), interaktif.
                         Bisa dipakai utk app yang SUDAH ADA (update) maupun app BARU (create).

  Jalankan dari folder source app ini (tempat Dockerfile berada):
      powershell -ExecutionPolicy Bypass -File .\deploy-coolify.ps1

  Yang dilakukan script ini, berurutan:
    1. Tanya URL Coolify + API token, cek login.
    2. Pilih Project / Environment / Server di Coolify (atau buat project baru).
    3. Tanya repo Git (public / GitHub App / deploy key) + branch. Cek keberadaan repo di GitHub.
    4. Tanya domain publik (sub-path /namaapp atau subdomain sendiri). Cek status DNS di Cloudflare.
    5. Tanya prefix ENV VAR app ini (mis. NAKAMA, SONARV2) + env produksi (owner, ops, Voyage,
       kunci service). SECRET di-generate otomatis.
    6. (Opsional) push source ke Git dari folder ini.
    7. Cek apakah sudah ada aplikasi yang MIRIP ATAU SAMA (nama, domain, repo, ATAU deskripsi/
       fungsi) di Coolify - kalau ADA, tanya mau UPDATE aplikasi itu (skip pembuatan baru, hindari
       duplikat) atau tetap buat baru; kalau TIDAK ADA, buat aplikasi baru (belum deploy).
       Env dipasang ke aplikasi yang dipakai (baru atau lama).
    8. Jeda: kamu tambah Persistent Storage /data lewat UI (API Coolify belum punya endpoint utk ini).
    9. Trigger deploy + pantau statusnya.
   10. Cetak checklist sisa langkah manual (Cloudflare Tunnel, Voyage /manage/apps).

  Tidak ada nilai rahasia yang ditulis ke disk. Ringkasan tanpa rahasia -> coolify-deploy-summary.txt
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ─────────────────────────────── helpers ───────────────────────────────
function Ask {
    param([string]$Prompt, [string]$Default = '')
    if ($Default -ne '') {
        $r = Read-Host "$Prompt [$Default]"
        if ([string]::IsNullOrWhiteSpace($r)) { return $Default }
        return $r.Trim()
    }
    do { $r = Read-Host $Prompt } while ([string]::IsNullOrWhiteSpace($r))
    return $r.Trim()
}

function Ask-YesNo {
    param([string]$Prompt, [string]$Default = 'y')
    $r = Ask "$Prompt (y/n)" $Default
    return ($r.ToLower().StartsWith('y'))
}

function Read-Secret {
    param([string]$Prompt)
    do { $s = Read-Host -Prompt $Prompt -AsSecureString } while ($s.Length -eq 0)
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Select-FromList {
    param([string]$Title, $Items, [scriptblock]$Label, [string]$ExtraOption = '')
    $arr = @($Items | ForEach-Object { $_ })   # bongkar array bersarang (quirk Invoke-RestMethod PS 5.1)
    Write-Host ""
    Write-Host $Title -ForegroundColor Cyan
    for ($i = 0; $i -lt $arr.Count; $i++) {
        Write-Host ("  [{0}] {1}" -f ($i + 1), (& $Label $arr[$i]))
    }
    $max = $arr.Count
    if ($ExtraOption -ne '') { $max++; Write-Host ("  [{0}] {1}" -f $max, $ExtraOption) }
    do { $n = Read-Host "Pilih nomor" } while (-not ($n -match '^\d+$') -or [int]$n -lt 1 -or [int]$n -gt $max)
    if ($ExtraOption -ne '' -and [int]$n -eq $max) { return $null }
    return $arr[[int]$n - 1]
}

function New-HexSecret {
    param([int]$Bytes = 32)
    $buf = New-Object byte[] $Bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Invoke-Coolify {
    param([string]$Method, [string]$Path, $Body = $null)
    $uri = "$script:CoolifyUrl/api/v1$Path"
    $p = @{ Method = $Method; Uri = $uri; Headers = $script:Headers; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $p.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
        $p.ContentType = 'application/json; charset=utf-8'
    }
    try {
        $r = Invoke-RestMethod @p
        # PS 5.1: JSON array pulang sebagai SATU objek Object[] (tidak di-enumerate) -> bongkar di sini,
        # kalau tidak, daftar project/server terbaca sebagai satu item dengan semua nama tergabung.
        if ($r -is [System.Array]) { return @($r | ForEach-Object { $_ }) }
        return $r
    }
    catch {
        $detail = ''
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
        elseif ($_.Exception.Response) {
            try {
                $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
                $detail = $sr.ReadToEnd()
            } catch { }
        }
        throw "API $Method $Path gagal: $($_.Exception.Message)`n$detail"
    }
}

function Step { param([string]$T) Write-Host ""; Write-Host ("=== " + $T + " ") -ForegroundColor Yellow -NoNewline; Write-Host ("=" * [Math]::Max(0, 70 - $T.Length)) -ForegroundColor Yellow }
function Ok   { param([string]$T) Write-Host ("  OK  " + $T) -ForegroundColor Green }
function Warn { param([string]$T) Write-Host ("  !!  " + $T) -ForegroundColor Magenta }

# ─────────────────────────────── 0. lokasi ───────────────────────────────
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
if (-not (Test-Path (Join-Path $Root 'Dockerfile'))) {
    Warn "Dockerfile tidak ditemukan di $Root - jalankan script ini dari folder source app yang mau di-deploy."
    exit 1
}
Write-Host ""
Write-Host "Fleet app -> Coolify deploy" -ForegroundColor Cyan
Write-Host "Folder source : $Root"

# ─────────────────────────────── 1. Coolify ───────────────────────────────
Step "1/10  Koneksi Coolify"
$script:CoolifyUrl = (Ask "URL Coolify (mis. https://coolify.samudracommerce.com)").TrimEnd('/')
$token = Read-Secret "API token Coolify (Keys & Tokens -> API tokens)"
$script:Headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
$team = Invoke-Coolify GET '/teams/current'
Ok ("Terhubung. Team: " + $team.name)

# ─────────────────────────────── 2. Project / Env / Server ───────────────────────────────
Step "2/10  Project, Environment, Server"
$projects = @(Invoke-Coolify GET '/projects')
$project = Select-FromList "Project tujuan:" $projects { param($p) "$($p.name)  ($($p.uuid))" } "Buat project baru"
if ($null -eq $project) {
    $pname = Ask "Nama project baru" "fleet"
    $project = Invoke-Coolify POST '/projects' @{ name = $pname; description = 'Samudra fleet apps' }
    Ok "Project '$pname' dibuat ($($project.uuid))"
}
$projectUuid = $project.uuid

$projDetail = Invoke-Coolify GET "/projects/$projectUuid"
$envs = @($projDetail.environments)
if ($envs.Count -eq 0) { $environmentName = Ask "Nama environment" "production" }
else {
    $envSel = Select-FromList "Environment:" $envs { param($e) $e.name } "Ketik nama lain"
    if ($null -eq $envSel) { $environmentName = Ask "Nama environment" "production" } else { $environmentName = $envSel.name }
}

$servers = @(Invoke-Coolify GET '/servers')
$server = Select-FromList "Server tujuan:" $servers { param($s) "$($s.name)  $($s.ip)  ($($s.uuid))" }
$serverUuid = $server.uuid
$destinationUuid = Ask "Destination UUID (kosongkan kalau server hanya punya satu network Docker)" "-"
if ($destinationUuid -eq '-') { $destinationUuid = '' }

# ─────────────────────────────── 3. Git ───────────────────────────────
Step "3/10  Source Git"
$repoInput = Ask "URL repo GitHub (mis. https://github.com/samudracommerce/creatorcrew-app)"
$branch    = Ask "Branch" "main"
# normalisasi owner/repo
$ownerRepo = $repoInput -replace '^https?://github\.com/', '' -replace '^git@github\.com:', '' -replace '\.git$', '' -replace '/$', ''
if ($ownerRepo -notmatch '^[^/]+/[^/]+$') { Warn "Format repo tidak dikenali: $repoInput"; exit 1 }

$srcTypes = @(
    @{ id = 'public';  label = 'Repo PUBLIC (tanpa auth)' },
    @{ id = 'ghapp';   label = 'Repo PRIVATE via GitHub App yang sudah terpasang di Coolify (Sources)' },
    @{ id = 'depkey';  label = 'Repo PRIVATE via Deploy Key (Coolify -> Keys & Tokens -> Private Keys)' }
)
$srcType = Select-FromList "Jenis akses repo:" $srcTypes { param($t) $t.label }
$githubAppUuid = ''; $privateKeyUuid = ''
switch ($srcType.id) {
    'ghapp' {
        Write-Host "  UUID GitHub App ada di URL halaman Coolify -> Sources -> (GitHub App kamu)."
        $githubAppUuid = Ask "GitHub App UUID"
    }
    'depkey' {
        $keys = @(Invoke-Coolify GET '/security/keys')
        if ($keys.Count -eq 0) { Warn "Belum ada private key di Coolify. Buat dulu di Keys & Tokens, pasang public key-nya sebagai Deploy Key di GitHub."; exit 1 }
        $k = Select-FromList "Private key untuk repo ini:" $keys { param($k) "$($k.name)  ($($k.uuid))" }
        $privateKeyUuid = $k.uuid
    }
}

# --- cek keberadaan repo di GitHub (best-effort, tanpa token = hanya bisa pastikan repo PUBLIC) ---
try {
    $ghResp = Invoke-WebRequest -Uri "https://api.github.com/repos/$ownerRepo" -Headers @{ 'User-Agent' = 'creatorcrew-deploy-script'; Accept = 'application/vnd.github+json' } -UseBasicParsing -ErrorAction Stop
    $ghJson = $ghResp.Content | ConvertFrom-Json
    $privNote = if ($ghJson.private) { ' [PRIVATE]' } else { '' }
    Ok "Repo GitHub ditemukan: $ownerRepo — default branch: $($ghJson.default_branch)$privNote"
    if ($ghJson.default_branch -and $ghJson.default_branch -ne $branch) {
        Warn "Branch yang kamu isi ('$branch') beda dari default branch repo ('$($ghJson.default_branch)') - pastikan branch '$branch' memang ada di repo."
    }
} catch {
    $ghCode = $null
    if ($_.Exception.Response) { $ghCode = [int]$_.Exception.Response.StatusCode }
    if ($ghCode -eq 404) {
        Warn "GitHub API: repo '$ownerRepo' tidak ditemukan TANPA autentikasi. WAJAR kalau repo PRIVATE (Coolify tetap bisa akses via GitHub App/Deploy Key) - tapi kalau harusnya publik, cek lagi ejaan owner/repo-nya."
    } else {
        Warn "Tidak bisa cek keberadaan repo ke GitHub API ($($_.Exception.Message)). Dilanjutkan tanpa verifikasi."
    }
}

# ─────────────────────────────── 4. Domain ───────────────────────────────
Step "4/10  Domain publik"
Write-Host "  Sub-path (pola CreatorCrew & app fleet lain): https://voyage.samudracommerce.com/nama-app"
Write-Host "  Subdomain sendiri     : https://nama-app.samudracommerce.com  (cookie Voyage TIDAK nyebrang subdomain)"
$domain = (Ask "Domain publik app ini" "https://voyage.samudracommerce.com/nama-app").TrimEnd('/')
$u = [Uri]$domain
$ssoPrefix = ''
if ($u.AbsolutePath -and $u.AbsolutePath -ne '/') { $ssoPrefix = $u.AbsolutePath.TrimEnd('/') }
if ($ssoPrefix) { Ok "Mode sub-path terdeteksi, SSO_PREFIX=$ssoPrefix (akan dipasang sbg <PREFIX>_SSO_PREFIX di step 5; Traefik stripprefix -> X-Forwarded-Prefix otomatis)" }
else            { Warn "Mode subdomain: SSO_PREFIX kosong. Pastikan cookie Voyage bisa sampai ke host ini." }

# --- cek status DNS domain ini di Cloudflare (opsional, butuh API token) ---
$script:CfToken = ''
if (Ask-YesNo "Cek status host '$($u.Host)' ini di Cloudflare sekarang? (DNS record sudah ada atau belum)" 'y') {
    $script:CfToken = Read-Secret "Cloudflare API token (izin minimal: Zone -> DNS -> Read)"
    $cfParts = $u.Host -split '\.'
    $cfZoneGuess = ($cfParts[-2..-1]) -join '.'
    $cfZoneName = Ask "Nama zone Cloudflare" $cfZoneGuess
    try {
        $zResp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones?name=$cfZoneName" -Headers @{ Authorization = "Bearer $($script:CfToken)" }
        if (-not $zResp.result -or $zResp.result.Count -eq 0) {
            Warn "Zone '$cfZoneName' tidak ditemukan di akun Cloudflare token ini (atau token tak punya akses). Lewati cek lanjutan."
        } else {
            $cfZoneId = $zResp.result[0].id
            $dResp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$cfZoneId/dns_records?name=$($u.Host)" -Headers @{ Authorization = "Bearer $($script:CfToken)" }
            if ($dResp.result -and $dResp.result.Count -gt 0) {
                $rec = $dResp.result[0]
                Ok "DNS record utk $($u.Host) SUDAH ADA -> $($rec.type) $($rec.content) (proxied=$($rec.proxied))"
            } else {
                Warn "DNS record utk $($u.Host) BELUM ADA di zone '$cfZoneName'. Perlu dibuat (lihat langkah 10)."
            }
            if ($ssoPrefix) {
                Warn "Mode sub-path: ini baru cek record DNS host induk ($($u.Host)) - biasanya sudah ada krn dipakai Voyage. Rule PATH '$ssoPrefix' spesifik di Cloudflare Tunnel tetap harus dicek manual di dashboard (langkah 10)."
            }
        }
    } catch {
        Warn "Gagal cek Cloudflare: $($_.Exception.Message). Dilanjutkan tanpa verifikasi."
    }
} else {
    Warn "Cek Cloudflare dilewati."
}

# ─────────────────────────────── 5. Env produksi ───────────────────────────────
Step "5/10  Environment variables produksi"
Write-Host "  Setiap app fleet punya prefix ENV VAR sendiri (CREATORCREW_*, HANDS_*, SONAR_*, dst)."
$appPrefix = ''
while ($appPrefix -notmatch '^[A-Z][A-Z0-9_]*$') {
    $appPrefix = (Ask "Prefix ENV VAR app ini (huruf besar/angka/underscore, mis. NAKAMA)" "").ToUpper()
    if ($appPrefix -notmatch '^[A-Z][A-Z0-9_]*$') { Warn "Format tidak valid - harus diawali huruf, isi huruf besar/angka/underscore saja." }
}
Ok "Prefix env var: ${appPrefix}_*"

$owners     = Ask "${appPrefix}_OWNERS (email, koma-pisah)" "aldaffan.sheva@samudraretail.co.id"
$ops        = Ask "${appPrefix}_OPS (email People Ops, koma-pisah; '-' kalau belum ada)" "-"
if ($ops -eq '-') { $ops = '' }
$voyageBase = (Ask "${appPrefix}_VOYAGE_BASE_URL (publik)" "https://voyage.samudracommerce.com").TrimEnd('/')
$whoamiUrl  = Ask "${appPrefix}_WHOAMI_URL (internal, server-ke-server)" "http://coolify-proxy/api/v1/whoami"
$whoamiHost = Ask "${appPrefix}_WHOAMI_HOST (Host header utk Traefik)" ([Uri]$voyageBase).Host
Write-Host "  Kunci service Voyage = SATU kunci utk semua app armada (sama dgn Sonar/Hands/CreatorCrew di prod). JANGAN rotasi di /manage/integrasi."
$serviceKey = Read-Secret "${appPrefix}_VOYAGE_SERVICE_KEY (X-Api-Key Voyage prod)"
$appKey     = Ask "${appPrefix}_APP_KEY (app key di Voyage /manage/apps)" ($appPrefix.ToLower())
$secret     = New-HexSecret 32
Ok "${appPrefix}_SECRET di-generate (64 hex, unik utk prod)"

$envVars = @(
    @{ key = "${appPrefix}_ENV";                value = 'production' },
    @{ key = "${appPrefix}_SECRET";             value = $secret },
    @{ key = "${appPrefix}_OWNERS";             value = $owners },
    @{ key = "${appPrefix}_OPS";                value = $ops },
    @{ key = "${appPrefix}_VOYAGE_BASE_URL";    value = $voyageBase },
    @{ key = "${appPrefix}_WHOAMI_URL";         value = $whoamiUrl },
    @{ key = "${appPrefix}_WHOAMI_HOST";        value = $whoamiHost },
    @{ key = "${appPrefix}_VOYAGE_SERVICE_KEY"; value = $serviceKey },
    @{ key = "${appPrefix}_APP_KEY";            value = $appKey },
    @{ key = "${appPrefix}_SSO_PREFIX";         value = $ssoPrefix },
    @{ key = "${appPrefix}_HTTPS";              value = '1' }
)

# ─────────────────────────────── 6. Push Git (opsional) ───────────────────────────────
Step "6/10  Push source ke Git"
if (Ask-YesNo "Push isi folder ini ke $repoInput ($branch) sekarang?" 'y') {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Warn "git tidak ditemukan di PATH. Lewati; push manual nanti."; }
    else {
        Push-Location $Root
        # git menulis progress ke stderr; di PS 5.1 itu jadi error terminating kalau EAP=Stop
        $ErrorActionPreference = 'Continue'
        try {
            $di = Join-Path $Root '.dockerignore'
            if (-not (Test-Path $di)) {
@"
.git
.env
.env.example
_to_delete/
__pycache__/
*.pyc
.pytest_cache/
*.db
*.db-wal
*.db-shm
uploads/
test_*.py
*_dump.html
repro_*.html
redesign-2026-08-27/
docker-compose.yml
nginx.local.conf
deploy-coolify.ps1
coolify-deploy-summary.txt
"@ | Set-Content -Path $di -Encoding ascii
                Ok ".dockerignore dibuat (test, dump HTML, folder redesign tidak ikut ke image)"
            }
            $gi = Join-Path $Root '.gitignore'
            $giText = ''
            if (Test-Path $gi) { $giText = Get-Content $gi -Raw }
            foreach ($line in @('.env', '_to_delete/', 'coolify-deploy-summary.txt')) {
                if ($giText -notmatch [regex]::Escape($line)) { Add-Content -Path $gi -Value $line }
            }
            if (-not (Test-Path (Join-Path $Root '.git'))) {
                git init | Out-Null
                git symbolic-ref HEAD "refs/heads/$branch"
                Ok "git init ($branch)"
            }
            git add -A
            git -c user.name="deploy" -c user.email="deploy@local" commit -m "$appPrefix - deploy Coolify" 2>$null | Out-Null
            $hasOrigin = $false
            try { git remote get-url origin 2>$null | Out-Null; $hasOrigin = ($LASTEXITCODE -eq 0) } catch { }
            if ($hasOrigin) { git remote set-url origin $repoInput } else { git remote add origin $repoInput }
            Write-Host "  git push -u origin $branch  (kalau diminta login GitHub, ikuti popup-nya)"
            git push -u origin $branch
            if ($LASTEXITCODE -ne 0) { Warn "git push gagal. Perbaiki lalu push manual; script lanjut membuat resource Coolify." }
            else { Ok "Source terpush ke $repoInput ($branch)" }
        } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
    }
} else { Warn "Dilewati. Pastikan repo sudah berisi commit terbaru sebelum deploy." }

# ─────────────────────────────── 7. Cek existing / Buat aplikasi + env ───────────────────────────────
Step "7/10  Cek aplikasi yang sudah ada / buat baru"
$appName        = Ask "Nama resource di Coolify" ($appPrefix.ToLower())
$appDescription = Ask "Deskripsi singkat fungsi app ini (dipakai jg utk deteksi duplikat)" "$appPrefix - fleet app (SSO relying-party Voyage)"
$dockerfileLoc  = Ask "Lokasi Dockerfile (relatif thd root repo)" "/Dockerfile"

$allApps = @(Invoke-Coolify GET '/applications')
$domainHost = $u.Host

# --- rekomendasi port + cek konflik dgn app lain yang sudah ada di Coolify ini ---
$usedPorts = @{}
foreach ($a in $allApps) {
    if ($a.ports_exposes) {
        foreach ($p in ($a.ports_exposes -split '[,\s]+')) {
            if ($p) { $usedPorts[$p.Trim()] = $a.name }
        }
    }
}
$recPort = 5000
while ($usedPorts.ContainsKey([string]$recPort)) { $recPort++ }
Ok "Rekomendasi port (belum dipakai app lain di Coolify ini): $recPort"
$portExpose = ''
while ($true) {
    $portExpose = Ask "Port yang di-expose container (ports_exposes)" ([string]$recPort)
    if ($usedPorts.ContainsKey($portExpose)) {
        Warn "Port $portExpose sudah dipakai oleh app '$($usedPorts[$portExpose])' di Coolify ini."
        if (Ask-YesNo "Tetap pakai port $portExpose ini? (container terisolasi per-app, biasanya aman - tapi cek lagi kalau app ini pakai host port mapping langsung)" 'n') { break }
    } else { break }
}

# --- helper: pecah teks jadi kata kunci (huruf/angka, min 4 karakter) utk cek kemiripan "fungsi" ---
function Get-Keywords {
    param([string]$Text)
    if (-not $Text) { return @() }
    return @(($Text.ToLower() -split '[^a-z0-9]+') | Where-Object { $_.Length -ge 4 } | Select-Object -Unique)
}
$myKeywords = Get-Keywords $appDescription

$appMatches = @($allApps | Where-Object {
    $nameLow = if ($_.name) { $_.name.ToLower() } else { '' }
    $meLow   = $appName.ToLower()
    $nameHit = $nameLow -and ($nameLow -eq $meLow -or $nameLow.Contains($meLow) -or $meLow.Contains($nameLow))
    $domainHit = $_.fqdn -and ($_.fqdn -match [regex]::Escape($domainHost))
    $repoHit   = $_.git_repository -and ($_.git_repository -match [regex]::Escape($ownerRepo))
    $descKeywords = Get-Keywords $_.description
    $descOverlap = @($descKeywords | Where-Object { $myKeywords -contains $_ })
    $descHit = $descOverlap.Count -ge 2
    $nameHit -or $domainHit -or $repoHit -or $descHit
})

$appUuid = $null
$updateMode = $false
if ($appMatches.Count -gt 0) {
    Warn ("Ditemukan " + $appMatches.Count + " aplikasi yang mirip/sama (nama, domain, repo, ATAU deskripsi/fungsi) di Coolify - kemungkinan sudah pernah di-deploy sebelumnya:")
    $picked = Select-FromList "Aplikasi yang sudah ada:" $appMatches { param($a) "$($a.name)  fqdn=$($a.fqdn)  desc=$($a.description)  uuid=$($a.uuid)" } "Bukan ini - buat aplikasi BARU"
    if ($null -ne $picked) {
        $appUuid = $picked.uuid
        $updateMode = $true
        Ok "Mode UPDATE dipilih: pakai aplikasi yang sudah ada ($appUuid). Tidak membuat resource baru (hindari duplikat)."
        $detail = Invoke-Coolify GET "/applications/$appUuid"
        if ($detail.project_uuid)     { $projectUuid     = $detail.project_uuid }
        if ($detail.environment_name) { $environmentName = $detail.environment_name }
        if (Ask-YesNo "Sinkronkan juga domain/branch aplikasi lama ini dgn nilai yang baru saja diinput?" 'n') {
            try { Invoke-Coolify PATCH "/applications/$appUuid" @{ domains = $domain; git_branch = $branch } | Out-Null; Ok "Domain/branch aplikasi lama diupdate." }
            catch { Warn "Gagal update domain/branch: $($_.Exception.Message)" }
        }
    } else {
        Warn "Lanjut membuat aplikasi BARU meski ada yang mirip - pastikan ini memang disengaja (potensi duplikat)."
    }
}

if (-not $updateMode) {
    $body = [ordered]@{
        project_uuid        = $projectUuid
        server_uuid         = $serverUuid
        environment_name    = $environmentName
        git_branch          = $branch
        build_pack          = 'dockerfile'
        dockerfile_location = $dockerfileLoc
        ports_exposes       = $portExpose
        name                = $appName
        description         = $appDescription
        domains             = $domain
        instant_deploy      = $false
    }
    if ($destinationUuid) { $body.destination_uuid = $destinationUuid }
    switch ($srcType.id) {
        'public' { $path = '/applications/public';             $body.git_repository = "https://github.com/$ownerRepo" }
        'ghapp'  { $path = '/applications/private-github-app'; $body.git_repository = $ownerRepo; $body.github_app_uuid = $githubAppUuid }
        'depkey' { $path = '/applications/private-deploy-key'; $body.git_repository = "git@github.com:$ownerRepo.git"; $body.private_key_uuid = $privateKeyUuid }
    }
    $app = Invoke-Coolify POST $path $body
    $appUuid = $app.uuid
    Ok "Aplikasi baru dibuat: $appUuid"
}

$envPayload = @{ data = @($envVars | ForEach-Object { @{ key = $_.key; value = $_.value; is_preview = $false; is_build_time = $false; is_literal = $true } }) }
Invoke-Coolify PATCH "/applications/$appUuid/envs/bulk" $envPayload | Out-Null
Ok ("Env terpasang: " + (($envVars | ForEach-Object { $_.key }) -join ', '))

# ─────────────────────────────── 8. Volume (manual) ───────────────────────────────
Step "8/10  Persistent Storage /data  (langkah MANUAL di UI)"
$appUrl = "$script:CoolifyUrl/project/$projectUuid/$environmentName/application/$appUuid"
Write-Host "  Buka: $appUrl"
Write-Host "  -> tab 'Persistent Storage' -> Add -> Volume Mount"
Write-Host "       Name             : $($appName)-data"
Write-Host "       Destination Path : /data  (sesuaikan dgn path storage app ini - cek Dockerfile/kode-nya)"
Write-Host "  Tanpa ini, data yang disimpan app ini (db/uploads) bisa hilang tiap redeploy."
Write-Host "  Sekalian cek tab 'Environment Variables': pastikan semua ${appPrefix}_* muncul."
Read-Host "Tekan Enter setelah volume ditambahkan"

# ─────────────────────────────── 9. Deploy ───────────────────────────────
Step "9/10  Deploy"
$dep = Invoke-Coolify GET "/deploy?uuid=$appUuid&force=false"
$depUuid = $dep.deployments[0].deployment_uuid
Ok "Deploy dipicu: $depUuid"
$deadline = (Get-Date).AddMinutes(15)
$status = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    try { $d = Invoke-Coolify GET "/deployments/$depUuid"; $status = $d.status } catch { $status = 'unknown' }
    Write-Host ("  ... " + (Get-Date -Format 'HH:mm:ss') + "  status: " + $status)
    if ($status -in @('finished', 'failed', 'cancelled-by-user')) { break }
}
if ($status -eq 'finished') { Ok "Deploy selesai." }
else { Warn "Deploy status akhir: $status. Lihat log di $appUrl (tab Deployments)." }

# ─────────────────────────────── 10. Cloudflare ───────────────────────────────
Step "10/10  Cloudflare"
if ($ssoPrefix) {
    Write-Host "  Mode sub-path: host $($u.Host) sudah hidup di Cloudflare (dipakai Voyage)."
    Write-Host "  Yang perlu ditambah adalah rule PATH di Cloudflare Tunnel (Zero Trust -> Networks -> Tunnels -> Public Hostname):"
    Write-Host "     Subdomain/Domain : $($u.Host)     Path : $($ssoPrefix.TrimStart('/'))"
    Write-Host "     Service          : http://localhost:80   (Traefik Coolify)"
    Write-Host "  Rule ini HARUS berada DI ATAS catch-all $($u.Host). API Tunnel mengganti seluruh daftar ingress"
    Write-Host "  sekaligus, jadi langkah ini sengaja manual di dashboard supaya rule Voyage tidak tertimpa."
} else {
    if (Ask-YesNo "Buat/update DNS record $($u.Host) lewat API Cloudflare sekarang?" 'n') {
        $cfToken  = if ($script:CfToken) { $script:CfToken } else { Read-Secret "Cloudflare API token (izin minimal: Zone -> DNS -> Edit)" }
        if ($script:CfToken) { Write-Host "  (pakai token yang sama dgn cek status di langkah 4 - kalau token itu cuma izin Read, tulis di bawah akan gagal, minta token baru dgn izin Edit)" }
        $parts    = $u.Host -split '\.'
        $zoneName = Ask "Nama zone" (($parts[-2..-1]) -join '.')
        $recType  = (Ask "Tipe record: A (IP publik server) / CNAME (mis. <tunnel-id>.cfargotunnel.com)" "A").ToUpper()
        $target   = Ask "Isi record (IP server Coolify, atau target CNAME)"
        $cfBase   = 'https://api.cloudflare.com/client/v4'
        $cfH      = @{ Authorization = "Bearer $cfToken" }
        try {
            $z = Invoke-RestMethod -Uri "$cfBase/zones?name=$zoneName" -Headers $cfH
            if (-not $z.result -or $z.result.Count -eq 0) { Warn "Zone $zoneName tidak ditemukan atau token tak punya akses. Lewati."; }
            else {
                $zoneId = $z.result[0].id
                $ex = Invoke-RestMethod -Uri "$cfBase/zones/$zoneId/dns_records?name=$($u.Host)" -Headers $cfH
                $rec = @{ type = $recType; name = $u.Host; content = $target; proxied = $true; ttl = 1 } | ConvertTo-Json -Compress
                if ($ex.result -and $ex.result.Count -gt 0) {
                    Invoke-RestMethod -Method Put -Uri "$cfBase/zones/$zoneId/dns_records/$($ex.result[0].id)" -Headers $cfH -ContentType 'application/json' -Body $rec | Out-Null
                    Ok "DNS record $($u.Host) diupdate -> $recType $target (proxied)"
                } else {
                    Invoke-RestMethod -Method Post -Uri "$cfBase/zones/$zoneId/dns_records" -Headers $cfH -ContentType 'application/json' -Body $rec | Out-Null
                    Ok "DNS record $($u.Host) dibuat -> $recType $target (proxied)"
                }
                Write-Host "  Kalau lewat Cloudflare Tunnel: tambah juga Public Hostname $($u.Host) -> http://localhost:80 di dashboard Tunnel."
            }
        } catch { Warn "Gagal buat/update DNS record: $($_.Exception.Message) (cek izin token - butuh Zone -> DNS -> Edit)." }
    } else { Write-Host "  Dilewati. Pastikan $($u.Host) mengarah ke Traefik Coolify (DNS A/CNAME atau Public Hostname di Tunnel)." }
}

# ─────────────────────────────── ringkasan + checklist ───────────────────────────────
$healthUrl = "$domain/healthz"
$modeLabel = if ($updateMode) { 'UPDATE (aplikasi sudah ada sebelumnya)' } else { 'BARU (resource baru dibuat)' }
$summary = @"
$appPrefix -> Coolify  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))
Mode         : $modeLabel
Coolify      : $script:CoolifyUrl
Project/Env  : $($project.name) / $environmentName
Server       : $($server.name) ($serverUuid)
App UUID     : $appUuid
App URL      : $appUrl
Repo         : $repoInput ($branch)
Domain       : $domain
SSO prefix   : '$ssoPrefix'
Voyage base  : $voyageBase
Whoami       : $whoamiUrl  (Host: $whoamiHost)
Owners/Ops   : $owners / $ops
Healthz      : $healthUrl
(rahasia: ${appPrefix}_SECRET & ${appPrefix}_VOYAGE_SERVICE_KEY hanya ada di Coolify)
"@
$summary | Set-Content -Path (Join-Path $Root 'coolify-deploy-summary.txt') -Encoding utf8
Write-Host ""
Write-Host $summary
Write-Host ""
Write-Host "SISA LANGKAH MANUAL" -ForegroundColor Cyan
Write-Host "  1. Cloudflare: pastikan langkah 10 di atas sudah beres (rule Tunnel / DNS mengarah ke Traefik Coolify)."
Write-Host "  2. Voyage prod -> /manage/apps: toggle '$appKey' AKTIF, lalu grant akses (pribadi / aturan divisi)."
Write-Host "     Kalau mode sub-path, base_path di registry harus '$ssoPrefix'; kalau subdomain, isi URL absolut $domain."
Write-Host "  3. Verifikasi:  curl.exe $healthUrl   -> 200 {""ok"": true}"
Write-Host "  4. Login sbg user ber-grant, buka satu halaman, pastikan link/aset menunjuk ke $ssoPrefix/..."
Write-Host "  5. Cabut API token Coolify yang dipakai script ini kalau sudah tidak perlu."
Write-Host ""
if (Ask-YesNo "Coba cek $healthUrl sekarang?" 'y') {
    try {
        $r = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 15
        Ok ("healthz -> " + $r.StatusCode + " " + $r.Content)
    } catch { Warn ("healthz belum bisa diakses: " + $_.Exception.Message + "  (wajar kalau rule Cloudflare/Tunnel belum dipasang)") }
}
