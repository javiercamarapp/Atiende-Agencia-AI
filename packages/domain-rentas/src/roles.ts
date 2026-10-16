// Mapeo de `RolUsuario` + `ColaboradorNivel` (origen) -> `platformRole` (core-tenancy)
// + `verticalRole` (opaco, string). Ver diseño Fase 1 §2.2 para la justificación
// completa del mapeo — es una decisión de ESTE paquete, no algo que
// core-auth/core-tenancy ya resolvían (mismo patrón que domain-hoteles::HOTEL_ROLES).
//
// `superadmin`/`propietario` (owner externo, no-staff) quedan explícitamente fuera de
// fase — ver diseño §2.2 y §6: superadmin depende de
// feat/fusion-superadmin-impersonacion, propietario no encaja en `core.membership`
// (modelo N:M owner↔empresa_gestora).
export const RENTAS_VERTICAL_ROLES = [
  "admin_gestora",
  "operador:acceso_total",
  "operador:calendario_mensajeria",
  "operador:solo_calendario",
  "contador",
  "limpieza",
] as const;

export type RentasVerticalRole = (typeof RENTAS_VERTICAL_ROLES)[number];

export function isRentasVerticalRole(value: string): value is RentasVerticalRole {
  return (RENTAS_VERTICAL_ROLES as readonly string[]).includes(value);
}

// Espejo de app, a nivel de aplicación, de la misma regla `puedeEscribirCalendario`
// del origen — la autoridad final sigue siendo la RLS real (core.has_property_access +
// el chequeo fino de rol en la ruta): si este espejo se desincroniza, la peor
// consecuencia es un 403 de más, nunca un acceso de más.
export const ESCRITURA_CALENDARIO_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"];

// Fase 13 -- calendario visual del panel de staff (GET /rentas/:propertyId/unidades y
// GET .../unidades/:unidadId/ocupaciones, ver apps/api/.../rentas/calendario.ts):
// misma "lectura más permisiva que escritura" que ya declara
// SYNC_CALENDARIO_LECTURA_ROLES arriba de este archivo -- `operador:solo_calendario`
// existe específicamente para poder VER el calendario sin poder tocarlo (ver el test
// "un rol de SOLO calendario (lectura) no puede crear reservas/bloqueos -- 403" en
// rentas-reservas.spec.ts/rentas-bloqueos.spec.ts, que ya asume que ese rol puede
// leer). Deliberadamente NO reutilizado por `GET .../bloqueos` (bloqueos.ts, Fase 4):
// esa ruta ya existía antes de esta fase con ESCRITURA_CALENDARIO_ROLES y tocarla es
// un cambio de comportamiento fuera del alcance de este hallazgo.
//
// `contador` y `limpieza` (hallazgo de auditoría: "2 roles no pueden usar pantallas
// que se construyeron específicamente para ellos") se agregan aquí por el mismo
// criterio de "lectura, nunca escritura": `contador` ya podía LEER finanzas
// (FINANZAS_LECTURA_ROLES) pero la sección "Movimiento por reserva" de Finanzas.tsx
// (fetchUnidades/fetchOcupaciones) depende de este mismo GET .../unidades para poder
// elegir la reserva -- sin este rol aquí, esa sección nunca cargaba para `contador`.
// `limpieza` ya podía leer/escribir inventario e incidencias (LIMPIEZA_OPERACION_ROLES,
// ver ../limpieza/*) pero el selector de unidad de "Reportar incidencia" en
// MisTareas.tsx depende del mismo GET .../unidades. Ninguno de los dos entra a
// ESCRITURA_CALENDARIO_ROLES (ese Set sigue intacto, sin tocarse): ambos siguen sin
// poder crear/modificar/cancelar reservas ni bloqueos.
export const CALENDARIO_LECTURA_ROLES: readonly RentasVerticalRole[] = [
  "admin_gestora",
  "operador:acceso_total",
  "operador:calendario_mensajeria",
  "operador:solo_calendario",
  "contador",
  "limpieza",
];

// Cancelar exige el nivel más alto (equivalente a H-018 del origen: "cancelar es una
// acción irreversible desde la perspectiva del huésped").
export const CANCELAR_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total"];

