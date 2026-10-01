// Mini-esquema de parámetros de las herramientas del chat con datos. UNA sola
// fuente de verdad: de aquí se deriva TANTO el JSON Schema que ve el modelo COMO el
// validador estricto que corre en el servidor. El modelo nunca decide nada que no
// esté declarado aquí: claves desconocidas, tipos incorrectos, valores fuera del
// enum o textos largos se RECHAZAN (no se "arreglan" en silencio).

export type ParamSpec =
  | { readonly type: "enum"; readonly values: readonly string[]; readonly description: string; readonly optional?: boolean }
  | { readonly type: "string"; readonly maxLength: number; readonly description: string; readonly optional?: boolean }
  | { readonly type: "date"; readonly description: string; readonly optional?: boolean }
  | { readonly type: "integer"; readonly min: number; readonly max: number; readonly description: string; readonly optional?: boolean };

export type ParamsSpec = Readonly<Record<string, ParamSpec>>;
export type ParsedArgs = Readonly<Record<string, string | number | undefined>>;

export type ParseArgsResult = { readonly ok: true; readonly value: ParsedArgs } | { readonly ok: false; readonly error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `true` solo para fechas de calendario reales (rechaza 2026-02-30). */
export function isRealIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function toJsonSchema(spec: ParamsSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, p] of Object.entries(spec)) {
    if (!p.optional) required.push(key);
    switch (p.type) {
      case "enum":
        properties[key] = { type: "string", enum: [...p.values], description: p.description };
        break;
      case "string":
        properties[key] = { type: "string", maxLength: p.maxLength, description: p.description };
        break;
      case "date":
        properties[key] = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: p.description };
        break;
      case "integer":
        properties[key] = { type: "integer", minimum: p.min, maximum: p.max, description: p.description };
        break;
    }
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** Valida `raw` (JSON ya parseado de lo que mandó el modelo) contra el esquema. */
export function parseArgs(spec: ParamsSpec, raw: unknown): ParseArgsResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "los argumentos deben ser un objeto" };
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) return { ok: false, error: `argumento no permitido: ${key.slice(0, 40)}` };
  }
  const out: Record<string, string | number | undefined> = {};
  for (const [key, p] of Object.entries(spec)) {
    const v = input[key];
    if (v === undefined || v === null || v === "") {
      if (!p.optional) return { ok: false, error: `falta el argumento ${key}` };
      continue;
    }
    switch (p.type) {
      case "enum":
        if (typeof v !== "string" || !p.values.includes(v)) return { ok: false, error: `${key}: valor fuera del catálogo` };
        out[key] = v;
        break;
      case "string":
        if (typeof v !== "string" || v.length > p.maxLength) return { ok: false, error: `${key}: texto inválido o demasiado largo` };
        out[key] = v.trim();
        break;
      case "date":
        if (typeof v !== "string" || !isRealIsoDate(v)) return { ok: false, error: `${key}: se esperaba una fecha real AAAA-MM-DD` };
        out[key] = v;
        break;
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v) || v < p.min || v > p.max) return { ok: false, error: `${key}: entero entre ${p.min} y ${p.max}` };
        out[key] = v;
        break;
    }
  }
  return { ok: true, value: out };
}
