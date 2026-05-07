-- ================================================================
-- SISTEM ABSENSI GURU — Idadiyah al-Miftah
-- Supabase SQL Setup — v5.0 (1 sesi per hari)
-- Diaudit langsung dari seluruh query di index.html
--
-- CARA PAKAI:
--   A. Database BARU  → jalankan Bagian 1–5 saja
--   B. Database LAMA (dari v4.x yang pakai J1/J2/J3)
--      → jalankan semua Bagian 1–7
-- ================================================================


-- ================================================================
-- BAGIAN 1 — TABEL GURU
-- Kolom yang dipakai di JS: id_pps, nama, dom, tingkatan
-- ================================================================
CREATE TABLE IF NOT EXISTS guru (
  id          BIGSERIAL PRIMARY KEY,
  id_pps      TEXT UNIQUE NOT NULL,
  nama        TEXT NOT NULL,
  dom         TEXT,
  tingkatan   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guru_id_pps ON guru (id_pps);
CREATE INDEX IF NOT EXISTS idx_guru_nama   ON guru (nama);


-- ================================================================
-- BAGIAN 2 — TABEL KALENDER_HIJRIAH
-- Diisi otomatis setiap kali admin membuka sesi (1 row per hari).
-- Kolom yang dipakai di JS:
--   INSERT/UPSERT : tanggal_sesi, hijri_day, hijri_month, hijri_year, hijri_label
--   SELECT        : tanggal_sesi, hijri_day, hijri_label, hijri_month, hijri_year
-- Format tanggal_sesi: H-YYYY-MM-DD  (contoh: H-1446-09-01)
-- ================================================================
CREATE TABLE IF NOT EXISTS kalender_hijriah (
  id           BIGSERIAL PRIMARY KEY,
  tanggal_sesi TEXT UNIQUE NOT NULL,
  hijri_day    INT,
  hijri_month  INT,
  hijri_year   INT,
  hijri_label  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kalender_bulan
  ON kalender_hijriah (hijri_month, hijri_year);

CREATE INDEX IF NOT EXISTS idx_kalender_tgl
  ON kalender_hijriah (tanggal_sesi);


-- ================================================================
-- BAGIAN 3 — TABEL SESI_ABSENSI
-- Satu row per sesi harian. Hanya 1 row boleh is_aktif = TRUE.
--
-- Kolom yang dipakai di JS:
--   INSERT/UPSERT : tanggal_key, hijri_label, hijri_day, hijri_month,
--                   hijri_year, is_aktif, dibuka_pada, dibuka_jam
--   SELECT        : tanggal_key, hijri_day, hijri_label, is_aktif,
--                   dibuka_jam, created_at,
--                   jam_offset, jam_offset_set_at
--   UPDATE        : is_aktif, jam_offset, jam_offset_set_at
--
-- Format tanggal_key: H-YYYY-MM-DD  (sama dengan kalender_hijriah.tanggal_sesi)
-- ================================================================
CREATE TABLE IF NOT EXISTS sesi_absensi (
  id                  BIGSERIAL PRIMARY KEY,
  tanggal_key         TEXT UNIQUE NOT NULL,
  hijri_label         TEXT,
  hijri_day           INT,
  hijri_month         INT,
  hijri_year          INT,
  is_aktif            BOOLEAN DEFAULT TRUE,
  dibuka_pada         TEXT,
  dibuka_jam          TIMESTAMPTZ,
  jam_offset          BIGINT,
  jam_offset_set_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sesi_aktif  ON sesi_absensi (is_aktif);
CREATE INDEX IF NOT EXISTS idx_sesi_bulan  ON sesi_absensi (hijri_month, hijri_year);
CREATE INDEX IF NOT EXISTS idx_sesi_tgl    ON sesi_absensi (tanggal_key);


-- ================================================================
-- BAGIAN 4 — TABEL ABSENSI
-- Satu row per guru per sesi harian.
--
-- Kolom yang dipakai di JS:
--   INSERT : id_pps, tanggal, status, hijri_label, keterangan
--   UPDATE : status
--   SELECT : id, id_pps, tanggal, status, hijri_label,
--            keterangan, created_at, guru(nama,dom,tingkatan)
--
-- Status: H = Hadir | A = Alpha | I = Izin | S = Sakit
-- Format tanggal: H-YYYY-MM-DD  (merujuk ke sesi_absensi.tanggal_key)
-- ================================================================
CREATE TABLE IF NOT EXISTS absensi (
  id          BIGSERIAL PRIMARY KEY,
  id_pps      TEXT NOT NULL REFERENCES guru(id_pps) ON DELETE CASCADE,
  tanggal     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('H','A','I','S')),
  hijri_label TEXT,
  keterangan  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT absensi_id_pps_tanggal_key UNIQUE (id_pps, tanggal)
);

CREATE INDEX IF NOT EXISTS idx_absensi_tanggal  ON absensi (tanggal);
CREATE INDEX IF NOT EXISTS idx_absensi_id_pps   ON absensi (id_pps);
CREATE INDEX IF NOT EXISTS idx_absensi_status   ON absensi (status);
CREATE INDEX IF NOT EXISTS idx_absensi_created  ON absensi (created_at DESC);
-- Composite index untuk query updateSideStats & loadDashboard (eq tanggal + eq status='H')
CREATE INDEX IF NOT EXISTS idx_absensi_tgl_status ON absensi (tanggal, status);
-- Composite index untuk cek duplikat check-in (eq id_pps + eq tanggal)
CREATE INDEX IF NOT EXISTS idx_absensi_idpps_tgl  ON absensi (id_pps, tanggal);


-- ================================================================
-- BAGIAN 5 — ROW LEVEL SECURITY (RLS)
-- WAJIB diaktifkan agar anon key aman dipakai di frontend.
--
-- CATATAN DESAIN PENTING:
-- • absensi.tanggal (TEXT) TIDAK memiliki FOREIGN KEY ke sesi_absensi.tanggal_key.
--   Ini disengaja agar fleksibel, tapi konsekuensinya:
--   Data absensi bisa masuk meskipun sesi tidak ada di sesi_absensi.
--   Guard sudah ada di JS (doCheckin memeriksa sesiAktif sebelum insert).
--
-- • Saat doCheckin, ada fallback upsert ke sesi_absensi dengan ignoreDuplicates:true
--   dan TANPA menyertakan dibuka_jam. Jika sesi memang belum ada di DB (edge case),
--   row baru akan diinsert tanpa dibuka_jam → kolom analisa kecepatan akan null.
--   Ini aman secara fungsional (tidak crash), tapi data analisa tidak lengkap.
--   Solusi: pastikan admin selalu buka sesi via tombol "Buka Sesi" sebelum check-in.
-- ================================================================

ALTER TABLE guru             ENABLE ROW LEVEL SECURITY;
ALTER TABLE kalender_hijriah ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesi_absensi     ENABLE ROW LEVEL SECURITY;
ALTER TABLE absensi          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_guru"      ON guru;
DROP POLICY IF EXISTS "anon_all_kalender"  ON kalender_hijriah;
DROP POLICY IF EXISTS "anon_all_sesi"      ON sesi_absensi;
DROP POLICY IF EXISTS "anon_all_absensi"   ON absensi;

CREATE POLICY "anon_all_guru"
  ON guru FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_kalender"
  ON kalender_hijriah FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_sesi"
  ON sesi_absensi FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_absensi"
  ON absensi FOR ALL TO anon USING (true) WITH CHECK (true);


-- ================================================================
-- BAGIAN 6 — MIGRASI DARI v4.x (database lama pakai J1/J2/J3)
-- Jalankan bagian ini HANYA jika tabel sudah ada sebelumnya.
-- Semua perintah bersifat idempotent (aman dijalankan ulang).
-- ================================================================

-- 6a. Hapus kolom jam_ke dari sesi_absensi
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sesi_absensi' AND column_name = 'jam_ke'
  ) THEN
    ALTER TABLE sesi_absensi DROP COLUMN jam_ke;
    RAISE NOTICE 'jam_ke dihapus dari sesi_absensi';
  ELSE
    RAISE NOTICE 'jam_ke tidak ada di sesi_absensi (skip)';
  END IF;
END $$;

-- 6b. Hapus kolom jam_ke dari absensi
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'absensi' AND column_name = 'jam_ke'
  ) THEN
    ALTER TABLE absensi DROP COLUMN jam_ke;
    RAISE NOTICE 'jam_ke dihapus dari absensi';
  ELSE
    RAISE NOTICE 'jam_ke tidak ada di absensi (skip)';
  END IF;
