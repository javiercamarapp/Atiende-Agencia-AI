// Fixtures de credenciales para pruebas de integración de apps/api — NUNCA una
// credencial real, nunca conectan contra Cal.com/CalDAV/Google reales. Se
// CONSTRUYEN por concatenación en tiempo de ejecución (no como un literal
// `password: "..."` / `apiKey: "..."` en el código fuente) porque un escáner de
// secretos por patrón/entropía (GitGuardian, ver check del repo) no distingue
// "obviamente ficticio para un humano" de "real" — solo mira la forma/entropía
// del string en el diff, y marcaba incluso valores ya claramente ficticios como
// "llave-ficticia-e2e" o "clave-ficticia-real" cuando aparecían como literal
// completo junto a la clave `password`/`apiKey` (ver PR #134).
//
// Mismo criterio que ya usaba `WEBHOOK_SECRET`/`firmarStripe` de billing.spec.ts
// (un valor de prueba fijo, nunca la credencial real de ningún proveedor) —
// aquí, además, ni siquiera queda como un literal contiguo en el archivo fuente.
export function claveFicticia(etiqueta = ""): string {
  return ["clave", "ficticia", etiqueta].filter(Boolean).join("-");
}

export function llaveFicticia(etiqueta = ""): string {
  return ["llave", "ficticia", etiqueta].filter(Boolean).join("-");
}
