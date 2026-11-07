// Ayudantes de texto compartidos por los módulos portados del cerebro «suelto» (wt-suelto-voz, e69279e):
// texto-final.ts, pedido-aparte.ts y pago.ts. Port literal de normAviso, plegarBusqueda, textosDelCliente,
// esMarcadorSesion y citaDelCliente del núcleo (whatsapp-agent-core.ts, create-order-core.ts, hilo-modelo.ts). Puras.

/**
 * Un mensaje del hilo tal como lo guarda el cerebro suelto (formato OpenAI): texto, llamadas a herramientas y sus
 * resultados, la marca `at` (ISO) y el marcador de sesión. El monorrepo usa { role, content: string }: lo demás es opcional.
 */
export interface MensajeHilo {
  readonly role?: string;
  readonly content?: unknown;
  readonly tool_calls?: ReadonlyArray<{ readonly id?: string; readonly type?: string; readonly function?: { readonly name?: string; readonly arguments?: string } }>;
  readonly tool_call_id?: string;
  readonly at?: string;
  readonly marcador?: string;
}

/** Marcador de sesión nueva del hilo (hilo-modelo.ts). */
export const MARCADOR_SESION = "sesion_nueva";

export function esMarcadorSesion(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { marcador?: unknown }).marcador === MARCADOR_SESION;
}

/**
 * Revisión 41 (P1): «papá» es un familiar, nunca las papas del menú. En el texto plano «papá» (singular, con acento) pasa a
 * «tata» (mismo largo). Revisión 42 (P1): sin acento, solo «mi/tu/su papa» con contexto de persona.
 */
const PAPA_CON_ACENTO_NFD = /\bpapá(?!s)/g;
const PAPA_FAMILIAR_VOZ = new RegExp(
  String.raw`\b(de\s+(?:mi|tu|su|nuestro)\s+)papa\b|\b((?:mi|tu|su|nuestro)\s+)papa\b(?=\s+(?:(?:ya|no|tambien|me|le|nos|les|se|lo|la)\s+){0,3}` +
    String.raw`(?:dice|dijo|decia|quiere|queria|quiso|pidio|pide|pedia|ordeno|encargo|va|iba|viene|vino|llama|llamo|hablo|habla|esta|estaba|anda|necesita|prefiere|paga|pago|cancela|cancelo|recoge|trajo|trae|compro|ceno|comio|hizo|manda|mando|tiene)\b)`,
  "g",
);
function sinPapaFamiliar(plano: string): string {
  return plano.replace(PAPA_FAMILIAR_VOZ, (_w, dueno: string | undefined, pos: string | undefined) => `${dueno ?? pos ?? ""}tata`);
}

/** Texto sin acentos, en minúsculas, con espacios simples y «papá» como familiar (normAviso del núcleo). Pura. */
export function normAviso(t: unknown): string {
  return sinPapaFamiliar(
    String(t ?? "").normalize("NFD").toLowerCase().replace(PAPA_CON_ACENTO_NFD, "tata").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim(),
  );
}

/** Minúsculas y sin acentos (plegarBusqueda de create-order-core). Pura. */
export function plegarBusqueda(texto: string): string {
  return String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Mensajes del cliente de la sesión actual, el más reciente primero (hasta 12). Pura. */
export function textosDelCliente(messages: readonly MensajeHilo[]): string[] {
  const salida: string[] = [];
  for (let i = messages.length - 1; i >= 0 && salida.length < 12; i--) {
    const m = messages[i];
    if (esMarcadorSesion(m)) break;
    if (m?.role === "user" && typeof m.content === "string") salida.push(m.content);
  }
  return salida;
}

/** Sin caracteres de control (salvo el salto de línea). */
function sinControles(t: string): string {
  // eslint-disable-next-line no-control-regex
  return t.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ");
}
/** Corta por puntos de código (nunca parte un emoji). */
function hastaPuntosDeCodigo(t: string, tope: number): string {
  const cp = Array.from(t);
  return cp.length <= tope ? t : cp.slice(0, tope).join("");
}
/** Las palabras del cliente citables en un aviso: sin comillas ni controles, espacios simples, acotadas. Pura. */
export function citaDelCliente(texto: string, tope = 300): string {
  return hastaPuntosDeCodigo(sinControles(String(texto ?? "")).replace(/[«»"“”]/g, "'").replace(/\s+/g, " ").trim(), tope);
}
