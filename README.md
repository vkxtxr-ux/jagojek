# Jagojek Web (mode demo)

Aplikasi Jagojek sebagai website: siapa saja bisa **membuat akun, masuk, top up, transfer antar-akun, memesan, dan melihat riwayat**. Data tersimpan di server (SQLite), jadi tetap ada di HP mana pun.

> **Penting – ini mode DEMO.** Saldo adalah **uang virtual** (akun baru dapat Rp100.000). Tidak ada uang sungguhan yang bergerak. Lihat bagian "Batasan" sebelum dipakai untuk hal lain.

Tanpa dependensi npm. Cukup **Node.js 22.13+**.

## Jalankan di komputer sendiri
```bash
cd jagojek-web
node server.js          # buka http://localhost:3000
npm test                # 11 tes API
```

## Pasang online (agar bisa dibagikan lewat QR)
Server ini butuh **disk permanen** untuk database. Hosting gratis yang menghapus file saat restart akan **menghapus semua akun**.

### Opsi A – Render.com
1. Unggah folder ini ke repositori GitHub.
2. Render → New → Blueprint → pilih repo (memakai `render.yaml`, paket Starter + disk 1 GB).
3. Setelah aktif, isi variabel `PUBLIC_URL` dengan alamat Render-mu (mis. `https://jagojek.onrender.com`).

### Opsi B – Railway
1. New Project → Deploy from GitHub repo (otomatis memakai `Dockerfile`).
2. Tambah **Volume**, mount di `/data`.
3. Variabel: `DATA_DIR=/data`, `TRUST_PROXY=1`, `PUBLIC_URL=https://…`.

### Opsi C – VPS (Ubuntu) + Docker
```bash
docker build -t jagojek .
docker run -d --restart=always -p 3000:3000 -v jagojek-data:/data \
  -e PUBLIC_URL=https://domainmu.com jagojek
```
Pasang Caddy/Nginx di depannya untuk HTTPS (mis. Caddy: `domainmu.com { reverse_proxy localhost:3000 }`).

**HTTPS wajib** untuk instalasi ke layar utama iPhone dan cookie aman.

## Buat QR code
```bash
node scripts/qr.js https://alamat-situsmu.com
```
Menghasilkan `qr-jagojek.png` (kirim lewat chat) dan `qr-jagojek.svg` (cetak). Pengguna juga bisa membagikan QR dari dalam aplikasi: **Akun → Bagikan aplikasi (QR)**.

## Pengaturan (variabel lingkungan)
Lihat `.env.example`: `PORT`, `DATA_DIR`, `PUBLIC_URL`, `SIGNUP_BONUS`, `TRUST_PROXY`, `REG_LIMIT`, `LOGIN_LIMIT`.

Cadangan data: salin file `jagojek.db` di `DATA_DIR` secara berkala.

## Keamanan yang sudah ada
Sandi di-hash scrypt; sesi cookie HttpOnly (hash token di DB); proteksi CSRF; batas percobaan login + kunci akun sementara; batas pendaftaran per IP; saldo hanya diubah di server dengan transaksi atomik, anti-dobel (idempotensi), refund/poin hanya sekali; header keamanan (CSP).

## Batasan (jujur)
- **Uang virtual saja.** Untuk uang sungguhan perlu payment gateway berizin (Midtrans/Xendit) dan izin/regulasi (mis. e-money/PJP dari OJK/BI). Itu di luar cakupan proyek ini.
- **Harga pesanan dihitung di browser** lalu dibayar ke server. Cocok untuk demo; untuk produksi harga harus dihitung & divalidasi server.
- **PIN** hanya langkah konfirmasi (6 angka apa saja), belum diverifikasi.
- **Lupa sandi** dan **masuk dengan Google/Apple** belum tersedia.
- **Driver/merchant/pesanan tidak nyata**: status pesanan adalah simulasi.
- Belum diuji di iPhone fisik; diuji di Chromium dengan 8 ukuran layar iPhone.

## Menuju uang sungguhan (garis besar)
1. Hitung harga di server (daftar menu/tarif di DB), tolak harga dari klien.
2. Ganti top up simulasi dengan pembayaran gateway + webhook yang memverifikasi tanda tangan.
3. Verifikasi PIN (hash) & verifikasi identitas (KYC) sesuai regulasi.
4. Pindah ke database terkelola (PostgreSQL), log audit, pemantauan.
