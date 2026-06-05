import { neon } from '@neondatabase/serverless';

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (!context.env.NEON_DATABASE_URL) {
    return Response.json({ error: 'NEON_DATABASE_URL belum diset' }, { status: 500, headers: corsHeaders });
  }

  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders });
  }

  const sql = neon(context.env.NEON_DATABASE_URL);

  try {
    const data = await handleQuery(sql, payload);
    return Response.json({ data }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

const ALLOWED = ['guru','absensi','sesi_absensi','kalender_hijriah'];

async function handleQuery(sql, p) {
  const { table, op, data, filters, order, limit, single, maybeSingle,
          ignoreDuplicates, onConflict, selectCols, inVals } = p;
  if (!ALLOWED.includes(table)) throw new Error('Tabel tidak diizinkan: ' + table);
  switch (op) {
    case 'select': return doSelect(sql, { table, selectCols, filters, inVals, order, limit, single, maybeSingle });
    case 'insert': return doInsert(sql, { table, data });
    case 'update': return doUpdate(sql, { table, data, filters });
    case 'delete': return doDelete(sql, { table, filters });
    case 'upsert': return doUpsert(sql, { table, data, onConflict, ignoreDuplicates });
    default: throw new Error('Operasi tidak dikenal: ' + op);
  }
}

const RELATIONS = { absensi: { guru: 'guru.id_pps = absensi.id_pps' } };

function sanitize(col) {
  if (!/^[a-zA-Z0-9_.]+$/.test(col)) throw new Error('Kolom tidak valid: ' + col);
  return col;
}

function buildWhere(filters, inVals, params) {
  const parts = [];
  for (const f of (filters || [])) {
    params.push(f.val);
    if (f.type === 'eq')  parts.push(`${sanitize(f.col)} = $${params.length}`);
    if (f.type === 'neq') parts.push(`${sanitize(f.col)} != $${params.length}`);
  }
  if (inVals?.vals?.length) {
    const ph = inVals.vals.map(v => { params.push(v); return `$${params.length}`; });
    parts.push(`${sanitize(inVals.col)} IN (${ph.join(', ')})`);
  }
  return parts.join(' AND ');
}

function tokenize(s) {
  const tokens = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { tokens.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) tokens.push(cur.trim());
  return tokens;
}

function parseSelect(table, selectCols) {
  if (!selectCols || selectCols === '*') return { cols: `${table}.*`, joins: '' };
  const colParts = [], joinParts = [];
  for (const token of tokenize(selectCols)) {
    const m = token.match(/^(\w+)\((.+)\)$/);
    if (m) {
      m[2].split(',').forEach(c => colParts.push(`${m[1]}.${sanitize(c.trim())} AS "${m[1]}.${c.trim()}"`));
      const rel = RELATIONS[table]?.[m[1]];
      joinParts.push(`LEFT JOIN ${m[1]} ON ${rel || 'TRUE'}`);
    } else {
      colParts.push(token === '*' ? `${table}.*` : `${table}.${sanitize(token)}`);
    }
  }
  return { cols: colParts.join(', '), joins: joinParts.join(' ') };
}

function unflatten(row) {
  const result = {};
  for (const [key, val] of Object.entries(row)) {
    if (key.includes('.')) {
      const [t, c] = key.split('.');
      if (!result[t]) result[t] = {};
      result[t][c] = val;
    } else result[key] = val;
  }
  return result;
}

async function doSelect(sql, { table, selectCols, filters, inVals, order, limit, single, maybeSingle }) {
  const { cols, joins } = parseSelect(table, selectCols);
  let q = `SELECT ${cols} FROM ${table}`;
  if (joins) q += ` ${joins}`;
  const params = [];
  const where = buildWhere(filters, inVals, params);
  if (where) q += ` WHERE ${where}`;
  if (order) q += ` ORDER BY ${sanitize(order.col)} ${order.asc ? 'ASC' : 'DESC'}`;
  if (limit) { params.push(limit); q += ` LIMIT $${params.length}`; }
  const rows = (await sql(q, params)).map(unflatten);
  return (single || maybeSingle) ? (rows[0] ?? null) : rows;
}

async function doInsert(sql, { table, data }) {
  const rows = Array.isArray(data) ? data : [data];
  const results = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    const q = `INSERT INTO ${table} (${keys.map(sanitize).join(', ')}) VALUES (${keys.map((_,i) => `$${i+1}`)}) RETURNING *`;
    results.push(...await sql(q, keys.map(k => row[k])));
  }
  return Array.isArray(data) ? results : (results[0] ?? null);
}

async function doUpdate(sql, { table, data, filters }) {
  const keys = Object.keys(data);
  const params = keys.map(k => data[k]);
  const set = keys.map((k,i) => `${sanitize(k)} = $${i+1}`).join(', ');
  const where = buildWhere(filters, null, params);
  const q = `UPDATE ${table} SET ${set}${where ? ' WHERE '+where : ''} RETURNING *`;
  return sql(q, params);
}

async function doDelete(sql, { table, filters }) {
  const params = [];
  const where = buildWhere(filters, null, params);
  return sql(`DELETE FROM ${table}${where ? ' WHERE '+where : ''} RETURNING *`, params);
}

async function doUpsert(sql, { table, data, onConflict, ignoreDuplicates }) {
  const rows = Array.isArray(data) ? data : [data];
  const results = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    const ph = keys.map((_,i) => `$${i+1}`).join(', ');
    let q = `INSERT INTO ${table} (${keys.map(sanitize).join(', ')}) VALUES (${ph})`;
    if (onConflict) {
      const cc = onConflict.split(',').map(c => sanitize(c.trim())).join(', ');
      if (ignoreDuplicates) q += ` ON CONFLICT (${cc}) DO NOTHING`;
      else {
        const upd = keys.filter(k => !onConflict.split(',').map(c=>c.trim()).includes(k))
                        .map(k => `${sanitize(k)} = EXCLUDED.${sanitize(k)}`).join(', ');
        q += ` ON CONFLICT (${cc}) DO UPDATE SET ${upd}`;
      }
    } else if (ignoreDuplicates) q += ' ON CONFLICT DO NOTHING';
    q += ' RETURNING *';
    results.push(...await sql(q, keys.map(k => row[k])));
  }
  return Array.isArray(data) ? results : (results[0] ?? null);
}
