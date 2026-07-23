import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// autoservice-tecnicos — listado y edicion de tecnicos desde crm.html.
//
// Los avisos del CRM salen por Telegram desde el servidor
// (autoservice-lead para la asignacion, autoservice-close para el cierre), asi
// que aqui ya NO se acepta ni se expone ninguna apikey de CallMeBot: el campo
// salio del formulario del CRM y de la lista de campos editables. La columna
// tecnicos.callmebot_apikey sigue existiendo en la BD pero queda huerfana.
//
// NOTA para cliente REAL (no implementado aqui, es una demo): para avisar a
// cada tecnico en su propio Telegram haria falta una columna
// tecnicos.telegram_chat_id (cada tecnico hace /start al bot y se guarda su
// chat_id), y este seria el sitio donde gestionarla desde el CRM.
//
// Desplegar con:
//   supabase functions deploy autoservice-tecnicos --no-verify-jwt --project-ref mlaqtniujnvfxcvcourm

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const REST_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
};

// Campos editables desde el CRM. usuario, rol y password quedan fuera a proposito.
const CAMPOS_PERMITIDOS = ['nombre', 'wa_number', 'zonas', 'especialidades', 'gmb_url', 'activo'];

Deno.serve(async (req: Request) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  try {
    const body = await req.json();
    const action = String(body.action || '');

    // ---- LISTAR ----
    if (action === 'list') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tecnicos?select=id,nombre,usuario,rol,zonas,especialidades,wa_number,gmb_url,activo&order=nombre.asc`, { headers: REST_HEADERS });
      const rows = await r.json();
      const safe = (Array.isArray(rows) ? rows : []).map((t: any) => ({
        id: t.id,
        nombre: t.nombre,
        usuario: t.usuario,
        rol: t.rol,
        zonas: t.zonas || [],
        especialidades: t.especialidades || [],
        wa_number: t.wa_number || '',
        gmb_url: t.gmb_url || '',
        activo: t.activo,
      }));
      return new Response(JSON.stringify({ ok: true, tecnicos: safe }), { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // ---- ACTUALIZAR ----
    if (action === 'update') {
      const id = String(body.id || '');
      const campos = body.campos || {};
      if (!id) {
        return new Response(JSON.stringify({ error: 'id obligatorio' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const patch: Record<string, unknown> = {};
      for (const k of CAMPOS_PERMITIDOS) {
        if (k in campos) patch[k] = campos[k];
      }
      if (Object.keys(patch).length === 0) {
        return new Response(JSON.stringify({ error: 'sin campos validos que actualizar' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tecnicos?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
        body: JSON.stringify(patch),
      });
      const rows = await r.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) {
        return new Response(JSON.stringify({ error: 'tecnico no encontrado' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, id: row.id, nombre: row.nombre }), { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    }

    return new Response(JSON.stringify({ error: 'action debe ser list o update' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