END $$;

-- 6c. Tambah kolom baru di sesi_absensi jika belum ada
ALTER TABLE sesi_absensi ADD COLUMN IF NOT EXISTS dibuka_jam          TIMESTAMPTZ;
ALTER TABLE sesi_absensi ADD COLUMN IF NOT EXISTS jam_offset          BIGINT;
ALTER TABLE sesi_absensi ADD COLUMN IF NOT EXISTS jam_offset_set_at   TIMESTAMPTZ;

-- 6d. Perbaiki UNIQUE constraint absensi
--     Versi lama mungkin punya constraint (id_pps, tanggal, jam_ke).
--     Kita perlu (id_pps, tanggal) saja.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    WHERE tc.table_name = 'absensi'
      AND tc.constraint_type = 'UNIQUE'
      AND tc.constraint_name <> 'absensi_id_pps_tanggal_key'
  LOOP
    EXECUTE 'ALTER TABLE absensi DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
    RAISE NOTICE 'Constraint lama dihapus: %', r.constraint_name;
  END LOOP;
END $$;

ALTER TABLE absensi DROP CONSTRAINT IF EXISTS absensi_id_pps_tanggal_key;
ALTER TABLE absensi ADD CONSTRAINT absensi_id_pps_tanggal_key UNIQUE (id_pps, tanggal);

-- 6e. [OPSIONAL] Hapus data lama format J1/J2/J3
--     PERINGATAN: MENGHAPUS DATA PERMANEN. Backup dulu!
--     Uncomment jika perlu:
--
-- DELETE FROM absensi      WHERE tanggal     ~ '-J[123]$';
-- DELETE FROM sesi_absensi WHERE tanggal_key ~ '-J[123]$';


-- ================================================================
-- BAGIAN 7 — VERIFIKASI AKHIR
-- ================================================================

-- 7a. Cek struktur kolom semua tabel
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name IN ('guru', 'kalender_hijriah', 'sesi_absensi', 'absensi')
  AND table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- 7b. Cek semua index yang terbentuk
SELECT
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename IN ('guru', 'kalender_hijriah', 'sesi_absensi', 'absensi')
  AND schemaname = 'public'
ORDER BY tablename, indexname;

-- 7c. Cek RLS aktif
SELECT
  tablename,
  rowsecurity
FROM pg_tables
WHERE tablename IN ('guru', 'kalender_hijriah', 'sesi_absensi', 'absensi')
  AND schemaname = 'public';

-- 7d. Cek semua policy yang aktif
SELECT
  tablename,
  policyname,
  cmd,
  roles
FROM pg_policies
WHERE tablename IN ('guru', 'kalender_hijriah', 'sesi_absensi', 'absensi')
ORDER BY tablename;
