# LaCafe Member

Aplikasi member & loyalty seperti Kopi Kenangan / Fore, khusus LaCafe:

- **Aplikasi customer** (tampilan HP, bisa di-"Add to Home Screen"): kartu member dengan level & poin, kode member 6 digit yang berganti tiap 60 detik, menu + keranjang + pesan ambil di kasir, tukar poin jadi voucher, riwayat belanja & poin.
- **Panel admin & kasir**: ringkasan omzet, kasir (POS), pesanan online, data customer (kolom sama dengan sheet DASHBOARD Excel), transaksi, menu & kategori, rewards, **pengaturan tampilan tanpa coding** (tema warna, susunan beranda, banner, tampilan menu), aturan poin & level, akun staf, log aktivitas, ekspor CSV untuk Excel.

Data awal diambil dari `DATA_CUSTOMER_1_1.xlsx` (4 customer, 4 transaksi, 34 menu). Rumusnya sama persis dengan Excel:

| Excel | Aplikasi |
|---|---|
| `POIN = INT(TOTAL BELANJA / 10000)` | sama, dihitung per transaksi secara kumulatif (sisa rupiah tidak hangus) |
| `LEVEL`: Silver ≥ Rp500.000, Gold ≥ Rp1.500.000 | sama, bisa diubah / ditambah level di Admin > Aturan |
| `STATUS`: AKTIF jika kunjungan terakhir ≤ 30 hari | sama |
| `TOTAL KUNJUNGAN` = jumlah hari berbeda belanja | sama |

---

## 1. Menjalankan di komputer sendiri

Butuh **Node.js 22.5 atau lebih baru** (cek: `node --version`). Tidak perlu `npm install`, aplikasi ini tanpa library tambahan.

```bash
cd lacafe-app
ADMIN_PASSWORD='GantiDenganSandiKuat1' node server.js
```

Buka:

- Customer: <http://localhost:3000/>
- Admin / kasir: <http://localhost:3000/#/admin> (username `admin`, password sesuai `ADMIN_PASSWORD`)

Jika `ADMIN_PASSWORD` tidak diisi, password acak ditampilkan **sekali** di terminal saat pertama jalan dan Anda wajib menggantinya saat login pertama.

Di Windows (PowerShell): `$env:ADMIN_PASSWORD="GantiDenganSandiKuat1"; node server.js`

## 2. Alur pertama kali

1. Masuk admin, buka **Akun staf** lalu buat akun untuk kasir (kasir wajib ganti sandi saat login pertama).
2. Customer lama dari Excel belum punya kata sandi. Di **Customer**, klik nama customer, lalu **Buat kode aktivasi**. Kirim kodenya (ada tombol WhatsApp). Customer membuka aplikasi, pilih **Aktifkan akun**, isi ID member / nomor WA + kode, lalu buat kata sandi. Poin lamanya tetap.
3. Customer baru bisa langsung **Daftar** di aplikasi dan otomatis mendapat ID member berikutnya (LC005, LC006, ...).
4. Di kasir: pilih member (cari nama/nomor, atau ketik 6 digit kode member dari HP customer), ketuk menu, simpan. Poin masuk otomatis.

## 3. Mengubah tampilan & menambah menu (tanpa coding)

| Ingin mengubah | Buka |
|---|---|
| Nama toko, logo, tagline, warna, sudut, huruf | Admin > Tampilan aplikasi |
| Urutan & isi beranda (kartu member, banner, pilihan barista, kategori, rewards) | Admin > Tampilan aplikasi > Susunan beranda (seret atau panah) |
| Banner promo (judul, warna, foto) | Admin > Tampilan aplikasi > Banner promo |
| Tampilan menu: daftar / grid 2 kolom / foto besar | Admin > Tampilan aplikasi |
| Tambah/ubah menu, harga, foto, stok habis | Admin > Menu |
| Tambah/urutkan kategori | Admin > Menu > Kelola kategori |
| Hadiah tukar poin | Admin > Rewards |
| Rupiah per poin, batas level, level baru, hari tidak aktif | Admin > Aturan & pengaturan |
| Metode bayar, sumber customer | Admin > Aturan & pengaturan > Pilihan data |

