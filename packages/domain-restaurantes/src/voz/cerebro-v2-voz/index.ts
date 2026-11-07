// Turno de VOZ del cerebro v2 (subruta `@atiende/domain-restaurantes/voz-turno`). Ruta HTTP: apps/api/src/routes/verticals/restaurantes/voz-turno.ts.
//
// HUECOS_CANAL_VOZ (conocidos; requieren editar `createLlmWhatsAppTurnHandler`, fuera del alcance de este modulo):
//  1. Las herramientas corren con `channel: "whatsapp"` (registro de herramientas de WhatsApp): reglas solo-WhatsApp del registro siguen activas
//     (p. ej. pedir el pin antes de crear un domicilio descrito solo con referencias visuales). El adaptador corrige el ORIGEN del pedido
//     (`source: "voice"`) y la llave del flujo (`call:<id>`), no el canal de las herramientas. Arreglo: opcion `canal?: "whatsapp" | "voz"` en el handler.
//  2. Modelo de voz: hoy el preciso (Luna) por omision. El rapido (Gemini 3.5 Flash-Lite, ya registrado como alternativa ZDR) entra con
//     VOZ_TURNO_MODELO=rapido (ver `modeloDeVoz`): se pasa como modelo elegido del turno via `leerAjustes`, y el handler ya pone Haiku 5.5 de alterno.
export * from "./texto.ts";
export * from "./hilos.ts";
export * from "./turno.ts";
export * from "./adaptadores.ts";
export { modeloDeVoz } from "./modelo.ts";
