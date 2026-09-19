// Catálogo CERRADO de tipos de acción del back office de plataforma
// (`/superadmin/acciones`). Fuente única de verdad de TypeScript sobre "qué
// existe" — el catálogo REALMENTE ejecutable (más acotado) vive además como
// un CHECK en SQL (`core.superadmin_action_intent.tipo`, ver
// `packages/db/migrations/0016_superadmin_acciones.sql`); ambos deben
// coincidir en las 3 acciones con intent (`ACCIONES_CON_INTENT` abajo).
//
// ═══════════════════════════════════════════════════════════════════════════
// LISTA EXPLÍCITA DE LO QUE NUNCA SE AUTOMATIZA NI SE OFRECE COMO ACCIÓN DE
// UN CLIC EN ESTE SISTEMA (viene de un incidente REAL en otro producto del
// mismo dueño: un "agente de backoffice" mandó correos redactados por LLM a
// terceros sin revisión humana, porque su ventana de veto tenía default 0 y
// su interruptor vivía en una variable de entorno sin bitácora):
//
//   1. Envíos redactados por LLM sin aprobación POR PIEZA (ni para decidir
//      qué enviar ni para redactar el texto — ver el principio rector del
//      PR completo: nada de LLM aquí).
//   2. Cambiar topes de gasto (de LLM, de plataforma, de ninguna
//      organización).
//   3. Tocar dinero: suscripciones, reembolsos, reprocesar webhooks de
//      billing, cargos o folios.
//   4. Accesos y credenciales: break-glass, roles, integraciones.
//   5. Modificar datos de NEGOCIO de un tenant (reservas, pedidos, clientes
//      de un cliente de Atiende — nunca confundir con datos de PLATAFORMA
//      como `core.prospecto`, que sí es de Atiende).
//   6. Publicar o desplegar (código, infraestructura, configuración).
//
// Estas categorías NUNCA aparecen en `ACCIONES_CON_INTENT` ni en las dos
// automatizaciones internas — están abajo en `ACCIONES_NO_DISPONIBLES` SOLO
// para que la pantalla las liste como "no disponible" (transparencia: el
// superadmin ve que existen como IDEA, nunca como botón real) y para que el
// test de este archivo (`apps/api/tests/superadmin-acciones-catalogo.spec.ts`)
// pueda fallar si alguien las mueve a un catálogo ejecutable sin pasar por
// intent.
// ═══════════════════════════════════════════════════════════════════════════

export type CategoriaAccion = "automatizacion_interna" | "accion_con_intent" | "no_disponible";

export interface CatalogoAccionEntry {
  readonly tipo: string;
  readonly categoria: CategoriaAccion;
  /** `false` = existe como idea/entrada del catálogo, pero esta pantalla
   *  NUNCA ofrece un botón real para ella. */
  readonly disponible: boolean;
  /** Regla dura verificada por
   *  `apps/api/tests/superadmin-acciones-catalogo.spec.ts`: TODO tipo
   *  `disponible: true` que no sea una de las dos automatizaciones internas
   *  declaradas DEBE tener `requiereConfirmacion: true` — ninguna acción
   *  ejecutable de un clic sin el flujo de intent + confirmación. */
  readonly requiereConfirmacion: boolean;
  readonly descripcion: string;
}

/** Las DOS automatizaciones internas declaradas (únicas excepciones a
 *  "requiereConfirmacion: true si está disponible") — corren SOLO desde el
 *  cron de sistema (`/internal/superadmin/mantenimiento`) o, con
 *  confirmación humana explícita, a través del tipo de intent
 *  `ejecutar_mantenimiento_ahora` (que SÍ requiere confirmación — estas dos
 *  entradas describen la automatización en sí, no el botón "ejecutar
 *  ahora"). */
export const AUTOMATIZACIONES_INTERNAS: readonly CatalogoAccionEntry[] = [
  {
    tipo: "desatascar_outbox_colgados",
    categoria: "automatizacion_interna",
    disponible: true,
    requiereConfirmacion: false,
    descripcion: "Devuelve a pending las filas de outbox colgadas en processing más allá de 30 min (solo en las colas donde el esquema permite saberlo con certeza). Nunca envía nada por sí sola.",
  },
  {
    tipo: "marcar_prospectos_sin_movimiento",
    categoria: "automatizacion_interna",
    disponible: true,
    requiereConfirmacion: false,
    descripcion: "Anota necesita_seguimiento en un prospecto sin movimiento > 14 días (estados terminales excluidos). Nunca cambia el estado del prospecto ni contacta a nadie.",
  },
];