Semua perubahan langsung berlaku untuk customer setelah disimpan.

## 4. Mengimpor ulang dari Excel

Hanya untuk **instalasi baru** (database kosong):

```bash
pip install openpyxl
python3 tools/import_excel.py "DATA_CUSTOMER.xlsx" data/seed.json
rm -f data/lacafe.db*        # HATI-HATI: menghapus semua data aplikasi
node server.js               # database dibuat ulang dari seed.json
```

Untuk laporan ke Excel setelah aplikasi berjalan, pakai tombol **Ekspor CSV** di halaman Customer dan Transaksi.

## 5a. Hosting cPanel (PHP), paling mudah untuk hosting biasa

Ada versi PHP dengan tampilan & fitur yang sama. Jalankan `node tools/build_cpanel.mjs`, lalu unggah isi `dist-cpanel/lacafe/` ke `public_html` dan buka `install.php`. Panduan lengkap: `php/PANDUAN-CPANEL.md`. Kode PHP ada di folder `php/`, dan uji yang sama bisa dijalankan dengan `TARGET=php node --test tests/api.test.js`.

## 5. Online-kan (deploy)

Aplikasi menyimpan data di folder `data/` (file `lacafe.db`, `secret.key`, `uploads/`). Hosting apa pun harus punya **penyimpanan permanen** untuk folder ini.

**Pilihan A: VPS (mis. Ubuntu, Rp50–100rb/bulan)**

```bash
# di server
sudo apt install -y caddy
git clone <repo-anda> /opt/lacafe   # atau upload zip
cd /opt/lacafe
sudo mkdir -p data && sudo chown -R www-data:www-data data
sudo cp deploy/lacafe.service /etc/systemd/system/
sudo nano /etc/systemd/system/lacafe.service   # isi ADMIN_PASSWORD
sudo systemctl enable --now lacafe
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # ganti domain
sudo systemctl reload caddy                     # HTTPS otomatis
```

**Pilihan B: Railway (paling mudah, tanpa mengurus server)**

1. Upload folder `lacafe-app` ke repository GitHub (boleh private).
2. Di railway.com: New Project, pilih Deploy from GitHub repo, lalu pilih repo tadi. Railway otomatis memakai `Dockerfile`.
3. Klik service-nya, pilih Add Volume, dan isi mount path `/app/data`. Tanpa volume, data hilang setiap restart.
4. Tab Variables: isi `ADMIN_PASSWORD`, `NODE_ENV=production`, `TRUST_PROXY=1`, dan `RAILWAY_RUN_UID=0` (volume Railway dimiliki root).
5. Tab Settings > Networking: Generate Domain, maka alamat `https://....up.railway.app` langsung aktif dengan HTTPS. Domain sendiri bisa ditambahkan di tempat yang sama.

**Pilihan C: Docker lain (Render berbayar, Fly.io, server sendiri)**

Pakai `Dockerfile` yang sudah ada. Pasang volume permanen ke `/app/data` dan isi variabel:

| Variabel | Isi |
|---|---|
| `ADMIN_PASSWORD` | sandi admin awal |
| `NODE_ENV` | `production` (cookie hanya lewat HTTPS) |
| `TRUST_PROXY` | `1` jika di belakang proxy/hosting (agar IP & HTTPS terbaca benar) |
| `DATA_DIR` | lokasi data, default `./data` |
| `PORT` | default `3000` |
| `APP_TZ` | default `Asia/Jakarta` |

**Wajib HTTPS** saat online. Setelah online, customer bisa membuka alamat situs di HP lalu pilih "Tambahkan ke layar utama" sehingga tampil seperti aplikasi.

