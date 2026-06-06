// ============================================================
// PASO 3: WEBHOOK COMPLETO — WhatsApp + Whisper + Gemini + Supabase
// Stack: Node.js + Express + Axios + OpenAI Whisper + Supabase
// ============================================================

import express        from "express";
import axios          from "axios";
import FormData       from "form-data";
import { createClient } from "@supabase/supabase-js";
import { procesarGastoConIA } from "./paso2_procesarGastoConIA.js";

const app  = express();
app.use(express.json());

// ── Clientes externos (inicialización única) ──────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY   // Service role: bypasea RLS
);


// ============================================================
// UTILIDADES
// ============================================================

/**
 * Descarga el audio de los servidores de Meta usando el media_id.
 * Meta requiere autenticación con el token en cada descarga.
 * Devuelve un Buffer con los bytes del archivo.
 */
async function descargarAudioMeta(mediaId) {
  // 1. Obtener la URL real del archivo
  const { data: mediaInfo } = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    }
  );

  // 2. Descargar el archivo como buffer binario
  const { data: audioBuffer } = await axios.get(mediaInfo.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    responseType: "arraybuffer"
  });

  return Buffer.from(audioBuffer);
}

/**
 * Transcribe un buffer de audio usando OpenAI Whisper.
 * WhatsApp envía audio en formato OGG/Opus — Whisper lo acepta nativamente.
 * Devuelve el texto transcrito en español.
 */
async function transcribirConWhisper(audioBuffer) {
  const formData = new FormData();
  formData.append("file", audioBuffer, {
    filename:    "audio.ogg",
    contentType: "audio/ogg"
  });
  formData.append("model",    "whisper-1");
  formData.append("language", "es");          // Forzar español
  formData.append("response_format", "text"); // Solo el texto, sin metadata

  const { data: texto } = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    {
      headers: {
        Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      }
    }
  );

  return texto.trim();
}

/**
 * Guarda una transacción procesada en Supabase.
 * Recibe el objeto `datos` que devuelve procesarGastoConIA.
 */
async function guardarEnSupabase(datos) {
  const { data, error } = await supabase
    .from("transacciones")
    .insert([datos])
    .select()
    .single();

  if (error) throw new Error(`Supabase insert error: ${error.message}`);
  return data;
}

/**
 * Envía un mensaje de texto de vuelta al usuario por WhatsApp.
 */
async function responderWhatsApp(numeroDestino, mensaje) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to:   numeroDestino,
      type: "text",
      text: { body: mensaje }
    },
    {
      headers: {
        Authorization:  `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/**
 * Formatea el mensaje de confirmación que le llega a Peter.
 * Claro, emoji-friendly y con toda la info relevante.
 */
function formatearConfirmacion(transaccion) {
  const emoji      = transaccion.tipo === "INGRESO" ? "💰" : "💸";
  const signo      = transaccion.tipo === "INGRESO" ? "+"  : "-";
  const monto      = transaccion.monto.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  const confianza  = transaccion.confianza_ia ? ` (${transaccion.confianza_ia}% confianza)` : "";

  return (
    `${emoji} *Registrado en ${transaccion.entorno}*\n\n` +
    `📝 ${transaccion.concepto}\n` +
    `🏷️ ${transaccion.categoria}\n` +
    `💵 ${signo}${monto}\n` +
    `📊 ${transaccion.tipo}${confianza}\n\n` +
    `_ID: #${transaccion.id}_`
  );
}


// ============================================================
// RUTAS DEL WEBHOOK
// ============================================================

/**
 * GET /webhook
 * Meta llama a este endpoint para verificar que el webhook es tuyo.
 * Solo ocurre UNA VEZ cuando configuras el webhook en el panel de Meta.
 */
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("[Webhook] Verificación de Meta exitosa ✅");
    res.status(200).send(challenge);
  } else {
    console.warn("[Webhook] Verificación fallida — token incorrecto");
    res.sendStatus(403);
  }
});


/**
 * POST /webhook
 * Meta envía aquí TODOS los mensajes entrantes de WhatsApp.
 * Este es el corazón del sistema.
 */
app.post("/webhook", async (req, res) => {

  // Meta espera un 200 inmediato, si tardamos >20s reintenta el envío
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // Ignorar notificaciones de estado (delivered, read, etc.)
    if (!value?.messages) return;

    const mensaje = value.messages[0];
    const from    = mensaje.from;   // Número del remitente (Peter)
    const tipo    = mensaje.type;   // "text" | "audio"

    console.log(`[Webhook] Mensaje recibido de ${from} — tipo: ${tipo}`);

    let textoParaProcesar = null;

    // ── Caso 1: Mensaje de TEXTO ──────────────────────────────
    if (tipo === "text") {
      textoParaProcesar = mensaje.text.body;
    }

    // ── Caso 2: Nota de VOZ (audio) ───────────────────────────
    else if (tipo === "audio") {
      const mediaId = mensaje.audio.id;

      console.log(`[Whisper] Descargando audio ${mediaId}...`);
      const audioBuffer = await descargarAudioMeta(mediaId);

      console.log("[Whisper] Transcribiendo...");
      textoParaProcesar = await transcribirConWhisper(audioBuffer);
      console.log(`[Whisper] Transcripción: "${textoParaProcesar}"`);
    }

    // ── Tipo de mensaje no soportado ──────────────────────────
    else {
      await responderWhatsApp(from,
        "⚠️ Solo proceso notas de voz y mensajes de texto.\n\nEjemplo: _\"Gasté 500 en gasolina\"_"
      );
      return;
    }

    // ── Procesamiento con Gemini ──────────────────────────────
    console.log("[Gemini] Procesando con IA...");
    const resultado = await procesarGastoConIA(textoParaProcesar);

    // ── Sin transacción detectada ─────────────────────────────
    if (!resultado.success) {
      await responderWhatsApp(from,
        "🤔 No detecté ningún movimiento financiero en tu mensaje.\n\n" +
        "Intenta con algo como:\n" +
        "• _\"Gasté 800 en cemento\"_\n" +
        "• _\"Entró pago de cliente, 5 mil\"_\n" +
        "• _\"Compré ropa, dos mil cuatrocientos\"_"
      );
      return;
    }

    // ── Guardar en Supabase ───────────────────────────────────
    console.log("[Supabase] Guardando transacción...");
    const transaccionGuardada = await guardarEnSupabase(resultado.datos);

    // ── Confirmar a Peter ─────────────────────────────────────
    const confirmacion = formatearConfirmacion(transaccionGuardada);
    await responderWhatsApp(from, confirmacion);

    console.log(`[OK] Transacción #${transaccionGuardada.id} guardada ✅`);

  } catch (error) {
    console.error("[ERROR] Webhook:", error.message);

    // Intentar notificar al usuario del error (best effort)
    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        await responderWhatsApp(from,
          "❌ Hubo un error procesando tu mensaje. Por favor intenta de nuevo."
        );
      }
    } catch (_) { /* silencioso */ }
  }
});


// ── Healthcheck (Railway lo usa para saber que el server está vivo) ──
app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));


// ── Arranque del servidor ─────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Fernando Bot corriendo en puerto ${PORT}`);
});