// Finanzas: solo admin_gestora escribe movimiento; contador es solo-lectura (mismo
// criterio que ROLES_ADMIN/ROLES_ADMIN_CONTADOR del origen).
export const FINANZAS_ESCRITURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora"];
export const FINANZAS_LECTURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "contador"];

// Sincronización de calendario por canal (Fase 5): conectar/desconectar un feed iCal
// es una operación de calendario (afecta qué se considera ocupado) -- mismo criterio
// de rol que ESCRITURA_CALENDARIO_ROLES. La LECTURA del estado de sync se abre además
// a `operador:solo_calendario` (rol de solo-lectura de calendario que no participa en
// ESCRITURA_CALENDARIO_ROLES) -- ver rentas de calendario/bloqueos.ts para el mismo
// patrón de "lectura más permisiva que escritura".
export const SYNC_CALENDARIO_ESCRITURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"];
export const SYNC_CALENDARIO_LECTURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario"];

// Mensajería al huésped (Fase 7, packages/domain-rentas/src/mensajeria + src/agentes):
// generar/aprobar/rechazar un borrador es una acción sobre la conversación con el
// huésped, mismo criterio de "quién puede tocar mensajería" que el propio nombre del
// rol ya declara (`operador:calendario_mensajeria`) -- el conjunto de roles coincide
// hoy con ESCRITURA_CALENDARIO_ROLES pero se declara aparte, a propósito, porque son
// conceptos de negocio DISTINTOS (calendario vs. mensajería) que solo comparten
// alcance por ahora; que un tenant futuro separe estos dos permisos no debe requerir
// tocar la constante de calendario. `contador`/`limpieza`/`operador:solo_calendario`
// nunca generan/aprueban/rechazan un borrador -- mismo principio que D-006 del origen
// (aprobación humana obligatoria, restringida a quien puede escribir la conversación).
export const MENSAJERIA_ESCRITURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"];

// Leer el hilo de mensajería (conversaciones, mensajes del huésped y borradores): todo el staff con
// acceso a la property MENOS `limpieza` -- el texto que escribe el huésped puede traer datos personales
// que el personal de piso no necesita para operar tareas (minimización). `contador` y
// `operador:solo_calendario` conservan la lectura que ya tenían.
export const MENSAJERIA_LECTURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "operador:solo_calendario", "contador"];

// Plantillas de mensajería (H-056): la APROBACIÓN de una plantilla para programación
// automática es una decisión de negocio a nivel de tenant, acotada a `admin_gestora`
// (mismo criterio que PRICING_ESCRITURA_ROLES) -- un operador puede proponer/editar el
// cuerpo de una plantilla (MENSAJERIA_ESCRITURA_ROLES) pero nunca marcarla
// `aprobadaPorTenant: true` él mismo.
export const MENSAJERIA_PLANTILLA_APROBACION_ROLES: readonly RentasVerticalRole[] = ["admin_gestora"];

// Pricing (Fase 2, Flujo 4): mismo criterio que ROLES_ADMIN del origen
// (`exigirRol(auth, ...ROLES_ADMIN)` en las 5 rutas de pricing.ts) recortado a
// `admin_gestora` -- `superadmin` está fuera de fase (depende de
// feat/fusion-superadmin-impersonacion, no mergeada), mismo mapeo que ya adoptó
// Fase 1 para finanzas. `contador` (lectura financiera) NUNCA obtiene escritura de
// pricing -- mismo criterio que el origen. La LECTURA de contexto de pricing sigue
// libre para cualquier staff con membership de la property (ver cotizaciones.ts,
// Fase 1) -- no se restringe aquí.
export const PRICING_ESCRITURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora"];

/**
 * platformRole = techo común que core-auth entiende SIN saber nada de rentas. La
 * distinción fina la hace SIEMPRE `assertVerticalRole()` con RENTAS_VERTICAL_ROLES,
 * nunca `platformRole` — mismo principio que domain-hoteles::PLATFORM_ROLE_BY_VERTICAL_ROLE.
 */
// Limpieza/mantenimiento (Fase 8, packages/domain-rentas/src/limpieza/*): operar
// tareas (asignar, completar checklist/tarea, registrar incidencia) queda abierto al
// rol `limpieza` -- justo el rol que ya existía en RENTAS_VERTICAL_ROLES desde la
// Fase 1 sin que ningún módulo lo usara todavía (el gap que cierra esta fase) --
// además de quien ya puede escribir calendario. `contador`/`operador:solo_calendario`
// nunca operan tareas de limpieza (mismo criterio que MENSAJERIA_ESCRITURA_ROLES).
export const LIMPIEZA_OPERACION_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria", "limpieza"];

