// Fecha corta real para la píldora de `DashboardHeader` ("16 sept 2026") -- una
// sola función compartida por los 7 Shells en vez de que cada uno arme su
// propio `toLocaleDateString` (mismo criterio de "un solo lugar" que
// `useNotifications.ts`). `DashboardHeader` en sí NO formatea fechas a
// propósito (ver su comentario de cabecera) -- esto vive aquí, no ahí.
export function fechaCortaEsMx(fecha: Date = new Date()): string {
  return fecha.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}
