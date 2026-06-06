// ============================================================
// PASO 2: FUNCIÓN procesarGastoConIA(textoTranscribido)
// Stack: Node.js + OpenAI GPT-4o mini
// ============================================================

import OpenAI from "openai";

// ── Inicialización del cliente ──
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Categorías válidas por entorno ──
const CATEGORIAS = {
  "Obra Majalca": [
    "Materiales", "Mano de Obra", "Maquinaria", "Transporte",
    "Herramientas", "Servicios Obra", "Imprevistos Obra"
  ],
  "Negocio": [
    "Servicios Digitales", "Software", "Marketing", "Nómina",
    "Oficina", "Clientes", "Proveedores", "Impuestos", "Imprevistos Negocio"
  ],
  "Personal": [
    "Alimentación", "Transporte Personal", "Salud", "Ropa",
    "Entretenimiento", "Hogar", "Educación", "Imprevistos Personal"
  ]
};

const SYSTEM_PROMPT = `
Eres Fernando, un asistente financiero experto y preciso.
Tu ÚNICA función es analizar una nota de texto (transcripción de voz) y extraer la información de un movimiento financiero.

REGLAS DE CLASIFICACIÓN DE ENTORNO:
- "Obra Majalca": cemento, varilla, chalán, block, flete, terreno, cabaña, Majalca, obra, albañil, hierro, arena, grava, concreto, plomero, electricista (contexto obra).
- "Negocio": cliente, factura, software, oficina, diseño, proyecto, desarrollo, reunión, propuesta, contrato, servidor, dominio, marketing, empleado, nómina.
- "Personal": súper, supermercado, restaurante, comida, ropa, gasolina (uso personal), médico, farmacia, gym, streaming, cine, familia.
- En caso de ambigüedad, prioriza el contexto general de la frase.

REGLAS DE CLASIFICACIÓN DE TIPO:
- "INGRESO": pagaron, entró, recibí, cobré, depósito, transferencia a mí, abono, venta.
- "EGRESO": gasté, pagué, compré, salió, invertí, flete, costo, precio.
- Si no hay señal clara, asume "EGRESO".

REGLAS DE CONVERSIÓN DE MONTO:
- Convierte texto a número: "cuatro mil quinientos" → 4500.
- Si hay moneda explícita, ignórala y solo devuelve el número.
- NUNCA devuelvas 0 o null en monto. Si no identificas el monto, usa -1.

CATEGORÍAS VÁLIDAS POR ENTORNO:
${JSON.stringify(CATEGORIAS, null, 2)}

REGLAS DE RESPUESTA:
- Responde EXCLUSIVAMENTE con un objeto JSON válido. Sin texto adicional, sin markdown.
- El campo "concepto" debe ser una descripción corta (máx 80 caracteres), en español, comenzando con mayúscula.
- El campo "confianza" (0-100) refleja qué tan seguro estás de la clasificación.
- Si el texto no contiene ningún movimiento financiero, devuelve el objeto de error.

ESQUEMA JSON (éxito):
{
  "monto": number,
  "tipo": "INGRESO" | "EGRESO",
  "concepto": string,
  "categoria": string,
  "entorno": "Personal" | "Negocio" | "Obra Majalca",
  "confianza": number,
  "error": null
}

ESQUEMA JSON (sin movimiento financiero):
{
  "monto": null,
  "tipo": null,
  "concepto": null,
  "categoria": null,
  "entorno": null,
  "confianza": 0,
  "error": "NO_TRANSACTION_FOUND"
}
`;

const FEW_SHOT_EXAMPLES = [
  {
    role: "user",
    content: "gasté cuatro mil quinientos pesos en cemento para la obra"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: 4500, tipo: "EGRESO", concepto: "Compra de cemento", categoria: "Materiales", entorno: "Obra Majalca", confianza: 97, error: null })
  },
  {
    role: "user",
    content: "entró el pago del cliente de diseño, doce mil"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: 12000, tipo: "INGRESO", concepto: "Pago cliente diseño", categoria: "Clientes", entorno: "Negocio", confianza: 95, error: null })
  },
  {
    role: "user",
    content: "ochocientos cincuenta en el súper"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: 850, tipo: "EGRESO", concepto: "Compras supermercado", categoria: "Alimentación", entorno: "Personal", confianza: 92, error: null })
  },
  {
    role: "user",
    content: "hola cómo estás, qué buen día"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: null, tipo: null, concepto: null, categoria: null, entorno: null, confianza: 0, error: "NO_TRANSACTION_FOUND" })
  }
];

/**
 * procesarGastoConIA
 * Recibe texto transcrito y devuelve objeto estructurado para Supabase.
 */
export async function procesarGastoConIA(textoTranscribido) {

  if (!textoTranscribido || typeof textoTranscribido !== "string") {
    throw new Error("procesarGastoConIA: textoTranscribido debe ser un string no vacío.");
  }

  const textoLimpio = textoTranscribido.trim();
  if (textoLimpio.length < 3) {
    throw new Error("procesarGastoConIA: texto demasiado corto para procesar.");
  }

  const MAX_REINTENTOS = 2;
  let ultimoError = null;

  for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
    try {
      console.log(`[OpenAI] Intento ${intento} para: "${textoLimpio.substring(0, 60)}"`);

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 512,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...FEW_SHOT_EXAMPLES,
          { role: "user", content: textoLimpio }
        ]
      });

      const rawText = response.choices[0].message.content;

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (parseError) {
        throw new Error(`JSON inválido de OpenAI: ${rawText}`);
      }

      if (parsed.error === "NO_TRANSACTION_FOUND") {
        console.log("[OpenAI] No se detectó transacción financiera.");
        return { success: false, razon: "NO_TRANSACTION_FOUND", textoOriginal: textoLimpio, datos: null };
      }

      const camposRequeridos = ["monto", "tipo", "concepto", "categoria", "entorno"];
      for (const campo of camposRequeridos) {
        if (parsed[campo] === null || parsed[campo] === undefined) {
          throw new Error(`Campo requerido faltante: "${campo}"`);
        }
      }

      if (parsed.monto === -1) {
        throw new Error("OpenAI no pudo identificar el monto.");
      }

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
          fuente:                 "whatsapp"
        }
      };

    } catch (err) {
      ultimoError = err;
      console.warn(`[OpenAI] Error en intento ${intento}: ${err.message}`);
      if (intento < MAX_REINTENTOS) {
        await new Promise(resolve => setTimeout(resolve, intento * 1000));
      }
    }
  }

  throw new Error(`procesarGastoConIA falló tras ${MAX_REINTENTOS} intentos. Último error: ${ultimoError?.message}`);
}
