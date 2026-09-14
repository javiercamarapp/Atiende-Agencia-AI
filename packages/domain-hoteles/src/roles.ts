// Mapeo de `hotel_staff.role` (origen, 8 valores finos) -> `platformRole`
// (core-tenancy) + `verticalRole` (opaco, string). Ver diseño Fase 1 §2 para la
// justificación completa del mapeo — es una decisión de ESTE paquete, no algo que
// core-auth/core-tenancy ya resolvían (a diferencia de restaurantes, cuyo rol de
// origen es más plano).
export const HOTEL_ROLES = [
  "owner",
  "gm",
  "frontdesk",
  "reservations",
  "housekeeping",
  "maintenance",
  "fnb",
  "accountant",
] as const;

export type HotelRole = (typeof HOTEL_ROLES)[number];

export function isHotelRole(value: string): value is HotelRole {
  return (HOTEL_ROLES as readonly string[]).includes(value);
}

// Espejo de app, a nivel de aplicación, de las mismas reglas que hoy vive en la RLS
// real de `hoteles.can_access_money()` (ver migrations/001_hoteles_schema.sql) — la
// autoridad final SIGUE SIENDO la RLS: si este espejo se desincroniza, la peor
// consecuencia es un 403 de más, nunca un acceso de más.
export const MONEY_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "reservations", "fnb", "accountant"];
export const ADMIN_ROLES: readonly HotelRole[] = ["owner", "gm"];

// Fase 3 (H02) — quién puede crear/leer una reserva y ejecutar transiciones genéricas
// del ciclo de vida (check-in/en_estancia/check-out/cerrada) y cancelar. Distinto de
// MONEY_ROLES (housekeeping/maintenance nunca aparecen aquí tampoco, pero `fnb`/
// `accountant` sí tienen acceso a dinero sin poder mover una reserva) — la lista fina
// por transición real vive en reservationStateMachine.ts::rolesAllowedForTransition.
export const MANAGE_RESERVATIONS_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "reservations"];

// H5/REQ-BO-001/002 (Fase 5) — CFDI de hospedaje. Mismo criterio que el original
// (`CFDI_ROLES = [...ADMIN_ROLES, "accountant"]`): timbrar/cancelar un comprobante
// fiscal es una acción de dinero MÁS estricta que MONEY_ROLES (nunca frontdesk/
// reservations/fnb, que sí pueden cobrar un folio pero no fiscalizarlo).
export const CFDI_HOSPEDAJE_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];

// H16-014/REQ-REC-014 (Fase 5) — fraude interno. Disparar un escaneo es una acción
// administrativa (mismo criterio que NIGHT_AUDIT_ROLES del original): owner/gm/
// accountant. Ver el resto (roles de RESOLVER/VIEW) abajo.
export const FRAUD_SCAN_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];
/** Quién puede ver las alertas ya detectadas — mismos roles que pueden dispararlas
 *  en esta fase (los 2 patrones portados son ambos de dinero/administración; el
 *  original suma `fnb` solo para `cargo_fnb_no_posteado`, patrón fuera de alcance
 *  de Fase 5 — ver domain-hoteles/src/fraude/deteccion.ts). */
export const FRAUD_VIEW_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];
/** Quién puede RESOLVER (confirmar/descartar) una alerta — separación de funciones:
 *  deliberadamente el mismo conjunto que puede dispararla en esta fase (a
 *  diferencia de despachos, que excluye `auditor` de resolver pero lo deja ver: aquí
 *  no hay un rol de solo-auditoría en FRAUD_VIEW_ROLES que deba excluirse). */
export const FRAUD_RESOLVER_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];

// Quién puede TOMAR un pedido de F&B (recepción suele tomarlo por teléfono/WhatsApp
// hasta que exista el canal real de REQ-AB-002; F&B y dirección también pueden).
export const TOMAR_PEDIDO_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "fnb"];
// Quién puede confirmar que la cocina revisó el platillo, o afirmar seguridad al
// huésped en su nombre — deliberadamente MÁS estricto que tomar el pedido: nunca
// frontdesk.
export const CONFIRMAR_COCINA_ROLES: readonly HotelRole[] = ["owner", "gm", "fnb"];

/**
 * platformRole = techo común que core-auth entiende SIN saber nada de hoteles.
 * owner->owner, gm->admin (segundo al mando, gestiona todo salvo lo reservado al
 * dueño), el resto de los 6 roles operativos ->member. La distinción fina la hace
 * SIEMPRE `assertVerticalRole()` con HOTEL_ROLES, nunca `platformRole` — mismo
 * principio ya documentado en core-tenancy/session.ts y aplicado por
 * domain-restaurantes/src/roles.ts.
 */
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<HotelRole, "owner" | "admin" | "member"> = {
  owner: "owner",
  gm: "admin",
  frontdesk: "member",
  reservations: "member",
  housekeeping: "member",
  maintenance: "member",
  fnb: "member",
  accountant: "member",
};

// Fase 6 (REQ-REV-013) — night audit propio. Mismo criterio que el origen
// (`NIGHT_AUDIT_ROLES = [...ADMIN_ROLES, "accountant"]`): accountant puede
// disparar/consultar el cierre como parte de su función de conciliación, además de
// owner/gm.
export const NIGHT_AUDIT_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];