**Backup** rutin (misalnya harian):

```bash
sqlite3 data/lacafe.db ".backup 'backup/lacafe-$(date +%F).db'"
cp -r data/uploads data/secret.key backup/
```

## 6. Keamanan yang sudah diterapkan

- Kata sandi di-hash **scrypt** dengan salt per akun; perbandingan timing-safe.
- Sesi memakai cookie **HttpOnly + SameSite=Strict** (+ `Secure` di production). Token sesi hanya disimpan sebagai hash di database.
- Proteksi **CSRF** (token per sesi) dan penolakan request dari origin lain.
- **Hak akses**: customer / kasir / admin diperiksa di server untuk setiap endpoint. Kasir tidak bisa mengoreksi poin, membatalkan transaksi, mengubah harga, atau mengubah aturan.
- **Harga & poin dihitung di server** dari data menu; harga yang dikirim dari HP diabaikan.
- **Buku besar poin append-only**: saldo = jumlah semua mutasi; trigger database menolak UPDATE/DELETE. Pembatalan transaksi membuat mutasi pembalik, bukan menghapus.
- Penukaran poin & pemakaian voucher dalam **transaksi database atomik** (tidak bisa double-spend walau diklik bersamaan).
- Login dikunci 15 menit setelah 5 kali salah + pembatasan percobaan per IP.
- Kode member di HP berganti tiap 60 detik (HMAC), jadi ID member saja tidak cukup untuk "meminjam" poin orang lain.
- Upload hanya PNG/JPG/WEBP asli (dicek dari isi file), nama file acak.
- Header keamanan: CSP ketat, X-Frame-Options, nosniff, Referrer-Policy, HSTS (di HTTPS).
- Semua teks dari pengguna di-escape saat ditampilkan (anti-XSS); ekspor CSV aman dari formula injection.
- **Log aktivitas** untuk login, transaksi, koreksi poin, perubahan aturan & tampilan.

Uji otomatis (18 skenario: hitungan Excel, CSRF, hak akses, manipulasi harga, double-spend, lockout, dll):

```bash
npm test
```

## 7. Batasan versi ini

- Pembayaran tetap di kasir (belum ada payment gateway seperti Midtrans/Xendit).
- Belum ada OTP WhatsApp otomatis; aktivasi akun lama memakai kode dari kasir.
- Satu toko, satu server (SQLite). Cukup untuk puluhan ribu member; untuk banyak cabang sebaiknya pindah ke PostgreSQL.

## 8. Struktur kode (untuk developer)

```
server.js              server HTTP, file statis, keamanan request
src/db.js              skema database, pengaturan default (tampilan, opsi)
src/security.js        hash sandi, token, rate limit, kode member, header
src/services.js        logika bisnis: statistik, poin, transaksi, pesanan, rewards
src/routes.js          semua endpoint API + validasi input
src/seed.js            isi database awal dari data/seed.json
public/assets/js/
  loyalty.js           rumus poin/level/status (dipakai server & browser)
  core.js              template anti-XSS, ikon, tema, dialog
  customer.js          aplikasi customer (homeView & menuView juga dipakai pratinjau)
  admin.js             panel admin & kasir
public/assets/css/app.css   desain (token warna, komponen)
tools/import_excel.py  konversi Excel ke seed.json
tools/build_demo.mjs   membuat versi pratinjau statis
tools/build_single.mjs membuat dist-single/index.html (satu file, tanpa server, data di browser)
tools/build_cpanel.mjs membuat paket hosting cPanel (PHP) di dist-cpanel/lacafe/
php/                   backend versi PHP (SQLite atau MySQL) untuk hosting cPanel
tests/api.test.js      uji otomatis
```

Menambah bagian beranda baru: tambahkan fungsi di objek `SECTION` (`customer.js`), label di `SECTION_LABEL` (`admin.js`), dan kuncinya di `DEFAULT_APPEARANCE.homeSections` (`src/db.js`).
