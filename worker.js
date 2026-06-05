/**
 * worker.js — Cloudflare Worker: Proxy ke Neon Database
 * ======================================================
 * Menerima payload JSON dari frontend (index.html) dan menjalankan
 * query PostgreSQL ke Neon via @neondatabase/serverless.
 *
 * SETUP:
 *  1. Set secret:  wrangler secret put NEON_DATABASE_URL
 *     Isi dengan connection string Neon:
 *     postgresql://user:password@ep-xxx.region.aws.neon.tech/dbname?sslmode=require
 *  2. wrangler.jsonc sudah dikonfigurasi (nodejs_compat wajib aktif).
 *  3. Install dependency:  npm install @neondatabase/serverless
 *
 * ENDPOINT: POST /api/db
 * Payload: lihat komentar di masing-masing handler di bawah.
 */

import { neon } from '@neondatabase/serverless';

export default {
  async fetch(request, env) {
    // CORS — izinkan request dari origin mana pun (sesuaikan jika perlu)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Hanya layani POST /api/db
    if (request.method !== 'POST' || url.pathname !== '/api/db') {
      return new Response('Not Found', { status: 404, headers: corsHeaders });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    if (!env.NEON_DATABASE_URL) {
      return json({ error: 'NEON_DATABASE_URL secret belum diset' }, 500, corsHeaders);
    }

    const sql = neon(env.NEON_DATABASE_URL);

    try {
      const data = await handleQuery(sql, payload);
      return json({ data }, 200, corsHeaders);
    } catch (e) {
      console.error('DB error:', e);
      return json({ error: e.message }, 500, corsHeaders);
    }
  },
};

// ─── Helper response ───────────────────────────────────────────────────────
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ─── Query dispatcher ──────────────────────────────────────────────────────
async function handleQuery(sql, p) {
  const { table, op, data, filters, order, limit, single, maybeSingle,
          ignoreDuplicates, onConflict, selectCols, inVals } = p;

  // Validasi nama tabel (allowlist untuk keamanan)
  const allowedTables = ['guru', 'absensi', 'sesi_absensi', 'kalender_hijriah'];
  if (!allowedTables.includes(table)) {
    throw new Error(`Tabel tidak diizinkan: ${table}`);
  }

  switch (op) {
    case 'select':   return doSelect(sql, { table, selectCols, filters, inVals, order, limit, single, maybeSingle });
    case 'insert':   return doInsert(sql, { table, data, selectCols });
    case 'update':   return doUpdate(sql, { table, data, filters });
    case 'delete':   return doDelete(sql, { table, filters });
    case 'upsert':   return doUpsert(sql, { table, data, onConflict, ignoreDuplicates, selectCols });
    default:         throw new Error(`Operasi tidak dikenal: ${op}`);
  }
}

// ─── SELECT ────────────────────────────────────────────────────────────────
async function doSelect(sql, { table, selectCols, filters, inVals, order, limit, single, maybeSingle }) {
  // Parse selectCols: tangani join syntax seperti "id_pps,guru(nama,dom)"
  // Neon pakai SQL biasa, jadi kita ubah ke LEFT JOIN
  const { cols, joins } = parseSelectCols(table, selectCols);

  let q = `SELECT ${cols} FROM ${table}`;
  if (joins) q += ` ${joins}`;

  const params = [];
  const whereParts = buildWhere(filters, inVals, params);
  if (whereParts) q += ` WHERE ${whereParts}`;

  if (order) {
    q += ` ORDER BY ${sanitizeCol(order.col)} ${order.asc ? 'ASC' : 'DESC'}`;
  }
  if (limit) {
    params.push(limit);
    q += ` LIMIT $${params.length}`;
  }

  const rows = await sql(q, params);

  // Ubah rows flat menjadi nested object jika ada join (misal guru.nama → guru:{nama:...})
  const result = rows.map(row => unflattenJoinRow(row, table, selectCols));

  if (single) return result[0] ?? null;
  if (maybeSingle) return result[0] ?? null;
  return result;
}

// ─── INSERT ────────────────────────────────────────────────────────────────
async function doInsert(sql, { table, data, selectCols }) {
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return [];

  const results = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    const vals = keys.map((k, i) => `$${i + 1}`).join(', ');
    const q = `INSERT INTO ${table} (${keys.map(sanitizeCol).join(', ')}) VALUES (${vals}) RETURNING *`;
    const inserted = await sql(q, keys.map(k => row[k]));
    results.push(...inserted);
  }
  return Array.isArray(data) ? results : (results[0] ?? null);
}

// ─── UPDATE ────────────────────────────────────────────────────────────────
async function doUpdate(sql, { table, data, filters }) {
  const keys = Object.keys(data);
  const params = keys.map(k => data[k]);
  const setClause = keys.map((k, i) => `${sanitizeCol(k)} = $${i + 1}`).join(', ');
  const whereParts = buildWhere(filters, null, params);
  let q = `UPDATE ${table} SET ${setClause}`;
  if (whereParts) q += ` WHERE ${whereParts}`;
  q += ' RETURNING *';
  const rows = await sql(q, params);
  return rows;
}