// Fase 6 (REQ-HK-011) — tickets de mantenimiento. Cualquier miembro del staff de la
// property puede REPORTAR uno (huésped/staff/agente/sensor, mismo criterio que el
// origen: "cualquier miembro del staff del hotel puede reportar"); solo owner/gm o el
// propio técnico de mantenimiento asignado pueden cerrarlo/actualizar su costo
// (housekeeping/frontdesk NUNCA, mismo criterio adversarial que el origen: "camarista
// no cambia costo").
export const MAINTENANCE_TICKET_CREATE_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "housekeeping", "maintenance"];
export const MAINTENANCE_TICKET_MANAGE_ROLES: readonly HotelRole[] = ["owner", "gm", "maintenance"];

// Fase 6 (REQ-HK-008) — turnos de camaristas/lavandería. Publicar/editar la plantilla
// es una decisión de supervisión (mismo criterio que crear una tarea de housekeeping,
// H6b del origen); cualquier miembro del staff de la property puede CONSULTAR el
// cumplimiento (transparencia hacia la propia camarista sobre su propio horario).
export const HOUSEKEEPING_SHIFT_PUBLISH_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk"];

// Fase 8 (REQ-BO-024, LFT art.132 fr.XXXIV) — checador de asistencia inalterable.
// Fichar (POST /asistencia/checar) NO tiene lista de roles: CUALQUIER miembro del
// staff de la property registra su propio fichaje (checador de autoservicio, mismo
// criterio que el origen: nadie ficha a nombre de otro, la ruta HTTP ignora
// cualquier staffUserId del body y usa siempre el actor autenticado, con la misma
// invariante reforzada por RLS -- `with check (staff_user_id = auth.uid())`, ver
// migrations/010_checador_asistencia.sql). Programar horarios, consultar el cruce
// de horas extra de OTRO empleado y exportar el CSV para la STPS sí son acciones de
// administración/conciliación (mismo criterio que NIGHT_AUDIT_ROLES/
// CFDI_HOSPEDAJE_ROLES: dinero/cumplimiento legal, nunca frontdesk/housekeeping/fnb/
// accountant -- a diferencia de NIGHT_AUDIT_ROLES, `accountant` no se agrega aquí: la
// nómina no es su función en esta fase, ver diseño Fase 8 §2).
export const ATTENDANCE_ADMIN_ROLES: readonly HotelRole[] = ["owner", "gm"];

// Fase 9 (REQ-REV-003/004/005/007) — motor de revenue management (pricing). Cambiar
// el gate del motor (shadow/propone/autopilot) o su límite de variación en "propone"
// es una decisión de gobierno, mismo nivel que ATTENDANCE_ADMIN_ROLES/
// NIGHT_AUDIT_ROLES: owner/gm. Registrar la aprobación explícita que exige
// REQ-REV-003 (P0/GOB) antes de habilitar autopilot PLENO es MÁS estricto:
// reservado solo a "owner" (el rol más alto de HOTEL_ROLES; fusion no modela un rol
// "founder" separado de "owner" -- ver revenue/revenueEngineGate.ts, comentario de
// cabecera, para por qué este port usa "owner" en vez del "founder" del original).
// La RLS real (migrations/011_revenue_engine_gate.sql) es la autoridad, esto es solo
// el espejo de aplicación.
export const REVENUE_GATE_MANAGE_ROLES: readonly HotelRole[] = ["owner", "gm"];
export const REVENUE_AUTOPILOT_APPROVAL_ROLES: readonly HotelRole[] = ["owner"];
// Correr/consultar un backtest walk-forward es una función de análisis/conciliación
// de revenue, mismo criterio que NIGHT_AUDIT_ROLES: owner/gm/accountant.
export const REVENUE_BACKTEST_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];

// Fase 10 (REQ-BO-010, P0) — back-office financiero: P&L USALI + punto de equilibrio
// dinámico. Ver/registrar el lado de GASTOS revela costos/nómina/márgenes del
// negocio -- MÁS estricto que MONEY_ROLES (nunca frontdesk/reservations/fnb, que sí
// pueden cobrar un folio pero no ver el P&L completo del hotel), mismo criterio que
// FRAUD_VIEW_ROLES/NIGHT_AUDIT_ROLES: owner/gm/accountant. Espejo de aplicación de
// `hoteles.can_access_pl()` (migrations/012_pl_usali.sql) -- la RLS real es la
// autoridad.
export const PL_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];

// Fase 11 (REQ-CRM-002/003, P1/F) — reputación/CRM: clasificación de reseñas +
// inbox unificado + índice agregado. Capturar/clasificar una reseña (POST) es un
// acto de front-of-house (mismo subconjunto que MANAGE_RESERVATIONS_ROLES, ya que
// hoy típicamente lo hace frontdesk/reservations al mostrador o por WhatsApp,
// mismo criterio que el origen: `REVIEW_SUBMIT_ROLES`). Verlas (inbox + índice) es
// más amplio: se suma `accountant` porque una compensación reglada mueve dinero y
// necesita poder ver el contexto completo antes de resolverla (mismo criterio que
// `REVIEW_VIEW_ROLES` del origen). Resolver (marcar ejecutada/descartada) una
// acción pendiente es MÁS estricto: mensaje proactivo y compensación son ejecución
// humana fuera de este dominio puro, compensación en particular es dinero -- mismo
// nivel que NIGHT_AUDIT_ROLES/FRAUD_RESOLVER_ROLES, nunca frontdesk/reservations
// (mismo criterio que `REVIEW_ACTION_RESOLVE_ROLES` del origen).
export const REPUTACION_SUBMIT_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "reservations"];
export const REPUTACION_VIEW_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "reservations", "accountant"];
export const REPUTACION_ACTION_RESOLVE_ROLES: readonly HotelRole[] = ["owner", "gm", "accountant"];
