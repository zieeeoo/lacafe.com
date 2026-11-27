# Memasang LaCafe Member di hosting cPanel

Panduan ini untuk hosting biasa yang memakai cPanel (Niagahoster/Hostinger, DomaiNesia, IDCloudHost, Rumahweb, dan sejenisnya). Tidak perlu terminal, tidak perlu Node.js.

## Yang dibutuhkan

- Hosting cPanel dengan **PHP 8.1 atau lebih baru** (cek di cPanel > *Select PHP Version* atau *MultiPHP Manager*).
- Domain yang sudah mengarah ke hosting, misalnya `lacafe.id` atau subdomain `member.lacafe.id`.
- SSL/HTTPS aktif (gratis lewat cPanel > *SSL/TLS Status* > *Run AutoSSL*).

## Langkah pemasangan (sekitar 10 menit)

1. **Unggah file**
   Buka cPanel > *File Manager* > masuk ke folder `public_html` (atau folder subdomain Anda). Klik *Upload*, pilih `lacafe-cpanel.zip`. Setelah selesai, klik kanan file zip > *Extract*.
   Pastikan `index.html`, `api.php`, `install.php`, dan folder `app`, `assets`, `uploads` berada **langsung** di dalam `public_html`, bukan di dalam subfolder lain.
   Ingin di alamat `domainanda.com/member/`? Buat folder `member` di `public_html` lalu ekstrak di sana.

2. **Jalankan pemasang**
   Buka `https://domainanda.com/install.php` di browser.
   - Pilih **Otomatis (SQLite)**. Database dibuat sendiri dan disimpan di luar folder publik.
   - Pilih MySQL hanya bila hosting tidak mendukung SQLite. Buat dulu database & user di cPanel > *MySQL Databases*.
   - Buat kata sandi admin (minimal 8 karakter, ada huruf dan angka), lalu klik **Pasang sekarang**.
   Data dari Excel (customer, transaksi, menu, aturan poin) otomatis masuk.

3. **Hapus `install.php`** lewat File Manager. Jalankan langkah 2 segera setelah upload, karena siapa pun yang membuka `install.php` lebih dulu bisa membuat akun admin.

4. **Paksa HTTPS**
   Setelah SSL aktif, buka file `.htaccess` di `public_html` (aktifkan *Show Hidden Files* di File Manager), lalu hapus tanda `#` di depan tiga baris di bawah tulisan "Paksa HTTPS".

5. **Mulai pakai**
   - Customer: `https://domainanda.com/`
   - Admin & kasir: `https://domainanda.com/#/admin`, username `admin`.
   - Buat akun kasir di menu **Akun staf**.
   - Customer lama dari Excel mengaktifkan akun dengan kode dari kasir: menu **Customer** > klik nama > **Buat kode aktivasi**.

## Backup (lakukan rutin, misalnya seminggu sekali)

- **SQLite:** unduh file `lacafe.db` dari folder `lacafe-data` (satu tingkat di atas `public_html`) dan folder `public_html/uploads`.
- **MySQL:** cPanel > *phpMyAdmin* > pilih database > *Export*.
- Fitur *Backup* bawaan cPanel juga bisa dipakai.

## Jika ada masalah

| Gejala | Solusi |
|---|---|
| Muncul "Aplikasi belum dipasang" | Buka `install.php` dan selesaikan pemasangan. |
| Pengecekan hosting bertanda ✗ di PHP | Ubah versi PHP ke 8.1+ di cPanel > *Select PHP Version*. |
| "Folder app/ bisa ditulis" ✗ | File Manager > klik kanan folder `app` dan `uploads` > *Change Permissions* > 755. |
| Lupa kata sandi admin | cPanel > *Terminal*, masuk ke folder website, jalankan `php app/tools/reset-admin.php KataSandiBaru123`. |
| Error 500 | Lihat file `error_log` di folder website, atau pastikan versi PHP 8.1+. |
| Ingin memasang ulang dari nol | Hapus `app/config.php` dan folder `lacafe-data`, unggah lagi `install.php`, lalu buka di browser. **Semua data hilang.** |

## Keamanan yang sudah aktif

Kata sandi di-hash, sesi login HttpOnly + SameSite, perlindungan CSRF, harga & poin dihitung di server, riwayat poin tidak bisa diubah, penukaran poin tidak bisa dobel, login dikunci 15 menit setelah 5 kali salah, folder `app` dan data ditolak dari browser, upload hanya gambar asli, dan semua tindakan penting tercatat di **Log aktivitas**.
