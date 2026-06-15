// ============================================================
// FERNANDO BOT — Telegram
// node-telegram-bot-api + OpenAI Whisper + GPT-4o mini + Supabase
// ============================================================

import TelegramBot   from "node-telegram-bot-api";
import axios         from "axios";
import FormData      from "form-data";
import { createClient } from "@supabase/supabase-js";
import { procesarGastoConIA } from "./ia.js";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── ID de Telegram de Peter (solo él puede usar el bot) ──────
const PETER_CHAT_ID = process.env.PETER_CHAT_ID;

// ============================================================
// UTILIDADES
// ============================================================

function esAutorizado(chatId) {
  if (!PETER_CHAT_ID) return true; // Sin restricción si no se configura
  return String(chatId) === String(PETER_CHAT_ID);
}

async function transcribirAudio(fileId) {
  const file     = await bot.getFile(fileId);
  const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const { data: audioData } = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const audioBuffer = Buffer.from(audioData);

  const formData = new FormData();
  formData.append("file", audioBuffer, { filename: "audio.ogg", contentType: "audio/ogg" });
  formData.append("model",    "whisper-1");
  formData.append("language", "es");
  formData.append("response_format", "text");

  const { data: texto } = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...formData.getHeaders() } }
  );
  return texto.trim();
}

