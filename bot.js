// ============================================================
// FERNANDO BOT — Telegram v2.1
// Múltiples transacciones + CRUD con botones inline
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

const PETER_CHAT_ID = process.env.PETER_CHAT_ID;

// Estado temporal para ediciones en curso
const estadoEdicion = new Map();

// ============================================================
// UTILIDADES
// ============================================================

function esAutorizado(chatId) {
  if (!PETER_CHAT_ID) return true;
  return String(chatId) === String(PETER_CHAT_ID);
}

async function transcribirAudio(fileId) {
  const file    = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const { data: audioData } = await axios.get(fileUrl, { responseType: "arraybuffer" });

  const formData = new FormData();
  formData.append("file", Buffer.from(audioData), { filename: "audio.ogg", contentType: "audio/ogg" });
  formData.append("model", "whisper-1");
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
    .from("transacciones").insert([datos]).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function obtenerRegistro(id) {
  const { data, error } = await supabase
    .from("transacciones").select("*").eq("id", id).single();
  if (error) return null;
  return data;
}

function fmtMonto(n) {
  return parseFloat(n).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

function fmtFecha(iso) {
  return new Date(iso).toLocaleDateString("es-MX", {
    timeZone: "America/Chihuahua",
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit"
  });
}

function entornoEmoji(entorno) {
  return entorno === "Personal" ? "🏠" : entorno === "Negocio" ? "💼" : "🏗️";
}

// ── Mensaje de confirmación con botones CRUD ─────────────────
function mensajeConfirmacion(t) {
  const emoji = t.tipo === "INGRESO" ? "💰" : "💸";
  const signo = t.tipo === "INGRESO" ? "+" : "-";
  const texto =
    `${emoji} *${t.entorno}* ${entornoEmoji(t.entorno)}\n\n` +
    `📝 ${t.concepto}\n` +
    `🏷️ ${t.categoria}\n` +
    `💵 ${signo}${fmtMonto(t.monto)}\n` +
    `📅 ${fmtFecha(t.fecha_transaccion)}\n` +
    `📊 ${t.tipo}\n\n` +
    `_ID: #${t.id}_`;

  const botones = {
    inline_keyboard: [[
      { text: "✏️ Editar", callback_data: `editar:${t.id}` },
      { text: "🗑️ Borrar", callback_data: `borrar:${t.id}` }
    ]]
  };

  return { texto, botones };
}

// ── Mensaje de detalle con botones de edición de campos ──────
function menuEdicion(id) {
  return {
    inline_keyboard: [
      [
        { text: "💵 Monto",    callback_data: `edit_campo:${id}:monto` },
        { text: "📝 Concepto", callback_data: `edit_campo:${id}:concepto` }
      ],
      [
        { text: "🏷️ Categoría", callback_data: `edit_campo:${id}:categoria` },
        { text: "📊 Tipo",      callback_data: `edit_campo:${id}:tipo` }
      ],
      [
        { text: "🏠 Entorno",  callback_data: `edit_campo:${id}:entorno` },
        { text: "📅 Fecha",    callback_data: `edit_campo:${id}:fecha_transaccion` }
      ],
      [{ text: "❌ Cancelar", callback_data: `cancelar:${id}` }]
    ]
  };
}

// ============================================================
// PROCESAMIENTO PRINCIPAL
// ============================================================

async function procesarMensaje(chatId, texto, esAudio = false) {
  const prefijo = esAudio ? `🎙️ _"${texto}"_\n\n` : "";

  const resultado = await procesarGastoConIA(texto);

  if (!resultado.success || !resultado.transacciones.length) {
    await bot.sendMessage(chatId,
      "🤔 No detecté ningún movimiento financiero.\n\n" +
      "Ejemplos:\n• _\"Gasté 800 en cemento\"_\n• _\"Entró pago de cliente 5 mil\"_\n• _\"Ayer pagué 3,200 de varilla\"_",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const { transacciones } = resultado;
  const total = transacciones.length;

  // Si hay múltiples, avisa cuántas detectó
  if (total > 1) {
    await bot.sendMessage(chatId,
      `${prefijo}✅ Detecté *${total} transacciones*. Registrando...`,
      { parse_mode: "Markdown" }
    );
  }

  // Guardar y confirmar cada una
  for (let i = 0; i < transacciones.length; i++) {
    try {
      const guardado = await guardarTransaccion(transacciones[i]);
      const { texto: msg, botones } = mensajeConfirmacion(guardado);

      const encabezado = total > 1 ? `*(${i+1}/${total})* ` : "";
      await bot.sendMessage(chatId, encabezado + (i === 0 ? prefijo : "") + msg, {
        parse_mode: "Markdown",
        reply_markup: botones
      });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error guardando transacción ${i+1}: ${err.message}`);
    }
  }
}

// ============================================================
// CALLBACK QUERIES (botones inline)
// ============================================================

bot.on("callback_query", async (query) => {
  const chatId    = query.message.chat.id;
  const messageId = query.message.message_id;
  const data      = query.data;

  await bot.answerCallbackQuery(query.id);

  // ── Borrar ────────────────────────────────────────────────
  if (data.startsWith("borrar:")) {
    const id = parseInt(data.split(":")[1]);
    const registro = await obtenerRegistro(id);

    if (!registro) {
      await bot.editMessageText(`❌ Registro #${id} no encontrado.`, { chat_id: chatId, message_id: messageId });
      return;
    }

    // Pedir confirmación
    await bot.editMessageReplyMarkup({
      inline_keyboard: [[
        { text: "✅ Sí, borrar", callback_data: `confirmar_borrar:${id}` },
        { text: "❌ Cancelar",   callback_data: `cancelar:${id}` }
      ]]
    }, { chat_id: chatId, message_id: messageId });
  }

  // ── Confirmar borrado ─────────────────────────────────────
  else if (data.startsWith("confirmar_borrar:")) {
    const id = parseInt(data.split(":")[1]);
    const registro = await obtenerRegistro(id);
    const { error } = await supabase.from("transacciones").delete().eq("id", id);

    if (error) {
      await bot.sendMessage(chatId, `❌ Error al borrar: ${error.message}`);
      return;
    }

    await bot.editMessageText(
      `🗑️ *Eliminado #${id}*\n_${registro?.concepto} — ${fmtMonto(registro?.monto)}_`,
      { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
    );
  }

  // ── Editar — mostrar menú de campos ──────────────────────
  else if (data.startsWith("editar:")) {
    const id = parseInt(data.split(":")[1]);
    await bot.editMessageReplyMarkup(
      menuEdicion(id),
      { chat_id: chatId, message_id: messageId }
    );
  }

  // ── Editar campo específico ───────────────────────────────
  else if (data.startsWith("edit_campo:")) {
    const [, id, campo] = data.split(":");
    estadoEdicion.set(chatId, { id: parseInt(id), campo, messageId });

    const etiquetas = {
      monto:             "💵 Nuevo monto (ej: 4500)",
      concepto:          "📝 Nuevo concepto",
      categoria:         "🏷️ Nueva categoría",
      tipo:              "📊 Tipo: escribe INGRESO o EGRESO",
      entorno:           "🏠 Entorno: Personal / Negocio / Obra Majalca",
      fecha_transaccion: "📅 Nueva fecha (ej: 2024-06-03 o 'ayer')"
    };

    await bot.sendMessage(chatId,
      `✏️ *Editando #${id} — ${campo}*\n\n${etiquetas[campo] || "Nuevo valor:"}`,
      { parse_mode: "Markdown" }
    );
  }

  // ── Cancelar ──────────────────────────────────────────────
  else if (data.startsWith("cancelar:")) {
    const id = parseInt(data.split(":")[1]);
    estadoEdicion.delete(chatId);
    const registro = await obtenerRegistro(id);
    if (!registro) return;
    const { texto, botones } = mensajeConfirmacion(registro);
    await bot.editMessageReplyMarkup(botones, { chat_id: chatId, message_id: messageId });
  }
});

// ============================================================
// COMANDOS
// ============================================================

bot.onText(/\/start/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  await bot.sendMessage(msg.chat.id,
    "👋 Hola Peter, soy *Fernando*, tu asistente financiero.\n\n" +
    "Mándame un audio o texto con tus gastos e ingresos — puedes mencionar varios en un solo mensaje.\n\n" +
    "*Comandos:*\n" +
    "/ultimos — Últimos 10 registros\n" +
    "/resumen — Resumen del mes\n" +
    "/dashboard — Tu dashboard web\n" +
    "/ayuda — Ver todos los comandos",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/ayuda/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  await bot.sendMessage(msg.chat.id,
    "*Comandos disponibles:*\n\n" +
    "📋 /ultimos — Últimos 10 registros con botones de edición\n" +
    "📊 /resumen — Resumen financiero del mes\n" +
    "🌐 /dashboard — Link al dashboard web\n\n" +
    "*Para editar o borrar:*\nUsa los botones ✏️ y 🗑️ que aparecen en cada registro.\n\n" +
    "*Para registrar:*\nManda texto o audio. Puedes incluir varias transacciones en un solo mensaje.",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/ultimos/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  try {
    const { data, error } = await supabase
      .from("transacciones")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    if (!data.length) { await bot.sendMessage(msg.chat.id, "📭 Sin registros aún."); return; }

    await bot.sendMessage(msg.chat.id, "📋 *Últimos 10 registros:*", { parse_mode: "Markdown" });

    for (const t of data) {
      const { texto, botones } = mensajeConfirmacion(t);
      await bot.sendMessage(msg.chat.id, texto, { parse_mode: "Markdown", reply_markup: botones });
    }
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

bot.onText(/\/resumen/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  try {
    const inicio = new Date(); inicio.setDate(1); inicio.setHours(0,0,0,0);
    const { data, error } = await supabase
      .from("transacciones").select("tipo, monto, entorno")
      .gte("fecha_transaccion", inicio.toISOString());
    if (error) throw error;

    const mes = new Date().toLocaleDateString("es-MX", { month: "long", year: "numeric" });
    let resumen = `📊 *Resumen ${mes}*\n\n`;

    for (const [entorno, emoji] of [["Personal","🏠"],["Negocio","💼"],["Obra Majalca","🏗️"]]) {
      const reg = data.filter(r => r.entorno === entorno);
      const ing = reg.filter(r => r.tipo === "INGRESO").reduce((s,r) => s + parseFloat(r.monto), 0);
      const egr = reg.filter(r => r.tipo === "EGRESO").reduce((s,r)  => s + parseFloat(r.monto), 0);
      resumen += `${emoji} *${entorno}*\n`;
      resumen += `  💰 ${fmtMonto(ing)}  💸 ${fmtMonto(egr)}\n`;
      resumen += `  Balance: *${fmtMonto(ing - egr)}*\n\n`;
    }

    const totalIng = data.filter(r=>r.tipo==="INGRESO").reduce((s,r)=>s+parseFloat(r.monto),0);
    const totalEgr = data.filter(r=>r.tipo==="EGRESO").reduce((s,r) =>s+parseFloat(r.monto),0);
    resumen += `─────────────────\n`;
    resumen += `💰 Total ingresos: *${fmtMonto(totalIng)}*\n`;
    resumen += `💸 Total egresos:  *${fmtMonto(totalEgr)}*\n`;
    resumen += `📈 Balance global: *${fmtMonto(totalIng - totalEgr)}*`;

    await bot.sendMessage(msg.chat.id, resumen, { parse_mode: "Markdown" });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
  }
});

bot.onText(/\/dashboard/, async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  const url = process.env.DASHBOARD_URL || "Próximamente";
  await bot.sendMessage(msg.chat.id, `🌐 *Tu dashboard:*\n${url}`, { parse_mode: "Markdown" });
});

// ============================================================
// MENSAJES: TEXTO, AUDIO Y EDICIONES EN CURSO
// ============================================================

bot.on("message", async (msg) => {
  if (!esAutorizado(msg.chat.id)) return;
  if (msg.text?.startsWith("/")) return;

  const chatId = msg.chat.id;

  // ── Edición en curso ──────────────────────────────────────
  if (estadoEdicion.has(chatId) && msg.text) {
    const { id, campo } = estadoEdicion.get(chatId);
    estadoEdicion.delete(chatId);

    try {
      let valor = msg.text.trim();

      // Convertir monto a número
      if (campo === "monto") valor = parseFloat(valor.replace(/[^0-9.]/g, ""));

      // Convertir fecha relativa
      if (campo === "fecha_transaccion") {
        const lower = valor.toLowerCase();
        if (lower === "ayer") valor = new Date(Date.now() - 86400000).toISOString();
        else if (lower === "hoy") valor = new Date().toISOString();
        else valor = new Date(valor).toISOString();
      }

      const { error } = await supabase
        .from("transacciones").update({ [campo]: valor }).eq("id", id);
      if (error) throw error;

      const actualizado = await obtenerRegistro(id);
      const { texto, botones } = mensajeConfirmacion(actualizado);
      await bot.sendMessage(chatId,
        `✅ *Actualizado #${id}*\n\n${texto}`,
        { parse_mode: "Markdown", reply_markup: botones }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error al editar: ${err.message}`);
    }
    return;
  }

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

console.log("🤖 Fernando Bot v2.1 (Telegram) iniciado...");
