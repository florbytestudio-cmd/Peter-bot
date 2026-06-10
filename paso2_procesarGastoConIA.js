// ============================================================
// PASO 2: FUNCIÓN procesarGastoConIA(textoTranscribido)
// Stack: Node.js + OpenAI GPT-4o mini
// ============================================================

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
- "Obra Majalca": cemento, varilla, chalán, block, flete, terreno, cabaña, Majalca, obra, albañil, hierro, arena, grava, concreto, plomero, electricista.
- "Negocio": cliente, factura, software, oficina, diseño, proyecto, desarrollo, reunión, contrato, servidor, dominio, marketing, empleado, nómina.
- "Personal": súper, supermercado, restaurante, comida, ropa, gasolina, médico, farmacia, gym, streaming, cine, familia.

REGLAS DE CLASIFICACIÓN DE TIPO:
- "INGRESO": pagaron, entró, recibí, cobré, depósito, abono, venta.
- "EGRESO": gasté, pagué, compré, salió, invertí, flete, costo, precio.
- Si no hay señal clara, asume "EGRESO".

REGLAS DE CONVERSIÓN DE MONTO:
- Convierte texto a número: "cuatro mil quinientos" → 4500.
- Ignora la moneda, solo devuelve el número.
- Si no identificas el monto, usa -1.

REGLAS DE FECHA:
- Si el texto menciona una fecha o día específico (ej: "el lunes", "ayer", "el 3 de junio", "la semana pasada"), extráela y devuélvela en formato ISO 8601 (YYYY-MM-DDTHH:mm:ssZ) en el campo "fecha_transaccion".
- La fecha actual es: ${new Date().toISOString()}. Úsala como referencia para calcular fechas relativas.
- Si NO se menciona ninguna fecha, devuelve null en "fecha_transaccion" para usar la fecha actual del sistema.

CATEGORÍAS VÁLIDAS:
${JSON.stringify(CATEGORIAS, null, 2)}

REGLAS DE RESPUESTA:
- Responde EXCLUSIVAMENTE con JSON válido. Sin texto adicional ni markdown.
- El campo "concepto" debe ser una descripción corta (máx 80 chars), en español, con mayúscula inicial.
- El campo "confianza" (0-100) refleja tu seguridad en la clasificación.
- Si el texto no contiene ningún movimiento financiero, devuelve el objeto de error.

ESQUEMA JSON (éxito):
{
  "monto": number,
  "tipo": "INGRESO" | "EGRESO",
  "concepto": string,
  "categoria": string,
  "entorno": "Personal" | "Negocio" | "Obra Majalca",
  "fecha_transaccion": string | null,
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
  "fecha_transaccion": null,
  "confianza": 0,
  "error": "NO_TRANSACTION_FOUND"
}
`;

const FEW_SHOT_EXAMPLES = [
  {
    role: "user",
    content: "gasté cuatro mil quinientos pesos en cemento para la obra el lunes"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: 4500, tipo: "EGRESO", concepto: "Compra de cemento", categoria: "Materiales", entorno: "Obra Majalca", fecha_transaccion: null, confianza: 97, error: null })
  },
  {
    role: "user",
    content: "entró el pago del cliente de diseño, doce mil"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: 12000, tipo: "INGRESO", concepto: "Pago cliente diseño", categoria: "Clientes", entorno: "Negocio", fecha_transaccion: null, confianza: 95, error: null })
  },
  {
    role: "user",
    content: "ayer pagué tres mil de varilla que se me olvidó registrar"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: 3000, tipo: "EGRESO", concepto: "Compra de varilla", categoria: "Materiales", entorno: "Obra Majalca", fecha_transaccion: "2026-06-08T12:00:00Z", confianza: 93, error: null })
  },
  {
    role: "user",
    content: "hola cómo estás"
  },
  {
    role: "assistant",
    content: JSON.stringify({ monto: null, tipo: null, concepto: null, categoria: null, entorno: null, fecha_transaccion: null, confianza: 0, error: "NO_TRANSACTION_FOUND" })
  }
];

export async function procesarGastoConIA(textoTranscribido) {

  if (!textoTranscribido || typeof textoTranscribido !== "string") {
    throw new Error("procesarGastoConIA: textoTranscribido debe ser un string no vacío.");
  }

  const textoLimpio = textoTranscribido.trim();
  if (textoLimpio.length < 3) {
    throw new Error("procesarGastoConIA: texto demasiado corto.");
  }

  const MAX_REINTENTOS = 2;
  let ultimoError = null;

  for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
    try {
      console.log(`[OpenAI] Intento ${intento}: "${textoLimpio.substring(0, 60)}"`);

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

      const parsed = JSON.parse(response.choices[0].message.content);

      if (parsed.error === "NO_TRANSACTION_FOUND") {
        return { success: false, razon: "NO_TRANSACTION_FOUND", textoOriginal: textoLimpio, datos: null };
      }

      const camposRequeridos = ["monto", "tipo", "concepto", "categoria", "entorno"];
      for (const campo of camposRequeridos) {
        if (parsed[campo] === null || parsed[campo] === undefined) {
          throw new Error(`Campo faltante: "${campo}"`);
        }
      }

      if (parsed.monto === -1) throw new Error("No se pudo identificar el monto.");

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
          fuente:                 "whatsapp",
          // Si la IA extrajo fecha del texto, úsala. Si no, usa NOW() de Supabase.
          fecha_transaccion:      parsed.fecha_transaccion || new Date().toISOString()
        }
      };

    } catch (err) {
      ultimoError = err;
      console.warn(`[OpenAI] Error intento ${intento}: ${err.message}`);
      if (intento < MAX_REINTENTOS) {
        await new Promise(r => setTimeout(r, intento * 1000));
      }
    }
  }

  throw new Error(`procesarGastoConIA falló: ${ultimoError?.message}`);
}
