// Roles del vertical despachos — puerto de `b2b_ai/features/roles` (RBAC en
// diccionario en memoria en el origen, ver comentario de ese módulo: "El store en
// memoria es la iteración del piloto; la persistencia real (PostgreSQL) queda como
// siguiente iteración"). Fase 1 aterriza ESA persistencia real (core.membership +
// RLS), pero solo con los 4 roles builtin fijos que el origen ya definía — roles
// custom por tenant quedan fuera de alcance, igual que hoteles/restaurantes no los
// tienen todavía (ver diseño Fase 1 §4, "Explícitamente FUERA de Fase 1").
export const DESPACHOS_ROLES = ["admin", "contador", "auditor", "readonly"] as const;

export type DespachosRole = (typeof DESPACHOS_ROLES)[number];

export function isDespachosRole(value: string): value is DespachosRole {
  return (DESPACHOS_ROLES as readonly string[]).includes(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// CORRECCIÓN (auditoría, hallazgo MEDIO "el rol 'readonly' está definido pero
// ninguna ruta lo usa realmente"): varios comentarios de este archivo YA
// afirmaban que "`readonly` ve el resultado ya persistido" o que "`auditor`
// SÍ puede ver X" — pero ninguna constante de rol de abajo incluía
// `"readonly"` en ningún lado, y varias tampoco incluían `"auditor"` pese a
// que su propio comentario lo prometía (ej. `MIGRACION_CATALOGO_ROLES`
// decía "auditor SÍ puede ver la clasificación" pero la lista era
// `["admin", "contador"]`). Resultado real: un staff con `verticalRole:
// "readonly"` no podía abrir NINGUNA ruta de despachos — 403 en todas —, y
// `auditor` tenía huecos de lectura inconsistentes con lo que su propio
// comentario documentaba.
//
// Esta corrección separa, para cada módulo que mezclaba lectura y escritura
// bajo una sola constante, un rol `VER_*` (solo lectura: `admin`, `contador`,
// `auditor`, `readonly`) de las constantes de escritura ya existentes (sin
// tocar esas listas de escritura — siguen siendo `admin`/`contador`, nunca
// `auditor`/`readonly`, mismo criterio de separación de funciones que ya
// aplicaban). Los módulos que YA tenían su propio `VER_*`
// (`VER_CIERRE_MENSUAL_ROLES`, `VER_COBRANZA_ROLES`) solo ganan `"readonly"`
// junto al `"auditor"` que ya tenían.
// ═══════════════════════════════════════════════════════════════════════════

/** Quién puede VER la cola de revisión humana (CFDI marcados
 * `requiresHumanReview`) — `auditor`/`readonly` SÍ pueden ver (es lectura de
 * una cola ya persistida), mismo criterio que el resto de los `VER_*` de
 * abajo. Aplica SOLO a los 2 GET de revisiones.ts. */
export const VER_REVISIONES_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede RESOLVER (aprobar/rechazar) una revisión — nunca `readonly`,
 * y deliberadamente sin `auditor` (auditor VE pero no decide, mismo criterio
 * de separación de funciones que ya aplica `CONFIRMAR_COCINA_ROLES` en
 * domain-hoteles: quien declara/ejecuta no es necesariamente quien puede
 * cerrar el caso). Aplica a los 2 POST (aprobar/rechazar) de revisiones.ts. */
export const RESOLVER_REVISION_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede VER un CFDI ya ingestado/validado (detalle o listado) —
 * lectura de un registro ya persistido, `auditor`/`readonly` incluidos.
 * Aplica SOLO a los 2 GET de cfdi.ts. */
export const VER_CFDI_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede ingestar/validar un CFDI nuevo (escritura real: persiste el
 * invoice) — nunca `auditor`/`readonly`. Aplica a los 2 POST de cfdi.ts. */
export const INGESTA_CFDI_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede VER los vencimientos fiscales ya registrados — lectura de un
 * calendario ya persistido. Aplica SOLO al GET (listado) de vencimientos.ts. */
export const VER_VENCIMIENTOS_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede gestionar vencimientos fiscales (calcular/crear, marcar
 * completado, escalar) — nunca `auditor`/`readonly`. Aplica a los 3 POST de
 * vencimientos.ts. */
export const GESTION_VENCIMIENTOS_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede VER una DIOT ya agregada desde invoices persistidos —
 * lectura pura, sin cálculo nuevo. Aplica SOLO al GET diot/:periodo de
 * declaraciones.ts. */
export const VER_DECLARACIONES_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede calcular declaraciones (ISR de honorarios/PM/RESICO) — Fase
 * 4: mismo criterio que INGESTA_CFDI_ROLES/GESTION_VENCIMIENTOS_ROLES, son
 * los mismos operadores que preparan las obligaciones fiscales del cliente;
 * `auditor`/`readonly` nunca ejecutan el cálculo en vivo. Aplica a los 3
 * POST isr/* de declaraciones.ts. */
export const DECLARACIONES_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede calcular nómina o generar el XML del CFDI de nómina (Fase 4)
 * — mismo criterio que DECLARACIONES_ROLES; sin GET propio en nomina.ts, así
 * que no hay una contraparte `VER_*` que separar todavía. */
export const NOMINA_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede correr el motor de conciliación bancaria (Fase 5) — mismo
 * criterio que DECLARACIONES_ROLES/NOMINA_ROLES; sin GET propio en
 * conciliacion.ts. */
export const CONCILIACION_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede VER los mapeos de migración de catálogo contable y su
 * clasificación sugerida — es lectura de un análisis, no una decisión.
 * Aplica SOLO a los 2 GET (mapeos/mapeos/:id) de migracion-catalogo.ts. */
export const VER_MIGRACION_CATALOGO_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede correr el clasificador (escritura: persiste mapeos nuevos) —
 * nunca `auditor`/`readonly`. Aplica al POST clasificar de
 * migracion-catalogo.ts. */
export const MIGRACION_CATALOGO_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede decidir un mapeo (aprobar/rechazar/editar) — reservado igual
 * que RESOLVER_REVISION_ROLES, nunca `auditor`/`readonly`. */
export const DECIDIR_MAPEO_MIGRACION_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede VER las facturas candidatas a devolución de IVA de un
 * período — lectura de invoices ya persistidos. Aplica SOLO al GET
 * facturas/:periodo de devolucion-iva.ts. */
export const VER_DEVOLUCION_IVA_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede correr el papel de trabajo de devolución de IVA (Fase 6) —
 * mismo criterio que DECLARACIONES_ROLES/CONCILIACION_ROLES: son los mismos
 * operadores que preparan obligaciones fiscales del cliente. Aplica a los 7
 * POST de devolucion-iva.ts (diot/conciliacion/saldo-favor/congruencia/
 * solicitud/plazo-resolucion/papel-trabajo). */
export const DEVOLUCION_IVA_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede VER el catálogo de cuentas base de bookkeeping (referencia
 * fija, sin datos del cliente) — lectura pura. Aplica SOLO al GET
 * catalogo de bookkeeping.ts. */
export const VER_BOOKKEEPING_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede correr el auto-clasificador de pólizas / generar pólizas /
 * registrar ajustes u overrides (Fase 6) — mismo criterio. Aplica a los 4
 * POST de bookkeeping.ts. */
export const BOOKKEEPING_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede VER el catálogo base de cuentas del Anexo 24 SAT (referencia
 * fija) — lectura pura. Aplica SOLO al GET catalogo-base de
 * contabilidad-electronica.ts. */
export const VER_CONTABILIDAD_ELECTRONICA_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede generar el paquete de contabilidad electrónica del SAT
 * (catálogo de cuentas XML, balanza XML, paquete completo) y marcarlo listo
 * para timbrar — obligación fiscal mensual real, mismo criterio que
 * DEVOLUCION_IVA_ROLES/BOOKKEEPING_ROLES: son los mismos operadores que
 * preparan las obligaciones fiscales del cliente, nunca `auditor`/
 * `readonly`. Aplica a los 4 POST de contabilidad-electronica.ts. */
export const CONTABILIDAD_ELECTRONICA_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede ver el checklist/estado de un período de cierre (y correr
 * las validaciones de balance, endpoints puros/calculadora sin
 * persistencia — nunca escriben nada, mismo criterio que agruparlas aquí
 * desde el diseño original) — `auditor`/`readonly` SÍ pueden ver. */
export const VER_CIERRE_MENSUAL_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede abrir un período, completar tareas o correr auto-check —
 * mismo criterio que DECLARACIONES_ROLES. */
export const GESTIONAR_CIERRE_MENSUAL_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede CERRAR (o, en una fase futura, reabrir) un período — acción
 * irreversible en esta fase (sin reapertura implementada, ver
 * cierre-mensual/engine.ts): reservada a `admin`, ni siquiera `contador`,
 * mismo criterio de separación de funciones que ADMIN_ROLES ya aplica en
 * otras acciones de alto impacto de esta vertical. */
export const CERRAR_PERIODO_ROLES: readonly DespachosRole[] = ["admin"];

/** Quién puede ver la cartera/aging de cobranza (Fase 10) — `auditor`/
 * `readonly` SÍ pueden ver (es lectura de un análisis, mismo criterio que
 * VER_MIGRACION_CATALOGO_ROLES/VER_CIERRE_MENSUAL_ROLES). */
export const VER_COBRANZA_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede registrar una cuenta por cobrar, marcarla pagada o generar/
 * registrar un recordatorio — mismo criterio que DECLARACIONES_ROLES/
 * CONCILIACION_ROLES: son los mismos operadores que preparan/ejecutan la
 * operación financiera del cliente, nunca `auditor`/`readonly`. */
export const GESTIONAR_COBRANZA_ROLES: readonly DespachosRole[] = ["admin", "contador"];

export const ADMIN_ROLES: readonly DespachosRole[] = ["admin"];

/** FASE 3 (producto) -- zona horaria por negocio (migración 012). Quién puede VER
 * la configuración de zona horaria de una property -- lectura de config ya
 * persistida, mismo criterio que el resto de los `VER_*` de arriba
 * (`auditor`/`readonly` sí pueden ver). */
export const VER_CONFIGURACION_ROLES: readonly DespachosRole[] = ["admin", "contador", "auditor", "readonly"];

/** Quién puede EDITAR la zona horaria de una property -- reservado a `admin` (el
 * único "owner" real de despachos, ver `PLATFORM_ROLE_BY_VERTICAL_ROLE` abajo),
 * mismo umbral que `CERRAR_PERIODO_ROLES`/`STAFF_INVITE_ROLES`: configuración de
 * negocio (no catálogo/operación del día a día) reservada al techo real de la
 * organización -- mismo criterio EXACTO que `restaurantes.STAFF_INVITE_ROLES` para
 * `whatsapp_channel_config`/`known_zone`
 * (migrations/021_restaurantes_config_editable_y_search_path_fix.sql). Idéntico a
 * `ADMIN_ROLES` hoy -- constante propia (en vez de reusar `ADMIN_ROLES` directo en
 * la ruta) para que un cambio futuro de "quién administra configuración" no tenga
 * que adivinar si también debe mover el techo de `CERRAR_PERIODO_ROLES`. */
export const GESTIONAR_CONFIGURACION_ROLES: readonly DespachosRole[] = ["admin"];

/**
 * Hallazgo de auditoría (severidad ALTA, "Alta de organización/staff imposible
 * sin SQL") — quién puede invitar staff nuevo, mismo patrón que
 * `STAFF_INVITE_ROLES` de domain-restaurantes (ver
 * apps/api/.../despachos/admin-staff.ts, que replica
 * restaurantes/admin-staff.ts). A diferencia de restaurantes (que separa
 * "owner"/"admin" como dos niveles de gestión distintos), despachos solo
 * tiene un techo real (`admin`, mapeado a platformRole "owner" — ver
 * PLATFORM_ROLE_BY_VERTICAL_ROLE abajo): reservar la invitación a `admin`
 * únicamente sigue el mismo criterio de separación de funciones que ya
 * aplica CERRAR_PERIODO_ROLES a otras acciones de alto impacto (dar de alta
 * una cuenta con acceso al despacho es, al menos, igual de sensible que
 * cerrar un período fiscal). El techo real de a quién puede invitar cada
 * quien (ej. nunca a otro con platformRole más alto) lo resuelve
 * `@atiende/core-authz::canInviteStaff` sobre el platformRole mapeado —
 * esta lista es solo el primer filtro (quién llega siquiera a la ruta).
 */
export const STAFF_INVITE_ROLES: readonly DespachosRole[] = ["admin"];

/**
 * platformRole = techo común que core-auth entiende sin conocer despachos.
 * admin->owner (dueño del despacho), contador->admin (opera el día a día),
 * auditor/readonly->viewer (solo lectura, distinción fina vive en verticalRole).
 * Mismo principio que PLATFORM_ROLE_BY_VERTICAL_ROLE de domain-hoteles/domain-
 * restaurantes.
 */
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<DespachosRole, "owner" | "admin" | "viewer"> = {
  admin: "owner",
  contador: "admin",
  auditor: "viewer",
  readonly: "viewer",
};
