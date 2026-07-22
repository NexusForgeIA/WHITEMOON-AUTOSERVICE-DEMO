import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// autoservice-lead — captura y reparto de avisos de la demo WhiteMoon ·
// AutoService IA (servicio tecnico a domicilio).
//
// Asigna el aviso a un tecnico por zona (+ especialidad preferente, desempate
// por menor carga de tickets abiertos, fallback al gerente), inserta el ticket
// en tickets_servicio y avisa.
//
// Canal de avisos: TELEGRAM (antes CallMeBot/WhatsApp).
//
// Secrets usados (nunca en cliente):
//   - TELEGRAM_BOT_TOKEN        : token del bot de Telegram (obligatorio)
//   - TELEGRAM_CHAT_ID          : chat destino; si falta se usa CHAT_ID_FALLBACK
//   - SUPABASE_URL              : inyectado por la plataforma
//   - SUPABASE_SERVICE_ROLE_KEY : inyectado por la plataforma
//
// Antes se enviaban DOS mensajes: uno al tecnico asignado (a su propio WhatsApp
// via su callmebot_apikey) y otro a gerencia. Con Telegram el destino es un
// unico chat, asi que se envia UN solo aviso que ya incluye a quien queda
// asignado el ticket. Las columnas tecnicos.wa_number y .callmebot_apikey se
// conservan (crm.html las sigue gestionando via autoservice-tecnicos), pero
// esta funcion ya no las lee.
//
// Regla del proyecto: si el aviso falla -> console.warn, nunca rompe la captura.
//
// Desplegar con:
//   supabase functions deploy autoservice-lead --no-verify-jwt --project-ref mlaqtniujnvfxcvcourm

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// El chat_id no es un secreto (solo identifica el destino); el token si lo es.
const CHAT_ID_FALLBACK = '861432965';

const REST_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
};

function norm(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Devuelve true solo si Telegram acepto el mensaje, para poder verificar el
// aviso de punta a punta desde la respuesta de la funcion.
async function notificar(text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID') || CHAT_ID_FALLBACK;
  if (!token) {
    console.warn('[autoservice-lead] sin TELEGRAM_BOT_TOKEN, mensaje:', text);
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!r.ok) {
      console.warn('[autoservice-lead] Telegram fallo:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[autoservice-lead] error enviando Telegram:', e);
    return false;
  }
}

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
    const nombre = String(body.nombre || '').slice(0, 120);
    const telefono = String(body.telefono || '').slice(0, 30);
    const tipo_averia = String(body.tipo_averia || '').slice(0, 80);
    const zona = String(body.zona || '').slice(0, 40);
    const urgencia = String(body.urgencia || 'normal').slice(0, 20);

    if (!nombre || !telefono) {
      return new Response(JSON.stringify({ error: 'nombre y telefono son obligatorios' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 1. Cargar tecnicos activos
    const tecRes = await fetch(`${SUPABASE_URL}/rest/v1/tecnicos?activo=eq.true&select=id,nombre,rol,zonas,especialidades`, { headers: REST_HEADERS });
    const tecnicos = await tecRes.json();

    // 2. Asignacion: zona obligatoria, especialidad como preferencia, fallback gerente
    const zonaN = norm(zona);
    const averiaN = norm(tipo_averia);
    const candidatos = (Array.isArray(tecnicos) ? tecnicos : [])
      .filter((t: any) => t.rol === 'tecnico' && (t.zonas || []).some((z: string) => norm(z) === zonaN))
      .map((t: any) => ({
        ...t,
        espMatch: (t.especialidades || []).some((e: string) => averiaN.includes(norm(e)) || norm(e).includes(averiaN)),
      }))
      .sort((a: any, b: any) => Number(b.espMatch) - Number(a.espMatch));

    let asignado = candidatos[0] || null;
    let motivoAsignacion = 'zona + especialidad';

    // Desempate por carga: entre candidatos con mismo espMatch, el de menos tickets abiertos
    if (candidatos.length > 1 && candidatos[0].espMatch === candidatos[1].espMatch) {
      const empatados = candidatos.filter((c: any) => c.espMatch === candidatos[0].espMatch);
      const cargas = await Promise.all(empatados.map(async (c: any) => {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/tickets_servicio?tecnico_id=eq.${c.id}&estado=not.in.(cerrado,cancelado)&select=id`, { headers: { ...REST_HEADERS, 'Prefer': 'count=exact' } });
        const count = parseInt(r.headers.get('content-range')?.split('/')[1] || '0', 10);
        return { tecnico: c, carga: isNaN(count) ? 0 : count };
      }));
      cargas.sort((a, b) => a.carga - b.carga);
      asignado = cargas[0].tecnico;
      motivoAsignacion = 'zona + especialidad + menor carga';
    }

    if (!asignado) {
      asignado = (Array.isArray(tecnicos) ? tecnicos : []).find((t: any) => t.rol === 'gerente') || null;
      motivoAsignacion = 'fallback gerente (sin tecnico en zona)';
    }

    // 3. Insertar ticket ya asignado
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tickets_servicio`, {
      method: 'POST',
      headers: { ...REST_HEADERS, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        cliente_nombre: nombre,
        cliente_telefono: telefono,
        tipo_averia,
        zona,
        urgencia,
        estado: asignado ? 'asignado' : 'nuevo',
        tecnico_id: asignado ? asignado.id : null,
        tecnico_asignado: asignado ? asignado.nombre : null,
      }),
    });
    const inserted = await insertRes.json();
    const ticket = Array.isArray(inserted) ? inserted[0] : inserted;

    // 4. Log de asignacion
    if (ticket?.id) {
      await fetch(`${SUPABASE_URL}/rest/v1/ticket_log`, {
        method: 'POST',
        headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          ticket_id: ticket.id,
          tecnico_id: asignado ? asignado.id : null,
          estado_anterior: null,
          estado_nuevo: asignado ? 'asignado' : 'nuevo',
          notas: `Asignacion automatica: ${motivoAsignacion}`,
        }),
      }).catch(() => {});
    }

    // 5. Aviso unico por Telegram, con el tecnico asignado incluido
    const msg = `🔧 NUEVO AVISO - AutoService IA\n` +
      `Cliente: ${nombre}\n` +
      `Tel: ${telefono}\n` +
      `Averia: ${tipo_averia}\n` +
      `Zona: ${zona}\n` +
      `Urgencia: ${urgencia}\n` +
      `Asignado a: ${asignado ? asignado.nombre : 'SIN ASIGNAR'}\n` +
      `(${motivoAsignacion})`;
    const notified = await notificar(msg);

    return new Response(JSON.stringify({
      ok: true,
      ticket_id: ticket?.id || null,
      tecnico_asignado: asignado ? asignado.nombre : null,
      notified,
    }), { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
