export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (!context.env.NEON_DATABASE_URL) {
    return Response.json({ error: 'NEON_DATABASE_URL belum diset' }, { status: 500, headers: cors });
  }
  let payload;
  try { payload = await context.request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: cors }); }
  try {
    const data = await handleQuery(context.env.NEON_DATABASE_URL, payload);
    return Response.json({ data }, { headers: cors });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: cors });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }});
}

async function sqlQuery(dbUrl, query, params = []) {
  const match = dbUrl.match(/postgresql:\/\/([^:]+):([^@]+)@([^/]+)\/(.+?)(\?.*)?$/);
  if (!match) throw new Error('Format DATABASE_URL tidak valid');
  const [, , , host] = match;
  const res = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': dbUrl,
    },
    body: JSON.stringify({ query, params }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Neon error: ' + err);
  }
  const json = await res.json();
  return json.rows ?? [];
}

const ALLOWED = ['guru','absensi','sesi_absensi','kalender_hijriah'];
const RELATIONS = { absensi: { guru: 'guru.id_pps = absensi.id_pps' } };

function san(col) {
  if (!/^[a-zA-Z0-9_.]+$/.test(col)) throw new Error('Kolom tidak valid: ' + col);
  return col;
}

function buildWhere(filters, inVals, params) {
  const parts = [];
  for (const f of (filters || [])) {
    params.push(f.val);
    if (f.type === 'eq')  parts.push(`${san(f.col)} = $${params.length}`);
    if (f.type === 'neq') parts.push(`${san(f.col)} != $${params.length}`);
  }
  if (inVals?.vals?.length) {
    const ph = inVals.vals.map(v => { params.push(v); return `$${params.length}`; });
    parts.push(`${san(inVals.col)} IN (${ph.join(',')})`);
  }
  return parts.join(' AND ');
}

function tokenize(s) {
  const tokens = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch==='('){depth++;cur+=ch;}
    else if(ch===')'){depth--;cur+=ch;}
    else if(ch===','&&depth===0){tokens.push(cur.trim());cur='';}
    else cur+=ch;
  }
  if(cur.trim())tokens.push(cur.trim());
  return tokens;
}

function parseSelect(table, sc) {
  if (!sc || sc==='*') return { cols:`${table}.*`, joins:'' };
  const colParts=[], joinParts=[];
  for (const t of tokenize(sc)) {
    const m = t.match(/^(\w+)\((.+)\)$/);
    if (m) {
      m[2].split(',').forEach(c=>colParts.push(`${m[1]}.${san(c.trim())} AS "${m[1]}.${c.trim()}"`));
      const rel=RELATIONS[table]?.[m[1]];
      joinParts.push(`LEFT JOIN ${m[1]} ON ${rel||'TRUE'}`);
    } else {
      colParts.push(t==='*'?`${table}.*`:`${table}.${san(t)}`);
    }
  }
  return { cols:colParts.join(', '), joins:joinParts.join(' ') };
}

function unflatten(row) {
  const r={};
  for(const[k,v]of Object.entries(row)){
    if(k.includes('.')){const[t,c]=k.split('.');if(!r[t])r[t]={};r[t][c]=v;}
    else r[k]=v;
  }
  return r;
}

async function handleQuery(dbUrl, p) {
  const {table,op,data,filters,order,limit,single,maybeSingle,
         ignoreDuplicates,onConflict,selectCols,inVals}=p;
  if (!ALLOWED.includes(table)) throw new Error('Tabel tidak diizinkan: '+table);
  const params=[];

  // ── SELECT ──────────────────────────────────────────────────
  if (op==='select') {
    const {cols,joins}=parseSelect(table,selectCols);
    let q=`SELECT ${cols} FROM ${table}`;
    if(joins)q+=` ${joins}`;
    const w=buildWhere(filters,inVals,params);
    if(w)q+=` WHERE ${w}`;
    if(order)q+=` ORDER BY ${san(order.col)} ${order.asc?'ASC':'DESC'}`;
    if(limit){params.push(limit);q+=` LIMIT $${params.length}`;}
    const rows=(await sqlQuery(dbUrl,q,params)).map(unflatten);
    return (single||maybeSingle)?(rows[0]??null):rows;
  }

  // ── INSERT (bulk — satu query untuk semua rows) ──────────────
  if (op==='insert') {
    const rows = Array.isArray(data) ? data : [data];
    if (rows.length === 0) return [];

    const keys = Object.keys(rows[0]);
    // Build: INSERT INTO t (col1,col2) VALUES ($1,$2),($3,$4),... RETURNING *
    const valueClauses = rows.map((row, ri) =>
      `(${keys.map((_, ci) => `$${ri * keys.length + ci + 1}`).join(',')})`
    );
    const allParams = rows.flatMap(row => keys.map(k => row[k]));
    const q = `INSERT INTO ${table} (${keys.map(san).join(',')}) VALUES ${valueClauses.join(',')} RETURNING *`;
    const results = await sqlQuery(dbUrl, q, allParams);
    return Array.isArray(data) ? results : (results[0] ?? null);
  }

  // ── UPDATE ──────────────────────────────────────────────────
  if (op==='update') {
    const keys=Object.keys(data);
    const vals=keys.map(k=>data[k]);
    const set=keys.map((k,i)=>`${san(k)}=$${i+1}`).join(',');
    vals.forEach(v=>params.push(v));
    const w=buildWhere(filters,null,params);
    return sqlQuery(dbUrl,`UPDATE ${table} SET ${set}${w?' WHERE '+w:''} RETURNING *`,params);
  }

  // ── DELETE ──────────────────────────────────────────────────
  if (op==='delete') {
    const w=buildWhere(filters,null,params);
    return sqlQuery(dbUrl,`DELETE FROM ${table}${w?' WHERE '+w:''} RETURNING *`,params);
  }

  // ── UPSERT (bulk) ────────────────────────────────────────────
  if (op==='upsert') {
    const rows=Array.isArray(data)?data:[data];
    if (rows.length === 0) return [];

    const keys = Object.keys(rows[0]);
    const valueClauses = rows.map((row, ri) =>
      `(${keys.map((_, ci) => `$${ri * keys.length + ci + 1}`).join(',')})`
    );
    const allParams = rows.flatMap(row => keys.map(k => row[k]));

    let q = `INSERT INTO ${table} (${keys.map(san).join(',')}) VALUES ${valueClauses.join(',')}`;
    if (onConflict) {
      const cc = onConflict.split(',').map(c=>san(c.trim())).join(',');
      if (ignoreDuplicates) {
        q += ` ON CONFLICT (${cc}) DO NOTHING`;
      } else {
        const conflictKeys = onConflict.split(',').map(c=>c.trim());
        const upd = keys
          .filter(k => !conflictKeys.includes(k))
          .map(k => `${san(k)}=EXCLUDED.${san(k)}`).join(',');
        q += upd
          ? ` ON CONFLICT (${cc}) DO UPDATE SET ${upd}`
          : ` ON CONFLICT (${cc}) DO NOTHING`;
      }
    } else if (ignoreDuplicates) {
      q += ' ON CONFLICT DO NOTHING';
    }
    q += ' RETURNING *';

    const results = await sqlQuery(dbUrl, q, allParams);
    return Array.isArray(data) ? results : (results[0] ?? null);
  }

  throw new Error('Operasi tidak dikenal: '+op);
}
