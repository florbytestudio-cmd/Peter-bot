// ============================================================
// IA — Clasificación MÚLTIPLE de gastos con GPT-4o mini
// ============================================================

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CATEGORIAS = {
  "Obra Majalca": {
    "EGRESO":  ["Materiales", "Mano de Obra", "Maquinaria", "Transporte", "Herramientas", "Servicios Obra", "Imprevistos Obra"],
    "INGRESO": ["Venta", "Préstamo", "Inversión", "Anticipo", "Otro Ingreso Obra"]
  },
  "Negocio": {
    "EGRESO":  ["Servicios Digitales", "Software", "Marketing", "Nómina", "Oficina", "Proveedores", "Impuestos", "Imprevistos Negocio"],
    "INGRESO": ["Pago de Cliente", "Anticipo", "Venta", "Préstamo", "Otro Ingreso Negocio"]
  },
  "Personal": {
    "EGRESO":  ["Alimentación", "Transporte Personal", "Salud", "Ropa", "Entretenimiento", "Hogar", "Educación", "Imprevistos Personal"],
    "INGRESO": ["Salario", "Transferencia", "Venta Personal", "Préstamo Recibido", "Otro Ingreso Personal"]
  }
};

const SYSTEM_PROMPT = `
Eres Fernando, un asistente financiero experto.
Tu función es analizar texto (puede ser una transcripción de voz o mensaje escrito) y extraer TODOS los movimientos financieros mencionados.

IMPORTANTE: Un solo mensaje puede contener MÚLTIPLES transacciones. Debes detectarlas TODAS.
Ejemplo: "Gasté 300 en cemento y también compré tijeras para el negocio en 20 pesos" → 2 transacciones.

ENTORNOS:
- "Obra Majalca": cemento, varilla, chalán, block, flete, terreno, cabaña, Majalca, obra, albañil, hierro, arena, grava, concreto, plomero, electricista.
- "Negocio": cliente, factura, software, oficina, diseño, proyecto, desarrollo, reunión, contrato, servidor, dominio, marketing, empleado, nómina, tijeras (contexto negocio).
- "Personal": súper, supermercado, restaurante, comida, ropa, gasolina, médico, farmacia, gym, streaming, cine, familia.

TIPO:
- "INGRESO": pagaron, entró, recibí, cobré, depósito, abono, venta.
- "EGRESO": gasté, pagué, compré, salió, invertí, flete, costo. Sin señal clara → "EGRESO".

MONTO: convierte texto a número. "cuatro mil quinientos" → 4500. Sin moneda. Sin monto identificable → -1.

FECHA:
- Fecha actual: ${new Date().toISOString()} (UTC-7 Chihuahua, México).
- Si se menciona fecha relativa ("ayer", "el lunes", "el 3 de junio") → calcúlala en ISO 8601.
- Sin fecha mencionada → null.

CATEGORÍAS POR ENTORNO Y TIPO:
${JSON.stringify(CATEGORIAS)}

REGLA CRÍTICA DE CATEGORÍA:
- Los INGRESOS NUNCA van a categorías como "Imprevistos", "Materiales", "Alimentación" etc.
- Para INGRESO usa SIEMPRE las categorías de la sección INGRESO del entorno correspondiente.
- Para EGRESO usa SIEMPRE las categorías de la sección EGRESO del entorno correspondiente.

RESPUESTA: JSON puro, sin markdown. Siempre un array "transacciones".

FORMATO:
{
  "transacciones": [
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
  ]
}

Si NO hay ninguna transacción en el texto:
{
  "transacciones": []
}
`;

const EJEMPLOS = [
  {
    role: "user",
    content: "gasté cuatro mil quinientos en cemento para la obra y también pagué ochocientos de súper"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      transacciones: [
        { monto: 4500, tipo: "EGRESO", concepto: "Compra de cemento", categoria: "Materiales", entorno: "Obra Majalca", fecha_transaccion: null, confianza: 97, error: null },
        { monto: 800,  tipo: "EGRESO", concepto: "Compras supermercado", categoria: "Alimentación", entorno: "Personal", fecha_transaccion: null, confianza: 93, error: null }
      ]
    })
  },
  {
    role: "user",
    content: "entró el pago del cliente de diseño doce mil"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      transacciones: [
        { monto: 12000, tipo: "INGRESO", concepto: "Pago cliente diseño", categoria: "Clientes", entorno: "Negocio", fecha_transaccion: null, confianza: 95, error: null }
      ]
    })
  },
  {
    role: "user",
    content: "ayer pagué tres mil de varilla, hoy compré tijeras para la oficina en 20 pesos y también entró un pago de cliente de cinco mil"
  },
  {
    role: "assistant",
    content: JSON.stringify({
      transacciones: [
        { monto: 3000,  tipo: "EGRESO",  concepto: "Compra de varilla",    categoria: "Materiales",        entorno: "Obra Majalca", fecha_transaccion: new Date(Date.now() - 86400000).toISOString(), confianza: 94, error: null },
        { monto: 20,    tipo: "EGRESO",  concepto: "Tijeras para oficina",  categoria: "Oficina",           entorno: "Negocio",      fecha_transaccion: null, confianza: 91, error: null },
        { monto: 5000,  tipo: "INGRESO", concepto: "Pago de cliente",       categoria: "Clientes",          entorno: "Negocio",      fecha_transaccion: null, confianza: 93, error: null }
      ]
    })
  },
  {
    role: "user",
    content: "hola cómo estás"
  },
  {
    role: "assistant",
    content: JSON.stringify({ transacciones: [] })
  }
];

export async function procesarGastoConIA(texto) {
  const textoLimpio = texto.trim();
  if (!textoLimpio || textoLimpio.length < 3) throw new Error("Texto demasiado corto.");

  for (let intento = 1; intento <= 2; intento++) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.1,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...EJEMPLOS,
          { role: "user", content: textoLimpio }
        ]
      });

      const parsed = JSON.parse(response.choices[0].message.content);
      const transacciones = parsed.transacciones || [];

      if (!transacciones.length) {
        return { success: false, transacciones: [] };
      }

      // Filtrar y limpiar cada transacción
      const validas = transacciones
        .filter(t => t.monto && t.monto !== -1 && t.tipo && t.entorno)
        .map(t => ({
          monto:                  parseFloat(t.monto),
          tipo:                   t.tipo,
          concepto:               t.concepto,
          categoria:              t.categoria,
          entorno:                t.entorno,
          confianza_ia:           t.confianza ?? null,
          transcripcion_original: textoLimpio,
          fuente:                 "telegram",
          fecha_transaccion:      t.fecha_transaccion || new Date().toISOString()
        }));

      return { success: validas.length > 0, transacciones: validas };

    } catch (err) {
      if (intento === 2) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