// ─── DELETE ────────────────────────────────────────────────────────────────
async function doDelete(sql, { table, filters }) {
  const params = [];
  const whereParts = buildWhere(filters, null, params);
  let q = `DELETE FROM ${table}`;
  if (whereParts) q += ` WHERE ${whereParts}`;
  q += ' RETURNING *';
  const rows = await sql(q, params);
  return rows;
}

// ─── UPSERT ────────────────────────────────────────────────────────────────
async function doUpsert(sql, { table, data, onConflict, ignoreDuplicates, selectCols }) {
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return [];

  const results = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    let q = `INSERT INTO ${table} (${keys.map(sanitizeCol).join(', ')}) VALUES (${placeholders})`;

    if (onConflict) {
      const conflictCols = onConflict.split(',').map(c => sanitizeCol(c.trim())).join(', ');
      if (ignoreDuplicates) {
        q += ` ON CONFLICT (${conflictCols}) DO NOTHING`;
      } else {
        const updateCols = keys
          .filter(k => !onConflict.split(',').map(c => c.trim()).includes(k))
          .map(k => `${sanitizeCol(k)} = EXCLUDED.${sanitizeCol(k)}`);
        q += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols.join(', ')}`;
      }
    } else {
      q += ignoreDuplicates ? ' ON CONFLICT DO NOTHING' : '';
    }

    q += ' RETURNING *';
    const inserted = await sql(q, keys.map(k => row[k]));
    results.push(...inserted);
  }
  return Array.isArray(data) ? results : (results[0] ?? null);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Sanitasi nama kolom/tabel — hanya huruf, angka, underscore, titik
 */
function sanitizeCol(col) {
  if (!/^[a-zA-Z0-9_.]+$/.test(col)) throw new Error(`Nama kolom tidak valid: ${col}`);
  return col;
}

/**
 * Build WHERE clause dari array filters dan inVals.
 * Params diisi ke-array params (pass by reference).
 */
function buildWhere(filters, inVals, params) {
  const parts = [];

  for (const f of (filters || [])) {
    params.push(f.val);
    if (f.type === 'eq')  parts.push(`${sanitizeCol(f.col)} = $${params.length}`);
    if (f.type === 'neq') parts.push(`${sanitizeCol(f.col)} != $${params.length}`);
  }

  if (inVals && inVals.vals.length > 0) {
    const placeholders = inVals.vals.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    parts.push(`${sanitizeCol(inVals.col)} IN (${placeholders.join(', ')})`);
  }

  return parts.join(' AND ');
}

/**
 * Parse selectCols Supabase-style ke SQL SELECT + LEFT JOIN.
 * Contoh input: "id_pps,created_at,guru(nama,dom)"
 * Output: cols = "sesi_absensi.id_pps, sesi_absensi.created_at, guru.nama AS \"guru.nama\", guru.dom AS \"guru.dom\""
 *         joins = "LEFT JOIN guru ON sesi_absensi.id_pps = guru.id_pps"
 *
 * Relasi yang diketahui: absensi → guru (via id_pps)
 */
const RELATIONS = {
  absensi: { guru: 'guru.id_pps = absensi.id_pps' },
};

function parseSelectCols(table, selectCols) {
  if (!selectCols || selectCols === '*') {
    return { cols: `${table}.*`, joins: '' };
  }

  const colParts = [];
  const joinParts = [];

  // Split top-level columns (respecting parentheses)
  const tokens = tokenizeSelectCols(selectCols);

  for (const token of tokens) {
    const m = token.match(/^(\w+)\((.+)\)$/);
    if (m) {
      // Joined table: e.g. guru(nama,dom)
      const joinTable = m[1];
      const joinCols  = m[2].split(',').map(c => c.trim());
      joinCols.forEach(c => {
        colParts.push(`${joinTable}.${sanitizeCol(c)} AS "${joinTable}.${c}"`);
      });
      const rel = RELATIONS[table]?.[joinTable];
      if (rel) joinParts.push(`LEFT JOIN ${joinTable} ON ${rel}`);
      else     joinParts.push(`LEFT JOIN ${joinTable} ON TRUE`); // fallback
    } else {
      const c = token.trim();
      if (c === '*') colParts.push(`${table}.*`);
      else           colParts.push(`${table}.${sanitizeCol(c)}`);
    }
  }

  return {
    cols:  colParts.join(', '),
    joins: joinParts.join(' '),
  };
}

function tokenizeSelectCols(s) {
  const tokens = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { tokens.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) tokens.push(cur.trim());
  return tokens;
}

/**
 * Ubah row flat {guru.nama, guru.dom} menjadi nested {guru: {nama, dom}}
 * sesuai yang diharapkan oleh kode frontend.
 */
function unflattenJoinRow(row, table, selectCols) {
  if (!selectCols || selectCols === '*') return row;
  const result = {};
  for (const [key, val] of Object.entries(row)) {
    if (key.includes('.')) {
      const [joinTable, col] = key.split('.');
      if (!result[joinTable]) result[joinTable] = {};
      result[joinTable][col] = val;
    } else {
      result[key] = val;
    }
  }
  return result;
}
