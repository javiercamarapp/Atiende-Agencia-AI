// Matriz de acceso por rol de TODAS las rutas de staff de despachos (`/despachos/:propertyId/*` y `/v1/despachos/*`) (D-15).
//
// Es la "verdad de diseno" contra la que `despachos-guardas-rutas.spec.ts` contrasta la API real. Esta escrita A MANO y sin
// importar las constantes de roles del dominio: si alguien ensancha un rol en `roles.ts` por accidente, la prueba lo detecta.
//
// - `TODOS`: los 4 roles (admin, contador, auditor, readonly) pasan: lecturas de lo ya persistido y calculadoras puras.
// - `ESCRIBE`: solo admin y contador (separacion de funciones: auditor y readonly nunca escriben).
// - `SOLO_ADMIN`: acciones de alto impacto (cerrar periodo, configuracion, gestion de staff).
// - `ADMIN_Y_AUDITOR`: bitacora de acceso (D-38).
//
// Clave de ruta: "METODO /ruta" relativa a `/despachos/:propertyId`; las rutas de nivel organizacion se escriben con su ruta completa
// ("GET /v1/despachos/:orgSlug/...").
//
// REGLA: toda ruta nueva se declara aqui EN EL MISMO PR. El spec falla si una ruta existe y no esta declarada (o al reves). Leccion real
// del 1-oct: #302 rompio main por no hacerlo (ver packages/domain-despachos/README.md).
import type { DespachosRole } from "@atiende/domain-despachos";

export type AccesoRuta = readonly DespachosRole[];

export const TODOS: AccesoRuta = ["admin", "contador", "auditor", "readonly"];
export const ESCRIBE: AccesoRuta = ["admin", "contador"];
export const SOLO_ADMIN: AccesoRuta = ["admin"];
export const ADMIN_Y_AUDITOR: AccesoRuta = ["admin", "auditor"];

/** POST que solo CALCULAN o validan (no persisten nada): por eso los puede usar cualquier rol de lectura. Todo otro POST/PUT/PATCH/DELETE excluye auditor y readonly. */
export const POST_DE_SOLO_CALCULO: readonly string[] = [
  "POST /cfdi/rep/analizar",
  "POST /cierre-mensual/validaciones/balance",
  "POST /cierre-mensual/validaciones/polizas",
  "POST /cierre-mensual/validaciones/nomina",
  "POST /cierre-mensual/validaciones/iva",
  "POST /cierre-mensual/validaciones/isr",
  "POST /cierre-mensual/validaciones/bancos",
  "POST /pagos-provisionales/:periodo/calcular",
  "POST /chat-datos",
  "POST /chat-datos/adjuntos", // Adjuntar archivo: analiza CSV/Excel/PDF en el servidor y no guarda nada (solo su fila de bitacora)
];

/** Escrituras que solo tocan el historial PERSONAL del usuario en "Chatea con tus datos" (sus conversaciones, fijados y reportes): no cambian datos del despacho, asi que cualquier rol que pueda ver el dashboard las usa. */
export const ESCRITURAS_PERSONALES_DEL_CHAT: readonly string[] = [
  "PATCH /chat-datos/conversaciones/:conversationId",
  "DELETE /chat-datos/conversaciones/:conversationId",
  "POST /chat-datos/pins",
  "PATCH /chat-datos/pins/:pinId",
  "DELETE /chat-datos/pins/:pinId",
  "POST /chat-datos/conversaciones/:conversationId/reporte",
];

/** Rutas que, ademas del rol, exigen un segundo factor reciente (D-30, x-step-up-token, alcance despachos_sensitive). */
export const RUTAS_CON_STEP_UP: readonly string[] = [
  "POST /cierre-mensual/periodos/:periodoId/cerrar",
  "POST /portal-cliente/enlaces",
  "POST /portal-cliente/enlaces/:enlaceId/revocar",
  "POST /contabilidad-electronica/paquete",
  "GET /libro/contabilidad-electronica",
  "POST /admin/staff/invitaciones",
  "DELETE /admin/staff/invitaciones/:inviteId",
  "PATCH /admin/staff/miembros/:userId",
];

