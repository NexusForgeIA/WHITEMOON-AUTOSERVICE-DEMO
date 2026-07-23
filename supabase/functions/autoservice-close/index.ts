import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// autoservice-close — postventa de la demo WhiteMoon · AutoService IA.
// Se dispara al pasar un ticket a 'cerrado' (desde autoservice-tickets) y avisa
// con el enlace de resena de Google que hay que hacer llegar al cliente.
//
// Canal de avisos: TELEGRAM (antes CallMeBot/WhatsApp).
//
// Secrets usados (nunca en cliente):
//   - TELEGRAM_BOT_TOKEN        : token del bot de Telegram (obligatorio)
//   - TELEGRAM_CHAT_ID          : chat destino; si falta se usa CHAT_ID_FALLBACK
//   - SUPABASE_URL              : inyectado por la plataforma
//   - SUPABASE_SERVICE_ROLE_KEY : inyectado por la plataforma
//
// Antes se enviaban DOS mensajes por CallMeBot: uno al WhatsApp del tecnico
// (via su callmebot_apikey) y otro a gerencia. Con Telegram el destino es un
// unico chat, asi que se envia UN solo aviso que ya incluye al tecnico y el
// enlace de resena. Las columnas tecnicos.wa_number y .callmebot_apikey se
// conservan en la BD pero esta funcion ya no lee la apikey.
//
// NOTA para cliente REAL (no implementado aqui, es una demo): para avisar a
// cada tecnico en su propio Telegram haria falta una columna
// tecnicos.telegram_chat_id, que se rellena cuando cada tecnico hace /start al
// bot. Entonces el chat_id del sendMessage seria el del tecnico asignado, con
// el chat de gerencia como copia. En la demo basta el chat de WhiteMoon.
//
// Regla del proyecto: si el aviso falla -> console.warn, nunca rompe el cierre.
//
// Desplegar con:
//   supabase functions deploy autoservice-close --no-verify-jwt --project-ref mlaqtniujnvfxcvcourm

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// El chat_id no es un secreto (solo identifica el destino); el token si lo es.
const CHAT_ID_FALLBACK = '861432965';
const GMB_FALLBACK = 'https://maps.app.goo.gl/3b9zDZrC8uvJfmYt7';

const REST_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
};

// Devuelve true solo si Telegram acepto el mensaje, para poder verificar el
// aviso de punta a punta desde la respuesta de la funcion.
async function notificar(text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID') || CHAT_ID_FALLBACK;
  if (!token) {
    console.warn('[autoservice-close] sin TELEGRAM_BOT_TOKEN, mensaje:', text);
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!r.ok) {
      console.warn('[autoservice-close] Telegram fallo:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[autoservice-close] error enviando Telegram:', e);
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
    const ticketId = String(body.ticket_id || '');
    if (!ticketId) {
      return new Response(JSON.stringify({ error: 'ticket_id obligatorio' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 1. Cargar ticket
    const tRes = await fetch(`${SUPABASE_URL}/rest/v1/tickets_servicio?id=eq.${encodeURIComponent(ticketId)}&select=id,cliente_nombre,cliente_telefono,tipo_averia,estado,resena_enviada,tecnico_id,tecnico_asignado,cerrado_at`, { headers: REST_HEADERS });
    const tickets = await tRes.json();
    const ticket = Array.isArray(tickets) ? tickets[0] : null;

    if (!ticket) {
      return new Response(JSON.stringify({ ok: false, reason: 'ticket no encontrado' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (ticket.estado !== 'cerrado') {
      return new Response(JSON.stringify({ ok: false, reason: `ticket en estado '${ticket.estado}', solo se procesa 'cerrado'` }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (ticket.resena_enviada === true) {
      return new Response(JSON.stringify({ ok: true, reason: 'resena ya enviada (idempotente)' }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 2. Cargar tecnico asignado (solo para el nombre y su URL GMB)
    let tecnico: any = null;
    if (ticket.tecnico_id) {
      const tecRes = await fetch(`${SUPABASE_URL}/rest/v1/tecnicos?id=eq.${encodeURIComponent(ticket.tecnico_id)}&select=id,nombre,gmb_url`, { headers: REST_HEADERS });
      const tecs = await tecRes.json();
      tecnico = Array.isArray(tecs) ? tecs[0] : null;
    }

    // 3. Marcar resena enviada + cerrado_at (idempotencia antes de notificar)
    await fetch(`${SUPABASE_URL}/rest/v1/tickets_servicio?id=eq.${encodeURIComponent(ticketId)}`, {
      method: 'PATCH',
      headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        resena_enviada: true,
        cerrado_at: ticket.cerrado_at || new Date().toISOString(),
      }),
    });

    // 4. Aviso unico por Telegram, con el tecnico y la URL de resena
    const gmb = (tecnico && tecnico.gmb_url) || GMB_FALLBACK;
    const nombreTecnico = tecnico ? tecnico.nombre : (ticket.tecnico_asignado || 'SIN ASIGNAR');
    const msg = `✅ TICKET CERRADO - AutoService IA\n` +
      `Cliente: ${ticket.cliente_nombre}\n` +
      `Tel: ${ticket.cliente_telefono}\n` +
      `Averia: ${ticket.tipo_averia}\n` +
      `Tecnico: ${nombreTecnico}\n\n` +
      `Envia al cliente el enlace de resena:\n${gmb}`;
    const notified = await notificar(msg);

    // 5. Log
    await fetch(`${SUPABASE_URL}/rest/v1/ticket_log`, {
      method: 'POST',
      headers: { ...REST_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        ticket_id: ticket.id,
        tecnico_id: ticket.tecnico_id,
        estado_anterior: 'cerrado',
        estado_nuevo: 'cerrado',
        notas: `Postventa: enlace de resena avisado por Telegram (tecnico: ${nombreTecnico})`,
      }),
    }).catch(() => {});

    return new Response(JSON.stringify({
      ok: true,
      ticket_id: ticket.id,
      tecnico: tecnico ? tecnico.nombre : null,
      notified,
    }), { headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
