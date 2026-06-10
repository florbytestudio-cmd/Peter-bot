// ============================================================
// PASO 3: WEBHOOK COMPLETO — Twilio WhatsApp + Whisper + OpenAI + Supabase
// ============================================================

import express        from "express";
import axios          from "axios";
import FormData       from "form-data";
import { createClient } from "@supabase/supabase-js";
import { procesarGastoConIA } from "./paso2_procesarGastoConIA.js";
import twilio          from "twilio";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio envía form-encoded

// ── Clientes externos ─────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);


// ============================================================
// UTILIDADES
// ============================================================

/**
 * Descarga audio de Twilio y lo convierte a buffer.
 */
async function descargarAudioTwilio(mediaUrl) {
  const { data } = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN
    }
  });
  return Buffer.from(data);
}

/**
 * Transcribe audio con OpenAI Whisper.
 */
async function transcribirConWhisper(audioBuffer, contentType = "audio/ogg") {
  const formData = new FormData();
  const extension = contentType.includes("mpeg") ? "mp3" :
                    contentType.includes("mp4")  ? "mp4" : "ogg";
  formData.append("file", audioBuffer, {
    filename:    `audio.${extension}`,
    contentType: contentType
  });
  formData.append("model",    "whisper-1");
  formData.append("language", "es");
  formData.append("response_format", "text");

  const { data: texto } = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      }
    }
  );
  return texto.trim();
}

/**
 * Guarda transacción en Supabase.
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
 * Responde al usuario por WhatsApp vía Twilio.
 */
async function responderWhatsApp(numeroDestino, mensaje) {
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    to:   `whatsapp:${numeroDestino}`,
    body: mensaje
  });
}

/**
 * Formatea mensaje de confirmación para Peter.
 */
function formatearConfirmacion(t) {
  const emoji = t.tipo === "INGRESO" ? "💰" : "💸";
  const signo = t.tipo === "INGRESO" ? "+"  : "-";
  const monto = parseFloat(t.monto).toLocaleString("es-MX", {
    style: "currency", currency: "MXN"
  });
  return (
    `${emoji} *Registrado en ${t.entorno}*\n\n` +
    `📝 ${t.concepto}\n` +
    `🏷️ ${t.categoria}\n` +
    `💵 ${signo}${monto}\n` +
    `📊 ${t.tipo}\n\n` +
    `_ID: #${t.id}_`
  );
}


// ============================================================
// RUTAS
// ============================================================

/**
 * POST /webhook — Twilio envía aquí los mensajes de WhatsApp
 */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body      = req.body;
    const from      = body.From?.replace("whatsapp:", ""); // número del remitente
    const tipo      = body.MediaContentType0 ? "audio" : "text";
    const texto     = body.Body || "";

    console.log(`[Webhook] Mensaje de ${from} — tipo: ${tipo}`);

    let textoParaProcesar = null;

    // ── Texto ──────────────────────────────────────────────────
    if (tipo === "text") {
      textoParaProcesar = texto;
    }

    // ── Audio (nota de voz) ────────────────────────────────────
    else if (tipo === "audio") {
      const mediaUrl     = body.MediaUrl0;
      const contentType  = body.MediaContentType0 || "audio/ogg";

      console.log("[Whisper] Descargando audio...");
      const audioBuffer = await descargarAudioTwilio(mediaUrl);

      console.log("[Whisper] Transcribiendo...");
      textoParaProcesar = await transcribirConWhisper(audioBuffer, contentType);
      console.log(`[Whisper] Transcripción: "${textoParaProcesar}"`);
    }

    else {
      await responderWhatsApp(from,
        "⚠️ Solo proceso notas de voz y mensajes de texto."
      );
      return;
    }

    // ── Procesar con IA ────────────────────────────────────────
    console.log("[OpenAI] Procesando...");
    const resultado = await procesarGastoConIA(textoParaProcesar);

    if (!resultado.success) {
      await responderWhatsApp(from,
        "🤔 No detecté ningún movimiento financiero.\n\n" +
        "Intenta con:\n" +
        "• _\"Gasté 800 en cemento\"_\n" +
        "• _\"Entró pago de cliente, 5 mil\"_\n" +
        "• _\"Compré ropa, dos mil cuatrocientos\"_"
      );
      return;
    }

    // ── Guardar en Supabase ────────────────────────────────────
    console.log("[Supabase] Guardando...");
    const guardado = await guardarEnSupabase(resultado.datos);

    // ── Confirmar a Peter ──────────────────────────────────────
    await responderWhatsApp(from, formatearConfirmacion(guardado));
    console.log(`[OK] Transacción #${guardado.id} guardada ✅`);

  } catch (err) {
    console.error("[ERROR] Webhook:", err.message);
    try {
      const from = req.body?.From?.replace("whatsapp:", "");
      if (from) await responderWhatsApp(from, "❌ Error procesando tu mensaje. Intenta de nuevo.");
    } catch (_) {}
  }
});

// ── Healthcheck ───────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// ── Arranque ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Fernando Bot corriendo en puerto ${PORT}`));