export const MATRIZ_GUARDAS: Readonly<Record<string, AccesoRuta>> = {
  // admin-staff.ts
  "POST /admin/staff/invitaciones": SOLO_ADMIN,
  "GET /admin/staff/invitaciones": SOLO_ADMIN,
  "DELETE /admin/staff/invitaciones/:inviteId": SOLO_ADMIN,
  "GET /admin/staff/miembros": SOLO_ADMIN,
  "PATCH /admin/staff/miembros/:userId": SOLO_ADMIN,
  // bookkeeping.ts
  "GET /bookkeeping/catalogo": TODOS,
  "POST /bookkeeping/clasificar": ESCRIBE,
  "POST /bookkeeping/poliza": ESCRIBE,
  "POST /bookkeeping/ajuste": ESCRIBE,
  "POST /bookkeeping/overrides/sugerencias": ESCRIBE,
  // cartera.ts
  "GET /cartera/ficha": TODOS,
  "PUT /cartera/ficha": ESCRIBE,
  // cfdi-estatus-sat.ts
  "POST /cfdi/:invoiceId/verificar-estatus-sat": ESCRIBE,
  // cfdi.ts
  "POST /cfdi": ESCRIBE,
  "POST /cfdi/importar-xml": ESCRIBE,
  // cfdi-lote.ts (D-13)
  "POST /cfdi/importar-lote": ESCRIBE,
  "POST /cfdi/rep/analizar": TODOS,
  "GET /cfdi/:invoiceId": TODOS,
  "PUT /cfdi/:invoiceId/estado-sat": ESCRIBE,
  "GET /cfdi": TODOS,
  // cierre-mensual.ts
  "POST /cierre-mensual/periodos": ESCRIBE,
  "GET /cierre-mensual/periodos": TODOS,
  "GET /cierre-mensual/periodos/:periodoId": TODOS,
  "POST /cierre-mensual/periodos/:periodoId/tareas/:tareaId/completar": ESCRIBE,
  "POST /cierre-mensual/periodos/:periodoId/auto-check": ESCRIBE,
  "POST /cierre-mensual/periodos/:periodoId/cerrar": SOLO_ADMIN,
  "GET /cierre-mensual/periodos/:periodoId/reporte": TODOS,
  "POST /cierre-mensual/validaciones/balance": TODOS,
  "POST /cierre-mensual/validaciones/polizas": TODOS,
  "POST /cierre-mensual/validaciones/nomina": TODOS,
  "POST /cierre-mensual/validaciones/iva": TODOS,
  "POST /cierre-mensual/validaciones/isr": TODOS,
  "POST /cierre-mensual/validaciones/bancos": TODOS,
  // cobranza.ts
  "GET /cobranza/cuentas": TODOS,
  "GET /cobranza/resumen": TODOS,
  "POST /cobranza/cuentas": ESCRIBE,
  "GET /cobranza/cuentas/:receivableId": TODOS,
  "GET /cobranza/cuentas/:receivableId/eventos": TODOS,
  "POST /cobranza/cuentas/:receivableId/pagar": ESCRIBE,
  "POST /cobranza/cuentas/:receivableId/recordatorio": ESCRIBE,
  // cola-cobranza.ts
  "GET /cola-cobranza/gestiones": TODOS,
  "POST /cola-cobranza/gestiones": ESCRIBE,
  "POST /cola-cobranza/gestiones/:gestionId/estado": ESCRIBE,
  "GET /cola-cobranza/cola": TODOS,
  "GET /cola-cobranza/reporte-cartera": TODOS,
  "GET /cola-cobranza/whatsapp/consentimientos": TODOS,
  "POST /cola-cobranza/whatsapp/consentimientos": ESCRIBE,
  "POST /cola-cobranza/cuentas/:receivableId/whatsapp": ESCRIBE,
  "GET /cola-cobranza/whatsapp/outbox": TODOS,
  // conciliacion-persistida.ts
  "POST /conciliacion/sesiones": ESCRIBE,
  "GET /conciliacion/sesiones": TODOS,
  "GET /conciliacion/sesiones/:id": TODOS,
  "POST /conciliacion/sesiones/:id/confirmar": ESCRIBE,
  "POST /conciliacion/sesiones/:id/cerrar": ESCRIBE,
  "POST /conciliacion/matches/:matchId/deshacer": ESCRIBE,
  "POST /conciliacion/sesiones/:id/sugerencias-llm": ESCRIBE,
  "POST /conciliacion/sugerencias/:id/aprobar": ESCRIBE,
  "POST /conciliacion/sugerencias/:id/rechazar": ESCRIBE,
  // conciliacion.ts
  "POST /conciliacion/matching": ESCRIBE,
  "POST /conciliacion/importar-estado-de-cuenta": ESCRIBE,
  "POST /conciliacion/importar-estado-de-cuenta/guardar": ESCRIBE,
  "POST /conciliacion/alertas": ESCRIBE,
  "POST /conciliacion/clasificar-deposito": ESCRIBE,
  "POST /conciliacion/verificar-spei": ESCRIBE,
  // configuracion.ts
  "GET /configuracion": TODOS,
  "PATCH /configuracion": SOLO_ADMIN,
  // contabilidad-electronica.ts
  "GET /contabilidad-electronica/catalogo-base": TODOS,
  "POST /contabilidad-electronica/catalogo": ESCRIBE,
  "POST /contabilidad-electronica/balanza": ESCRIBE,
  "POST /contabilidad-electronica/paquete": ESCRIBE,
  "POST /contabilidad-electronica/listo-para-timbrar": ESCRIBE,
  // dashboard.ts
  "GET /dashboard": TODOS,
  // declaraciones.ts
  "POST /declaraciones/isr/pf": ESCRIBE,
  "POST /declaraciones/isr/pm": ESCRIBE,
  "POST /declaraciones/isr/pm-resico": ESCRIBE,
  "GET /declaraciones/diot/:periodo": TODOS,
  "GET /declaraciones/diot/:periodo/layout": TODOS,
  // devolucion-iva.ts
  "GET /devolucion-iva/facturas/:periodo": TODOS,
  "POST /devolucion-iva/diot": ESCRIBE,
  "POST /devolucion-iva/conciliacion": ESCRIBE,
  "POST /devolucion-iva/saldo-favor": ESCRIBE,
  "POST /devolucion-iva/congruencia": ESCRIBE,
  "POST /devolucion-iva/solicitud": ESCRIBE,
  "POST /devolucion-iva/plazo-resolucion": ESCRIBE,
  "POST /devolucion-iva/papel-trabajo": ESCRIBE,
  // efos.ts
  "GET /efos/estado": TODOS,
  "GET /efos/alertas": TODOS,
  // libro.ts
  "GET /libro/cuentas": TODOS,
  "POST /libro/catalogo/sembrar": ESCRIBE,
  "PUT /libro/cuentas": ESCRIBE,
  "GET /libro/polizas": TODOS,
  "GET /libro/polizas/:polizaId": TODOS,
  "POST /libro/polizas": ESCRIBE,
  "POST /libro/polizas/desde-cfdi": ESCRIBE,
  "POST /libro/polizas/:polizaId/reversar": ESCRIBE,
  "GET /libro/cfdi": TODOS,
  "GET /libro/balanza": TODOS,
  "GET /libro/contabilidad-electronica": TODOS,
  // migracion-catalogo.ts
  "POST /migracion-catalogo/clasificar": ESCRIBE,
  "GET /migracion-catalogo/mapeos": TODOS,
  "GET /migracion-catalogo/mapeos/:mapeoId": TODOS,
  "POST /migracion-catalogo/mapeos/:mapeoId/aprobar": ESCRIBE,
  "POST /migracion-catalogo/mapeos/:mapeoId/rechazar": ESCRIBE,
  "POST /migracion-catalogo/mapeos/:mapeoId/editar": ESCRIBE,
  // nomina.ts
  "POST /nomina/calcular": ESCRIBE,
  "POST /nomina/generar-xml": ESCRIBE,
  // pagos-provisionales.ts
  "GET /pagos-provisionales/:periodo": TODOS,
  "POST /pagos-provisionales/:periodo/calcular": TODOS,
  "PUT /pagos-provisionales/:periodo": ESCRIBE,
  "POST /pagos-provisionales/:periodo/presentar": ESCRIBE,
  "GET /pagos-provisionales/:periodo/exportar": TODOS,
  "POST /pagos-provisionales/rep": ESCRIBE,
  // portal-cliente.ts
  "GET /portal-cliente/enlaces": TODOS,
  "POST /portal-cliente/enlaces": ESCRIBE,
  "POST /portal-cliente/enlaces/:enlaceId/revocar": ESCRIBE,
  "GET /portal-cliente/documentos": TODOS,
  "GET /portal-cliente/documentos/:documentoId/descargar": TODOS,
  "POST /portal-cliente/documentos/:documentoId/aceptar": ESCRIBE,
  "POST /portal-cliente/documentos/:documentoId/rechazar": ESCRIBE,
  "GET /portal-cliente/mensajes": TODOS,
  "POST /portal-cliente/mensajes": ESCRIBE,
  // reportes.ts
  "GET /reportes/:tipo": TODOS,
  // revisiones.ts
  "GET /revisiones": TODOS,
  "GET /revisiones/:reviewId": TODOS,
  "POST /revisiones/:reviewId/aprobar": ESCRIBE,
  "POST /revisiones/:reviewId/rechazar": ESCRIBE,
  // vencimientos.ts
  "GET /vencimientos": TODOS,
  "POST /vencimientos/calcular": ESCRIBE,
  "POST /vencimientos/:deadlineId/completar": ESCRIBE,
  "POST /vencimientos/:deadlineId/escalar": ESCRIBE,
  "POST /vencimientos/barrido": ESCRIBE,
  // chat-datos.ts (Chatea con tus datos: el alcance fino lo resuelve el motor; el rol minimo es el de ver el dashboard)
  "GET /chat-datos/estado": TODOS,
  "POST /chat-datos": TODOS,
  "GET /chat-datos/conversaciones": TODOS,
  "GET /chat-datos/conversaciones/:conversationId": TODOS,
  "PATCH /chat-datos/conversaciones/:conversationId": TODOS,
  "DELETE /chat-datos/conversaciones/:conversationId": TODOS,
  "GET /chat-datos/pins": TODOS,
  "POST /chat-datos/pins": TODOS,
  "PATCH /chat-datos/pins/:pinId": TODOS,
  "DELETE /chat-datos/pins/:pinId": TODOS,
  "GET /chat-datos/pins/:pinId/resultado": TODOS,
  "POST /chat-datos/conversaciones/:conversationId/reporte": TODOS,
  "POST /chat-datos/adjuntos": TODOS,
  // rutas de nivel organizacion (`/v1/despachos/:orgSlug/...`)
  "GET /v1/despachos/:orgSlug/admin/branches": TODOS,
  "GET /v1/despachos/:orgSlug/admin/cartera": TODOS,
  "POST /v1/despachos/:orgSlug/admin/cartera": ESCRIBE,
  "GET /v1/despachos/:orgSlug/dashboard": TODOS,
  "GET /v1/despachos/:orgSlug/admin/bitacora": ADMIN_Y_AUDITOR,
};