/** Las 3 acciones EJECUTABLES con intent + confirmación — MISMO catálogo
 *  cerrado que el CHECK de `core.superadmin_action_intent.tipo`. */
export const ACCIONES_CON_INTENT: readonly CatalogoAccionEntry[] = [
  {
    tipo: "reencolar_mensaje_muerto",
    categoria: "accion_con_intent",
    disponible: true,
    requiereConfirmacion: true,
    descripcion: "Devuelve a pending UNA fila concreta en estado dead de una cola concreta — termina en un envío real cuando corra el dispatcher, exige confirmación humana por pieza.",
  },
  {
    tipo: "cerrar_prospecto",
    categoria: "accion_con_intent",
    disponible: true,
    requiereConfirmacion: true,
    descripcion: "Cambia un prospecto a perdido/descartado.",
  },
  {
    tipo: "ejecutar_mantenimiento_ahora",
    categoria: "accion_con_intent",
    disponible: true,
    requiereConfirmacion: true,
    descripcion: "Corre a demanda las dos automatizaciones de arriba.",
  },
];

/** Ideas que existen como entrada del catálogo pero NUNCA se ofrecen como
 *  botón real — ver la lista explícita de cabecera. `disponible: false`
 *  siempre. */
export const ACCIONES_NO_DISPONIBLES: readonly CatalogoAccionEntry[] = [
  { tipo: "enviar_mensaje_redactado_por_llm", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — envío redactado por LLM sin aprobación por pieza." },
  { tipo: "ajustar_tope_gasto_llm", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — cambia topes de gasto." },
  { tipo: "reembolsar_cargo", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — toca dinero (reembolso)." },
  { tipo: "reprocesar_webhook_billing", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — toca dinero (webhook de billing)." },
  { tipo: "modificar_suscripcion", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — toca dinero (suscripción)." },
  { tipo: "otorgar_acceso_break_glass", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — accesos y credenciales." },
  { tipo: "cambiar_rol_staff", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — accesos y credenciales." },
  { tipo: "rotar_credencial_integracion", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — accesos y credenciales." },
  { tipo: "modificar_datos_de_negocio_tenant", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — datos de negocio de un tenant (reservas, pedidos, clientes)." },
  { tipo: "publicar_o_desplegar", categoria: "no_disponible", disponible: false, requiereConfirmacion: true, descripcion: "NUNCA disponible — publicar o desplegar." },
];

/** Catálogo COMPLETO -- lo que consume la pantalla `/superadmin/acciones`
 *  para listar TODO (disponible o no). */
export const CATALOGO_ACCIONES: readonly CatalogoAccionEntry[] = [...AUTOMATIZACIONES_INTERNAS, ...ACCIONES_CON_INTENT, ...ACCIONES_NO_DISPONIBLES];

/** Tipos de las dos automatizaciones internas -- únicas excepciones legítimas
 *  a "disponible implica requiereConfirmacion" (ver el test de este
 *  catálogo). */
const TIPOS_AUTOMATIZACION_INTERNA = new Set(AUTOMATIZACIONES_INTERNAS.map((a) => a.tipo));

/** Regla dura verificada por el test de este módulo: todo tipo `disponible`
 *  que NO sea una automatización interna declarada exige confirmación. */
export function catalogoRespetaReglaDeConfirmacion(catalogo: readonly CatalogoAccionEntry[] = CATALOGO_ACCIONES): boolean {
  return catalogo.every((entry) => TIPOS_AUTOMATIZACION_INTERNA.has(entry.tipo) || !entry.disponible || entry.requiereConfirmacion);
}

/** Conjunto cerrado de tipos que `POST /superadmin/acciones/intents` acepta
 *  -- MISMO catálogo que el CHECK de `core.superadmin_action_intent.tipo`. */
export const TIPOS_INTENT_EJECUTABLES = new Set(ACCIONES_CON_INTENT.map((a) => a.tipo));

export function esTipoIntentEjecutable(tipo: string): tipo is "reencolar_mensaje_muerto" | "cerrar_prospecto" | "ejecutar_mantenimiento_ahora" {
  return TIPOS_INTENT_EJECUTABLES.has(tipo);
}
