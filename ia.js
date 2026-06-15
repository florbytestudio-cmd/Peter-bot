// ============================================================
// IA — Clasificación de gastos con GPT-4o mini
// ============================================================

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CATEGORIAS = {
  "Obra Majalca": ["Materiales", "Mano de Obra", "Maquinaria", "Transporte", "Herramientas", "Servicios Obra", "Imprevistos Obra"],
  "Negocio":      ["Servicios Digitales", "Software", "Marketing", "Nómina", "Oficina", "Clientes", "Proveedores", "Impuestos", "Imprevistos Negocio"],
  "Personal":     ["Alimentación", "Transporte Personal", "Salud", "Ropa", "Entretenimiento", "Hogar", "Educación", "Imprevistos Personal"]
};

const SYSTEM_PROMPT = `
Eres Fernando, un asistente financiero experto.
Tu ÚNICA función es analizar texto (transcripción de voz o mensaje escrito) y extraer un movimiento financiero.

ENTORNOS:
- "Obra Majalca": cemento, varilla, chalán, block, flete, terreno, cabaña, Majalca, obra, albañil, hierro, arena, grava, concreto, plomero, electricista (contexto construcción).
- "Negocio": cliente, factura, software, oficina, diseño, proyecto, desarrollo, reunión, contrato, servidor, dominio, marketing, empleado, nómina.
- "Personal": súper, supermercado, restaurante, comida, ropa, gasolina, médico, farmacia, gym, streaming, cine, familia, hijo, hija.

TIPO:
- "INGRESO": pagaron, entró, recibí, cobré, depósito, abono, venta.
- "EGRESO": gasté, pagué, compré, salió, invertí, flete, costo. Si no hay señal clara → "EGRESO".

MONTO: convierte texto a número. "cuatro mil quinientos" → 4500. Sin moneda. Si no identificas → -1.

FECHA:
- Fecha actual: ${new Date().toISOString()} (zona horaria Chihuahua, México UTC-7).
- Si el texto menciona fecha relativa ("ayer", "el lunes", "el 3 de junio", "la semana pasada"), calcúlala y devuélvela en ISO 8601.
- Si no se menciona fecha → null (el sistema usará la fecha actual).

CATEGORÍAS: ${JSON.stringify(CATEGORIAS)}

RESPUESTA: JSON puro, sin markdown, sin explicaciones.

ÉXITO: {"monto":number,"tipo":"INGRESO"|"EGRESO","concepto":string,"categoria":string,"entorno":"Personal"|"Negocio"|"Obra Majalca","fecha_transaccion":string|null,"confianza":number,"error":null}
SIN TRANSACCIÓN: {"monto":null,"tipo":null,"concepto":null,"categoria":null,"entorno":null,"fecha_transaccion":null,"confianza":0,"error":"NO_TRANSACTION_FOUND"}
`;

const EJEMPLOS = [
  { role: "user",      content: "gasté cuatro mil quinientos en cemento para la obra" },
  { role: "assistant", content: JSON.stringify({ monto: 4500, tipo: "EGRESO", concepto: "Compra de cemento", categoria: "Materiales", entorno: "Obra Majalca", fecha_transaccion: null, confianza: 97, error: null }) },
  { role: "user",      content: "entró el pago del cliente de diseño doce mil" },
  { role: "assistant", content: JSON.stringify({ monto: 12000, tipo: "INGRESO", concepto: "Pago cliente diseño", categoria: "Clientes", entorno: "Negocio", fecha_transaccion: null, confianza: 95, error: null }) },
  { role: "user",      content: "ayer pagué tres mil doscientos de varilla que se me olvidó anotar" },
  { role: "assistant", content: JSON.stringify({ monto: 3200, tipo: "EGRESO", concepto: "Compra de varilla", categoria: "Materiales", entorno: "Obra Majalca", fecha_transaccion: new Date(Date.now() - 86400000).toISOString(), confianza: 94, error: null }) },
  { role: "user",      content: "ochocientos en el súper" },
  { role: "assistant", content: JSON.stringify({ monto: 800, tipo: "EGRESO", concepto: "Compras supermercado", categoria: "Alimentación", entorno: "Personal", fecha_transaccion: null, confianza: 92, error: null }) },
  { role: "user",      content: "hola cómo estás" },
  { role: "assistant", content: JSON.stringify({ monto: null, tipo: null, concepto: null, categoria: null, entorno: null, fecha_transaccion: null, confianza: 0, error: "NO_TRANSACTION_FOUND" }) },
];

export async function procesarGastoConIA(texto) {
  const textoLimpio = texto.trim();
  if (!textoLimpio || textoLimpio.length < 3) throw new Error("Texto demasiado corto.");

  for (let intento = 1; intento <= 2; intento++) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...EJEMPLOS,
          { role: "user", content: textoLimpio }
        ]
      });

      const parsed = JSON.parse(response.choices[0].message.content);

      if (parsed.error === "NO_TRANSACTION_FOUND") {
        return { success: false, razon: "NO_TRANSACTION_FOUND", datos: null };
      }

      if (!parsed.monto || parsed.monto === -1) throw new Error("Monto no identificado.");

      return {
        success: true,
        datos: {
          monto:                  parseFloat(parsed.monto),
          tipo:                   parsed.tipo,
          concepto:               parsed.concepto,
          categoria:              parsed.categoria,
          entorno:                parsed.entorno,
          confianza_ia:           parsed.confianza ?? null,
          transcripcion_original: textoLimpio,
          fuente:                 "telegram",
          fecha_transaccion:      parsed.fecha_transaccion || new Date().toISOString()
        }
      };
    } catch (err) {
      if (intento === 2) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
