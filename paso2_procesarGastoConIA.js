// ============================================================
// PASO 2: FUNCIÓN procesarGastoConIA(textoTranscribido)
// Stack: Node.js + Google Gemini SDK (@google/genai)
// Modelo: gemini-1.5-flash
// ============================================================

import { GoogleGenerativeAI } from "@google/genai";

// ── Inicialización del cliente (una sola instancia, reutilizable) ──
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Categorías válidas por entorno (sirven como guía al modelo) ──
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

// ── Prompt de sistema: define toda la lógica de negocio para Gemini ──
const SYSTEM_PROMPT = `
Eres Fernando, un asistente financiero experto y preciso.
Tu ÚNICA función es analizar una nota de texto (transcripción de voz) y extraer la información de un movimiento financiero.

REGLAS DE CLASIFICACIÓN DE ENTORNO:
- "Obra Majalca": cemento, varilla, chalán, block, flete, terreno, cabaña, Majalca, obra, albañil, hierro, arena, grava, concreto, plomero, electricista (contexto obra).
- "Negocio": cliente, factura, software, oficina, diseño, proyecto, desarrollo, reunión, propuesta, contrato, servidor, dominio, marketing, empleado, nómina.
- "Personal": súper, supermercado, restaurante, comida, ropa, gasolina (uso personal), médico, farmacia, gym, streaming, cine, familia.
- En caso de ambigüedad (ej: "gasolina"), prioriza el contexto general de la frase para decidir.

REGLAS DE CLASIFICACIÓN DE TIPO:
- "INGRESO": pagaron, entró, recibí, cobré, depósito, transferencia a mí, abono, venta.
- "EGRESO": gasté, pagué, compré, salió, invertí, flete, costo, precio.
- Si no hay señal clara, asume "EGRESO" (la mayoría de registros serán gastos).

REGLAS DE CONVERSIÓN DE MONTO:
- Convierte texto a número: "cuatro mil quinientos" → 4500, "mil doscientos cincuenta" → 1250.50 si aplica.
- Si hay moneda explícita (pesos, dólares), ignórala y solo devuelve el número.
- NUNCA devuelvas 0 o null en monto. Si no identificas el monto, usa -1 como señal de error.

CATEGORÍAS VÁLIDAS POR ENTORNO:
${JSON.stringify(CATEGORIAS, null, 2)}

REGLAS DE RESPUESTA:
- Responde EXCLUSIVAMENTE con un objeto JSON válido. Sin texto adicional, sin markdown, sin explicaciones.
- El campo "concepto" debe ser una descripción corta y limpia (máx 80 caracteres), en español, comenzando con mayúscula.
- El campo "confianza" (0-100) refleja qué tan seguro estás de la clasificación completa.
- Si el texto no contiene ningún movimiento financiero identificable, devuelve el objeto de error definido abajo.

ESQUEMA JSON DE RESPUESTA (éxito):
{
  "monto": number,
  "tipo": "INGRESO" | "EGRESO",
  "concepto": string,
  "categoria": string,
  "entorno": "Personal" | "Negocio" | "Obra Majalca",
  "confianza": number,
  "error": null
}

ESQUEMA JSON DE RESPUESTA (sin movimiento financiero detectado):
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

// ── Ejemplos few-shot: anclan el comportamiento del modelo ──
const FEW_SHOT_EXAMPLES = [
  {
    input:  "gasté cuatro mil quinientos pesos en cemento para la obra",
    output: { monto: 4500, tipo: "EGRESO", concepto: "Compra de cemento", categoria: "Materiales", entorno: "Obra Majalca", confianza: 97, error: null }
  },
  {
    input:  "entró el pago del cliente de diseño, doce mil",
    output: { monto: 12000, tipo: "INGRESO", concepto: "Pago cliente diseño", categoria: "Clientes", entorno: "Negocio", confianza: 95, error: null }
  },
  {
    input:  "ochocientos cincuenta en el súper",
    output: { monto: 850, tipo: "EGRESO", concepto: "Compras supermercado", categoria: "Alimentación", entorno: "Personal", confianza: 92, error: null }
  },
  {
    input:  "pagué tres mil doscientos de flete para llevar la varilla",
    output: { monto: 3200, tipo: "EGRESO", concepto: "Flete de varilla", categoria: "Transporte", entorno: "Obra Majalca", confianza: 98, error: null }
  },
  {
    input:  "hola cómo estás, qué bueno día hace hoy",
    output: { monto: null, tipo: null, concepto: null, categoria: null, entorno: null, confianza: 0, error: "NO_TRANSACTION_FOUND" }
  }
];

/**
 * Construye el historial de conversación few-shot para el modelo.
 * Gemini espera roles alternados: user → model → user → model...
 */
function buildFewShotHistory() {
  const history = [];
  for (const example of FEW_SHOT_EXAMPLES) {
    history.push({
      role: "user",
      parts: [{ text: example.input }]
    });
    history.push({
      role: "model",
      parts: [{ text: JSON.stringify(example.output) }]
    });
  }
  return history;
}

/**
 * procesarGastoConIA
 *
 * Recibe el texto transcrito por Whisper y devuelve un objeto
 * estructurado listo para insertar en Supabase.
 *
 * @param {string} textoTranscribido - Texto en español, crudo de Whisper.
 * @returns {Promise<Object>} Objeto con los campos de la transacción + metadatos.
 * @throws {Error} Si la API falla o devuelve JSON inválido tras reintentos.
 */
export async function procesarGastoConIA(textoTranscribido) {

  // ── Validación de entrada ──
  if (!textoTranscribido || typeof textoTranscribido !== "string") {
    throw new Error("procesarGastoConIA: textoTranscribido debe ser un string no vacío.");
  }

  const textoLimpio = textoTranscribido.trim();
  if (textoLimpio.length < 3) {
    throw new Error("procesarGastoConIA: texto demasiado corto para procesar.");
  }

  // ── Configuración del modelo ──
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",  // Fuerza JSON nativo en la respuesta
      temperature: 0.1,      // Baja temperatura = respuestas deterministas y consistentes
      topP: 0.8,
      maxOutputTokens: 512,  // Una transacción no necesita más
    }
  });

  // ── Chat con historial few-shot precargado ──
  const chat = model.startChat({
    history: buildFewShotHistory()
  });

  // ── Lógica de reintento (máx 2 intentos) ──
  const MAX_REINTENTOS = 2;
  let ultimoError = null;

  for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
    try {

      console.log(`[Gemini] Intento ${intento} para: "${textoLimpio.substring(0, 60)}..."`);

      const result = await chat.sendMessage(textoLimpio);
      const rawText = result.response.text();

      // ── Parseo defensivo del JSON ──
      let parsed;
      try {
        // Limpia posibles bloques markdown residuales (por si acaso)
        const jsonString = rawText.replace(/```json|```/g, "").trim();
        parsed = JSON.parse(jsonString);
      } catch (parseError) {
        throw new Error(`JSON inválido recibido de Gemini: ${rawText}`);
      }

      // ── Validación de campos obligatorios ──
      if (parsed.error === "NO_TRANSACTION_FOUND") {
        console.log("[Gemini] No se detectó transacción financiera en el texto.");
        return {
          success: false,
          razon: "NO_TRANSACTION_FOUND",
          textoOriginal: textoLimpio,
          datos: null
        };
      }

      const camposRequeridos = ["monto", "tipo", "concepto", "categoria", "entorno"];
      for (const campo of camposRequeridos) {
        if (parsed[campo] === null || parsed[campo] === undefined) {
          throw new Error(`Campo requerido faltante: "${campo}" en respuesta de Gemini.`);
        }
      }

      if (parsed.monto === -1) {
        throw new Error("Gemini no pudo identificar el monto en el texto.");
      }

      // ── Resultado limpio y enriquecido ──
      return {
        success: true,
        datos: {
          monto:                   parseFloat(parsed.monto),
          tipo:                    parsed.tipo,
          concepto:                parsed.concepto,
          categoria:               parsed.categoria,
          entorno:                 parsed.entorno,
          confianza_ia:            parsed.confianza ?? null,
          transcripcion_original:  textoLimpio,
          fuente:                  "whatsapp"
        }
      };

    } catch (err) {
      ultimoError = err;
      console.warn(`[Gemini] Error en intento ${intento}: ${err.message}`);

      if (intento < MAX_REINTENTOS) {
        // Espera exponencial: 1s, 2s...
        await new Promise(resolve => setTimeout(resolve, intento * 1000));
      }
    }
  }

  // Si llegamos aquí, ambos intentos fallaron
  throw new Error(`procesarGastoConIA falló tras ${MAX_REINTENTOS} intentos. Último error: ${ultimoError?.message}`);
}


// ============================================================
// BLOQUE DE PRUEBA (solo en desarrollo)
// Ejecutar: node paso2_procesarGastoConIA.js
// ============================================================

if (process.env.NODE_ENV === "development") {

  const casosDePrueba = [
    "gasté cuatro mil quinientos pesos en cemento para la obra majalca",
    "entró el pago del cliente, doce mil por el proyecto de software",
    "compré ropa para los chamacos, dos mil trescientos en liverpool",
    "pagué al chalán tres días de trabajo, mil ochocientos",
    "buen día, ¿cómo estás?",  // Caso sin transacción
  ];

  console.log("=== PRUEBAS procesarGastoConIA ===\n");

  for (const texto of casosDePrueba) {
    console.log(`INPUT: "${texto}"`);
    try {
      const resultado = await procesarGastoConIA(texto);
      console.log("OUTPUT:", JSON.stringify(resultado, null, 2));
    } catch (error) {
      console.error("ERROR:", error.message);
    }
    console.log("─".repeat(60));
  }
}