async function guardarTransaccion(datos) {
  const { data, error } = await supabase
    .from("transacciones")
    .insert([datos])
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

function formatearConfirmacion(t) {
  const emoji = t.tipo === "INGRESO" ? "💰" : "💸";
  const signo = t.tipo === "INGRESO" ? "+" : "-";
  const monto = parseFloat(t.monto).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  const fecha = new Date(t.fecha_transaccion).toLocaleDateString("es-MX", {
    timeZone: "America/Chihuahua",
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });
  return (
    `${emoji} *${t.entorno}*\n\n` +
    `📝 ${t.concepto}\n` +
    `🏷️ ${t.categoria}\n` +
    `💵 ${signo}${monto}\n` +
    `📅 ${fecha}\n\n` +
    `_Usa /borrar ${t.id} para eliminar_`
  );
}

function formatearLista(registros) {
  if (!registros.length) return "📭 No hay registros recientes.";
  return registros.map(t => {
    const emoji = t.tipo === "INGRESO" ? "💰" : "💸";
    const monto = parseFloat(t.monto).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
    const fecha = new Date(t.fecha_transaccion).toLocaleDateString("es-MX", {
      timeZone: "America/Chihuahua", day: "numeric", month: "short"
    });
    return `${emoji} #${t.id} · ${t.concepto} · ${monto} · ${t.entorno} · ${fecha}`;
  }).join("\n");
}

// ============================================================
// PROCESAMIENTO PRINCIPAL (texto o audio)
// ============================================================

async function procesarMensaje(chatId, texto, transcripcion = false) {
  const prefijo = transcripcion ? `🎙️ _"${texto}"_\n\n` : "";

  const resultado = await procesarGastoConIA(texto);

  if (!resultado.success) {
    await bot.sendMessage(chatId,
      "🤔 No detecté ningún movimiento financiero.\n\n" +
      "Ejemplos:\n" +
      "• _\"Gasté 800 en cemento\"_\n" +
      "• _\"Entró pago de cliente, 5 mil\"_\n" +
      "• _\"Ayer pagué 3,200 de varilla\"_",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const guardado = await guardarTransaccion(resultado.datos);
  await bot.sendMessage(chatId, prefijo + formatearConfirmacion(guardado), { parse_mode: "Markdown" });
}

// ============================================================
// COMANDOS
// ============================================================

bot.onText(/\/start/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  await bot.sendMessage(msg.chat.id,
    "👋 Hola Peter, soy *Fernando*, tu asistente financiero.\n\n" +
    "Mándame un audio o texto con tus gastos e ingresos y los registro automáticamente.\n\n" +
    "*Comandos disponibles:*\n" +
    "/ultimos — Ver últimos 10 registros\n" +
    "/borrar [id] — Eliminar un registro\n" +
    "/editar [id] [campo] [valor] — Editar un registro\n" +
    "/resumen — Resumen del mes actual\n" +
    "/dashboard — Ver tu dashboard web",
    { parse_mode: "Markdown" }
  );
});

// ── /ultimos ──────────────────────────────────────────────────
bot.onText(/\/ultimos/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  try {
    const { data, error } = await supabase
      .from("transacciones")
      .select("id, tipo, concepto, monto, entorno, fecha_transaccion")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    await bot.sendMessage(msg.chat.id, `📋 *Últimos registros:*\n\n${formatearLista(data)}`, { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

// ── /borrar [id] ──────────────────────────────────────────────
bot.onText(/\/borrar (\d+)/, async (msg, match) => {
  if (!esAutorizado(msg.chat.id)) return;
  const id = parseInt(match[1]);
  try {
    // Verificar que existe
    const { data: registro } = await supabase
      .from("transacciones").select("id, concepto, monto").eq("id", id).single();
    if (!registro) {
      await bot.sendMessage(msg.chat.id, `❌ No encontré el registro #${id}`);
      return;
    }
    const { error } = await supabase.from("transacciones").delete().eq("id", id);
    if (error) throw error;
    const monto = parseFloat(registro.monto).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
    await bot.sendMessage(msg.chat.id, `🗑️ Eliminado: *#${id} — ${registro.concepto} (${monto})*`, { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

// ── /editar [id] [campo] [valor] ──────────────────────────────
// Ejemplo: /editar 15 monto 350
// Ejemplo: /editar 15 concepto Compra de block
bot.onText(/\/editar (\d+) (\w+) (.+)/, async (msg, match) => {
  if (!esAutorizado(msg.chat.id)) return;
  const id    = parseInt(match[1]);
  const campo = match[2].toLowerCase();
  const valor = match[3].trim();

  const camposPermitidos = ["monto", "concepto", "categoria", "entorno", "tipo"];
  if (!camposPermitidos.includes(campo)) {
    await bot.sendMessage(msg.chat.id,
      `❌ Campo inválido. Puedes editar: ${camposPermitidos.join(", ")}`
    );
    return;
  }

  try {
    const valorFinal = campo === "monto" ? parseFloat(valor) : valor;
    const { error } = await supabase
      .from("transacciones")
      .update({ [campo]: valorFinal })
      .eq("id", id);
    if (error) throw error;
    await bot.sendMessage(msg.chat.id, `✅ Registro *#${id}* actualizado: *${campo}* → ${valor}`, { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

// ── /resumen ─────────────────────────────────────────────────
bot.onText(/\/resumen/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  try {
    const inicio = new Date();
    inicio.setDate(1); inicio.setHours(0,0,0,0);

    const { data, error } = await supabase
      .from("transacciones")
      .select("tipo, monto, entorno")
      .gte("fecha_transaccion", inicio.toISOString());
    if (error) throw error;

    const entornos = ["Personal", "Negocio", "Obra Majalca"];
    let resumen = `📊 *Resumen ${new Date().toLocaleDateString("es-MX", { month: "long", year: "numeric" })}*\n\n`;

    for (const entorno of entornos) {
      const registros = data.filter(r => r.entorno === entorno);
      const ingresos  = registros.filter(r => r.tipo === "INGRESO").reduce((s, r) => s + parseFloat(r.monto), 0);
      const egresos   = registros.filter(r => r.tipo === "EGRESO").reduce((s, r) => s + parseFloat(r.monto), 0);
      const balance   = ingresos - egresos;
      const emoji     = entorno === "Personal" ? "🏠" : entorno === "Negocio" ? "💼" : "🏗️";

      resumen += `${emoji} *${entorno}*\n`;
      resumen += `  💰 Ingresos: ${ingresos.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}\n`;
      resumen += `  💸 Egresos:  ${egresos.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}\n`;
      resumen += `  📈 Balance:  ${balance.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}\n\n`;
    }

    resumen += `🌐 Dashboard: ${process.env.DASHBOARD_URL || "Próximamente"}`;
    await bot.sendMessage(msg.chat.id, resumen, { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

// ── /dashboard ───────────────────────────────────────────────
bot.onText(/\/dashboard/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  const url = process.env.DASHBOARD_URL || "Próximamente";
  await bot.sendMessage(msg.chat.id, `🌐 Tu dashboard: ${url}`);
});

// ============================================================
// MENSAJES: TEXTO Y AUDIO
// ============================================================

bot.on("message", async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  if (msg.text?.startsWith("/")) return; // Ya manejado por onText

  const chatId = msg.chat.id;

  try {
    // ── Audio / nota de voz ───────────────────────────────────
    if (msg.voice || msg.audio) {
      const fileId = msg.voice?.file_id || msg.audio?.file_id;
      await bot.sendChatAction(chatId, "typing");
      const texto = await transcribirAudio(fileId);
      console.log(`[Whisper] "${texto}"`);
      await procesarMensaje(chatId, texto, true);
    }

    // ── Texto libre ───────────────────────────────────────────
    else if (msg.text) {
      await bot.sendChatAction(chatId, "typing");
      await procesarMensaje(chatId, msg.text);
    }

  } catch (err) {
    console.error("[ERROR]", err.message);
    await bot.sendMessage(chatId, "❌ Ocurrió un error. Intenta de nuevo.");
  }
});

console.log("🤖 Fernando Bot (Telegram) iniciado...");