// Confirmar el bloqueo de mantenimiento propuesto por una incidencia GRAVE (H-055,
// REQ-118) es una acción de calendario real (inserta un bloqueo bloqueante) -- mismo
// criterio de rol que ESCRITURA_CALENDARIO_ROLES, NUNCA abierto a `limpieza` (quien
// reporta la incidencia no es quien decide bloquear disponibilidad -- separación de
// funciones deliberada, ver ../limpieza/incidencias.ts).
export const LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"];

// Crear una tarea MANUALMENTE (fuera del sweep automático de checkout, ver
// ../limpieza/aplicacion/tareas.ts::crearTareaOperativaManual) es, igual que
// confirmar un bloqueo de mantenimiento arriba, una decisión de gestión -- no una
// acción de piso: el rol `limpieza` sigue pudiendo OPERAR la tarea una vez creada
// (LIMPIEZA_OPERACION_ROLES: asignarse/completar checklist/completar/reportar
// incidencia) pero nunca decide por su cuenta darla de alta ad-hoc. El conjunto de
// roles coincide hoy con LIMPIEZA_CONFIRMAR_BLOQUEO_ROLES pero se declara aparte, a
// propósito -- mismo criterio que MENSAJERIA_ESCRITURA_ROLES/
// ESCRITURA_CALENDARIO_ROLES arriba: son decisiones de negocio DISTINTAS que solo
// comparten alcance por ahora.
export const LIMPIEZA_CREACION_MANUAL_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"];

// Asignar una tarea a OTRA persona y ver el tablero de turnos de TODO el equipo (paridad3): reparto del trabajo, decision de gestion
// (mismos 3 roles que crear una tarea a mano). El rol `limpieza` solo puede asignarse a si mismo y solo ve lo suyo y la cola sin asignar.
export const LIMPIEZA_ASIGNAR_A_OTROS_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"];

// Fijar el responsable de limpieza por omision de una unidad (paridad3, migracion 033): espejo de
// rentas.fijar_responsable_limpieza_unidad, que es la autoridad real (admin_gestora u operador:acceso_total).
export const LIMPIEZA_RESPONSABLE_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total"];

// Acceso al huésped (Rn-04): las instrucciones de acceso (código de cerradura, dirección
// exacta) son el secreto físico de la propiedad. Solo admin_gestora y operador:acceso_total
// las configuran/leen y confirman el pago que habilita su liberación -- espejo de
// rentas.can_manage_acceso (migración 025), que es la autoridad real. contador, limpieza y
// los operadores de calendario ven la reserva, no la llave.
export const ACCESO_HUESPED_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total"];

// Rn-19: alta y edicion de propiedades, unidades y propietarios (y sus reglas de comision, Rn-18, que ya
// escribe FINANZAS_ESCRITURA_ROLES): solo admin_gestora. Espejo de rentas.es_admin_gestora (migracion 027),
// que es la autoridad real. La LECTURA del catalogo se abre ademas al operador de acceso total y al contador
// (necesitan ver propietarios y unidades para operar y liquidar), nunca a los roles de piso.
export const CATALOGO_ESCRITURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora"];
export const CATALOGO_LECTURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "contador"];

// Rn-20: invitar, cambiar el rol y dar de baja al staff -- solo admin_gestora (el unico rol con platformRole
// owner; ademas `canInviteStaff` de core-authz exige que quien invita tenga al menos el rango del invitado).
export const STAFF_INVITE_ROLES: readonly RentasVerticalRole[] = ["admin_gestora"];

export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<RentasVerticalRole, "owner" | "admin" | "member" | "viewer"> = {
  admin_gestora: "owner",
  "operador:acceso_total": "member",
  "operador:calendario_mensajeria": "member",
  "operador:solo_calendario": "member",
  contador: "viewer",
  limpieza: "member",
};

/** Rn-07 -- solicitudes ARCO: solo el admin de la gestora (la RLS de 028, `rentas.can_manage_privacidad`, lo vuelve a exigir). */
export const PRIVACIDAD_ROLES: readonly RentasVerticalRole[] = ["admin_gestora"];
