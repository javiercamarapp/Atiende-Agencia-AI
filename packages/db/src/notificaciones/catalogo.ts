// Catalogo de eventos de notificacion in-app (core.notification) por vertical y superadmin.
//
// UNA sola tabla de datos: cada evento importante del ciclo (algo nuevo que atender, algo que fallo,
// algo por vencer, una aprobacion pendiente, un costo/umbral, un cierre) con su id estable, categoria,
// severidad, roles destinatarios, icono, texto SIN PII (plantilla con parametros numericos o codigos
// cortos, nunca nombres ni texto libre), enlace a la pantalla origen y regla de dedupe/expiracion.
//
// `productor.estado`:
//   * "conectado": existe un productor real que llama `emitirNotificacion(<id>)`; `archivo` apunta a
//     el. La prueba `tests/notificaciones-catalogo.spec.ts` verifica que el archivo existe y contiene el
//     id, que el enlace corresponde a una ruta real de apps/web y que el texto no admite PII.
//   * "pendiente": la feature origen existe (o esta en otro PR) pero su productor aun no se conecta;
//     `motivo` dice exactamente que falta. Es un hueco declarado, nunca un evento fingido.
//
// Destinatarios: SIEMPRE owner/admin de la organizacion (platform_role) mas los `roles` de vertical
// listados; los eventos de ambito "superadmin" van a core.platform_superadmin. El enlace usa el
// marcador {orgSlug}, que la base sustituye por el slug real (core.emit_notification).

export const AMBITOS_NOTIFICACION = ["restaurantes", "hoteles", "citas", "licitaciones", "rentas", "despachos", "superadmin"] as const;
export type AmbitoNotificacion = (typeof AMBITOS_NOTIFICACION)[number];

export const CATEGORIAS_NOTIFICACION = [
  "onboarding",
  "operacion",
  "agentes",
  "aprobaciones",
  "automatizaciones",
  "cobranza",
  "fiscal",
  "seguridad",
  "salud",
  "cierres",
] as const;
export type CategoriaNotificacion = (typeof CATEGORIAS_NOTIFICACION)[number];

export type SeveridadNotificacion = "info" | "atencion" | "critica";

export type ProductorNotificacion =
  | { readonly estado: "conectado"; readonly archivo: string; readonly nota?: string }
  | { readonly estado: "pendiente"; readonly motivo: string };

export interface EventoNotificacion {
  readonly id: string;
  readonly ambito: AmbitoNotificacion;
  readonly categoria: CategoriaNotificacion;
  readonly severidad: SeveridadNotificacion;
  /** Roles de vertical (ademas de owner/admin de plataforma). Vacio = solo owner/admin. */
  readonly roles: readonly string[];
  /** Nombre del icono de lucide-react que usara la pantalla de notificaciones. */
  readonly icono: string;
  /** Plantillas: solo `{param}` declarados en `parametros`. Sin PII por construccion. */
  readonly titulo: string;
  readonly cuerpo: string | null;
  readonly parametros: readonly string[];
  /** Ruta interna de apps/web; `{orgSlug}` lo resuelve la base. */
  readonly enlace: string;
  /** Regla de dedupe legible; la clave real es `<id>:<clave del productor>`. */
  readonly dedupe: string;
  /** Dias de vigencia antes de expirar. */
  readonly venceDias: number;
  readonly productor: ProductorNotificacion;
}

export const CATALOGO_NOTIFICACIONES: readonly EventoNotificacion[] = [
  // ---- Restaurantes -------------------------------------------------------------------------------
  { id: "restaurantes.pedido.nuevo", ambito: "restaurantes", categoria: "operacion", severidad: "info", roles: ["staff"], icono: "ShoppingBag", titulo: "Pedido nuevo por atender", cuerpo: null, parametros: [], enlace: "/restaurantes/{orgSlug}/pedidos", dedupe: "un aviso por pedido (clave = id del pedido)", venceDias: 7, productor: { estado: "conectado", archivo: "packages/domain-restaurantes/src/postgres-repository.ts" } },
  { id: "restaurantes.handoff.solicitado", ambito: "restaurantes", categoria: "agentes", severidad: "atencion", roles: ["staff"], icono: "UserRoundCog", titulo: "Un cliente pide hablar con una persona", cuerpo: "El agente derivó una conversación a atención humana.", parametros: [], enlace: "/restaurantes/{orgSlug}/conversaciones", dedupe: "una por conversacion derivada", venceDias: 3, productor: { estado: "conectado", archivo: "packages/domain-restaurantes/src/conversaciones/postgres-repository.ts" } },
  { id: "restaurantes.voz.llamada_escalada", ambito: "restaurantes", categoria: "agentes", severidad: "atencion", roles: ["staff"], icono: "PhoneCall", titulo: "Una llamada pasó a una persona", cuerpo: "El agente de voz no pudo cerrar la llamada y dejó un aviso para devolverla.", parametros: [], enlace: "/restaurantes/{orgSlug}/agente-voz", dedupe: "una por llamada", venceDias: 3, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/restaurantes/voz-interno.ts" } },
  { id: "restaurantes.voz.proveedor_con_fallas", ambito: "restaurantes", categoria: "salud", severidad: "atencion", roles: [], icono: "TriangleAlert", titulo: "El proveedor de voz está registrando errores", cuerpo: "Revise el estado del servicio de voz en Indicadores.", parametros: [], enlace: "/restaurantes/{orgSlug}/agente-voz", dedupe: "una por sucursal por hora", venceDias: 2, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/restaurantes/voz-interno.ts" } },
  { id: "restaurantes.callback.pendiente", ambito: "restaurantes", categoria: "agentes", severidad: "atencion", roles: ["staff"], icono: "PhoneCall", titulo: "Un cliente dejó un contacto para devolverle la llamada", cuerpo: "El agente anotó una solicitud de contacto pendiente.", parametros: [], enlace: "/restaurantes/{orgSlug}/conversaciones", dedupe: "una por solicitud de contacto (clave = id)", venceDias: 3, productor: { estado: "conectado", archivo: "packages/domain-restaurantes/src/postgres-repository.ts" } },
  { id: "restaurantes.proveedor.falla", ambito: "restaurantes", categoria: "salud", severidad: "critica", roles: [], icono: "TriangleAlert", titulo: "Falla un proveedor del agente", cuerpo: "Proveedor: {proveedor}.", parametros: ["proveedor"], enlace: "/restaurantes/{orgSlug}/configuracion", dedupe: "una por proveedor por dia", venceDias: 7, productor: { estado: "pendiente", motivo: "requiere el estado de salud por proveedor del gateway (PR de OpenRouter/gateway)" } },
  { id: "restaurantes.demo.tope_diario_alcanzado", ambito: "restaurantes", categoria: "cierres", severidad: "atencion", roles: [], icono: "Gauge", titulo: "La demo alcanzó su tope diario de mensajes", cuerpo: "Tope de hoy: {cantidad} mensajes. El chat de la demo responde \"tope alcanzado\" hasta mañana.", parametros: ["cantidad"], enlace: "/restaurantes/{orgSlug}/configuracion", dedupe: "una por dia", venceDias: 2, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/restaurantes/demo-widget.ts" } },
  { id: "restaurantes.costo.umbral_voz", ambito: "restaurantes", categoria: "cierres", severidad: "atencion", roles: [], icono: "Gauge", titulo: "El costo de voz del día alcanzó el umbral configurado", cuerpo: "Revise el consumo de la sucursal en Agente de voz.", parametros: [], enlace: "/restaurantes/{orgSlug}/agente-voz", dedupe: "una por sucursal por dia", venceDias: 2, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/restaurantes/voz-kpi.ts" } },
  { id: "restaurantes.voz.tasa_error_alta", ambito: "restaurantes", categoria: "salud", severidad: "atencion", roles: [], icono: "TriangleAlert", titulo: "La tasa de errores del agente de voz superó el umbral configurado", cuerpo: "Revise el estado del servicio de voz en Indicadores.", parametros: [], enlace: "/restaurantes/{orgSlug}/agente-voz", dedupe: "una por sucursal por dia", venceDias: 2, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/restaurantes/voz-kpi.ts" } },
  { id: "restaurantes.onboarding.listo", ambito: "restaurantes", categoria: "onboarding", severidad: "info", roles: [], icono: "CircleCheckBig", titulo: "Primeros pasos completos: el restaurante está listo para operar", cuerpo: null, parametros: [], enlace: "/restaurantes/{orgSlug}/primeros-pasos", dedupe: "una por organizacion, al completarse el ultimo punto obligatorio (no al leer el checklist)", venceDias: 30, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/restaurantes/onboarding-aviso.ts", nota: "se emite en la escritura que lo completa: disponibilidad de menu por sucursal, politica/horario de sucursal o configuracion del agente" } },
  // ---- Hoteles ------------------------------------------------------------------------------------
  { id: "hoteles.ticket.sla_vencido", ambito: "hoteles", categoria: "operacion", severidad: "atencion", roles: ["gm", "frontdesk"], icono: "Clock", titulo: "Tickets de huéspedes con SLA vencido", cuerpo: "Escalados: {cantidad}.", parametros: ["cantidad"], enlace: "/hoteles/{orgSlug}/tickets", dedupe: "una por propiedad por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/hoteles/tickets-sla-cron.ts" } },
  { id: "hoteles.aprobacion.expirada", ambito: "hoteles", categoria: "aprobaciones", severidad: "atencion", roles: ["gm", "reservations"], icono: "ShieldAlert", titulo: "Solicitudes del agente expiraron sin decisión", cuerpo: "Expiradas: {cantidad}.", parametros: ["cantidad"], enlace: "/hoteles/{orgSlug}/aprobaciones", dedupe: "una por propiedad por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/hoteles/agentes-expiracion-cron.ts" } },
  { id: "hoteles.aprobacion.pendiente", ambito: "hoteles", categoria: "aprobaciones", severidad: "atencion", roles: ["gm", "reservations"], icono: "ShieldCheck", titulo: "Hay una solicitud del agente por aprobar", cuerpo: null, parametros: [], enlace: "/hoteles/{orgSlug}/aprobaciones", dedupe: "una por solicitud", venceDias: 3, productor: { estado: "conectado", archivo: "packages/domain-hoteles/src/agentes/postgres-repository.ts" } },
  { id: "hoteles.grupo.por_liberar", ambito: "hoteles", categoria: "cierres", severidad: "atencion", roles: ["gm", "reservations"], icono: "Users", titulo: "Bloqueos de grupo por liberar", cuerpo: "Grupos: {cantidad}.", parametros: ["cantidad"], enlace: "/hoteles/{orgSlug}/grupos", dedupe: "una por propiedad por dia", venceDias: 5, productor: { estado: "pendiente", motivo: "cron grupos-liberacion: falta decidir el umbral de aviso con producto" } },
  { id: "hoteles.grupo.liberado", ambito: "hoteles", categoria: "cierres", severidad: "atencion", roles: ["gm", "reservations"], icono: "Users", titulo: "Se liberaron bloqueos de grupo por su fecha de corte", cuerpo: "Bloqueos liberados: {cantidad}.", parametros: ["cantidad"], enlace: "/hoteles/{orgSlug}/grupos", dedupe: "una por propiedad por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/hoteles/grupos-liberacion-cron.ts" } },
  { id: "hoteles.night_audit.fallo", ambito: "hoteles", categoria: "cierres", severidad: "critica", roles: ["gm", "accountant"], icono: "MoonStar", titulo: "El cierre nocturno no terminó", cuerpo: null, parametros: [], enlace: "/hoteles/{orgSlug}/reservas", dedupe: "una por propiedad por noche", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/hoteles/night-audit.ts" } },
  // ---- Rentas vacacionales ------------------------------------------------------------------------
  { id: "rentas.ical.sync_fallido", ambito: "rentas", categoria: "salud", severidad: "critica", roles: ["admin_gestora", "operador:acceso_total"], icono: "RefreshCwOff", titulo: "Falla la sincronización de calendarios", cuerpo: "Calendarios con error: {cantidad}.", parametros: ["cantidad"], enlace: "/rentas/{orgSlug}/monitor-sync", dedupe: "una por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/rentas/ical-sync-cron.ts" } },
  { id: "rentas.reserva.nueva_ical", ambito: "rentas", categoria: "operacion", severidad: "info", roles: ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"], icono: "CalendarPlus", titulo: "Reservas nuevas importadas del calendario", cuerpo: "Nuevas: {cantidad}.", parametros: ["cantidad"], enlace: "/rentas/{orgSlug}/calendario", dedupe: "una por corrida de sincronizacion y dia", venceDias: 5, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/rentas/ical-sync-cron.ts" } },
  { id: "rentas.conflicto.detectado", ambito: "rentas", categoria: "operacion", severidad: "critica", roles: ["admin_gestora", "operador:acceso_total"], icono: "CalendarX", titulo: "Hay reservas en conflicto", cuerpo: "Conflictos: {cantidad}.", parametros: ["cantidad"], enlace: "/rentas/{orgSlug}/calendario", dedupe: "una por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/rentas/ical-sync-cron.ts" } },
  { id: "rentas.aprobacion.pendiente", ambito: "rentas", categoria: "aprobaciones", severidad: "atencion", roles: ["admin_gestora", "operador:calendario_mensajeria"], icono: "MessageSquareWarning", titulo: "Un mensaje a huésped espera aprobación", cuerpo: null, parametros: [], enlace: "/rentas/{orgSlug}/aprobaciones", dedupe: "una por mensaje", venceDias: 3, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/rentas/mensajeria-borradores.ts" } },
  // ---- Despachos contables ------------------------------------------------------------------------
  { id: "despachos.cobranza.recordatorios", ambito: "despachos", categoria: "cobranza", severidad: "atencion", roles: ["contador"], icono: "Receipt", titulo: "Cuentas por cobrar con recordatorio hoy", cuerpo: "Cuentas con recordatorio: {cantidad}.", parametros: ["cantidad"], enlace: "/despachos/{orgSlug}/cola-cobranza", dedupe: "una por organizacion por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/despachos/notifications.ts" } },
  { id: "despachos.fiscal.vencimiento_proximo", ambito: "despachos", categoria: "fiscal", severidad: "atencion", roles: ["contador"], icono: "CalendarClock", titulo: "Obligaciones fiscales por vencer", cuerpo: "Por vencer hoy o mañana: {cantidad}.", parametros: ["cantidad"], enlace: "/despachos/{orgSlug}/vencimientos", dedupe: "una por property por dia", venceDias: 7, productor: { estado: "conectado", archivo: "packages/domain-despachos/src/vencimientos/procesos.ts" } },
  { id: "despachos.fiscal.vencimiento_vencido", ambito: "despachos", categoria: "fiscal", severidad: "critica", roles: ["contador"], icono: "CalendarX", titulo: "Obligaciones fiscales vencidas", cuerpo: "Vencidas sin presentar: {cantidad}.", parametros: ["cantidad"], enlace: "/despachos/{orgSlug}/vencimientos", dedupe: "una por property por dia", venceDias: 14, productor: { estado: "conectado", archivo: "packages/domain-despachos/src/vencimientos/procesos.ts" } },
  { id: "despachos.fiscal.vencimiento_escalado", ambito: "despachos", categoria: "fiscal", severidad: "atencion", roles: ["contador"], icono: "ArrowUpFromLine", titulo: "Se escaló una obligación fiscal", cuerpo: "Nivel de escalamiento: {nivel}.", parametros: ["nivel"], enlace: "/despachos/{orgSlug}/vencimientos", dedupe: "una por vencimiento y nivel", venceDias: 14, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/despachos/vencimientos.ts" } },
  { id: "despachos.rep.incoherente", ambito: "despachos", categoria: "fiscal", severidad: "atencion", roles: ["contador", "auditor"], icono: "FileWarning", titulo: "Un complemento de pago tiene documentos sin ligar o con saldo incoherente", cuerpo: "Documentos a revisar: {cantidad}.", parametros: ["cantidad"], enlace: "/despachos/{orgSlug}/cfdi", dedupe: "una por complemento de pago guardado (clave = property + folio fiscal del REP)", venceDias: 14, productor: { estado: "pendiente", motivo: "el analisis de REP (POST .../cfdi/rep/analizar) no guarda nada y lo pueden llamar roles de solo lectura: emitir ahi llenaria la campana con XML arbitrario; se conecta cuando el REP se persista" } },
  { id: "despachos.efos.alerta", ambito: "despachos", categoria: "fiscal", severidad: "critica", roles: ["contador", "auditor"], icono: "ShieldAlert", titulo: "Se ingirió un CFDI de un emisor presunto o definitivo en la lista 69-B", cuerpo: null, parametros: [], enlace: "/despachos/{orgSlug}/cfdi", dedupe: "una por CFDI ingerido (clave = id del CFDI)", venceDias: 30, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/despachos/cfdi.ts" } },
  // ---- Licitaciones -------------------------------------------------------------------------------
  { id: "licitaciones.plazo.por_vencer", ambito: "licitaciones", categoria: "operacion", severidad: "atencion", roles: ["analyst", "writer", "reviewer"], icono: "Hourglass", titulo: "Convocatorias con plazo por vencer", cuerpo: "Recordatorios nuevos: {cantidad}.", parametros: ["cantidad"], enlace: "/licitaciones/{orgSlug}/seguimiento", dedupe: "una por organizacion por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/licitaciones/discover.ts" } },
  { id: "licitaciones.convocatoria.nueva", ambito: "licitaciones", categoria: "operacion", severidad: "info", roles: ["analyst"], icono: "FilePlus2", titulo: "La ingesta automática descubrió licitaciones nuevas", cuerpo: "Registros nuevos: {cantidad}.", parametros: ["cantidad"], enlace: "/licitaciones/{orgSlug}/convocatorias", dedupe: "una por organizacion por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/licitaciones/discover.ts" } },
  { id: "licitaciones.fallo.publicado", ambito: "licitaciones", categoria: "cierres", severidad: "atencion", roles: ["analyst", "reviewer"], icono: "Gavel", titulo: "Se publico un fallo", cuerpo: null, parametros: [], enlace: "/licitaciones/{orgSlug}/seguimiento", dedupe: "una por convocatoria", venceDias: 30, productor: { estado: "pendiente", motivo: "requiere el detector de fallo en la fuente (depende de un agregador comercial sin proveedor elegido)" } },
  // ---- Citas --------------------------------------------------------------------------------------
  { id: "citas.cita.nueva", ambito: "citas", categoria: "operacion", severidad: "info", roles: ["staff"], icono: "CalendarPlus", titulo: "Nueva cita agendada", cuerpo: null, parametros: [], enlace: "/citas/{orgSlug}/agenda", dedupe: "una por cita", venceDias: 7, productor: { estado: "conectado", archivo: "packages/domain-citas/src/postgres-repository.ts" } },
  { id: "citas.cita.cancelada", ambito: "citas", categoria: "operacion", severidad: "atencion", roles: ["staff"], icono: "CalendarX", titulo: "Un cliente canceló una cita", cuerpo: null, parametros: [], enlace: "/citas/{orgSlug}/agenda", dedupe: "una por cita cancelada", venceDias: 7, productor: { estado: "conectado", archivo: "packages/domain-citas/src/postgres-repository.ts" } },
  { id: "citas.recordatorio.fallido", ambito: "citas", categoria: "salud", severidad: "atencion", roles: [], icono: "BellOff", titulo: "Recordatorios de cita sin enviar", cuerpo: "Sin enviar: {cantidad}.", parametros: ["cantidad"], enlace: "/citas/{orgSlug}/mensajes-whatsapp", dedupe: "una por dia", venceDias: 5, productor: { estado: "conectado", archivo: "apps/api/src/routes/verticals/citas/reminders.ts" } },
  // ---- Superadmin (plataforma) --------------------------------------------------------------------
  { id: "superadmin.cfo.alerta", ambito: "superadmin", categoria: "cobranza", severidad: "critica", roles: [], icono: "ChartNoAxesCombined", titulo: "Alerta financiera de la plataforma", cuerpo: "Regla: {regla}. Organizaciones afectadas: {cantidad}.", parametros: ["regla", "cantidad"], enlace: "/superadmin/cfo", dedupe: "una por regla por mes", venceDias: 31, productor: { estado: "conectado", archivo: "apps/api/src/routes/internal/superadmin-alertas-cfo.ts" } },
  { id: "superadmin.cron.fallo", ambito: "superadmin", categoria: "salud", severidad: "critica", roles: [], icono: "ServerCrash", titulo: "Un cron falló", cuerpo: "Tarea: {ruta}.", parametros: ["ruta"], enlace: "/superadmin/resumen", dedupe: "una por cron por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/salud/with-heartbeat.ts" } },
  { id: "superadmin.costo.ia_umbral", ambito: "superadmin", categoria: "cobranza", severidad: "atencion", roles: [], icono: "Gauge", titulo: "El gasto de IA superó un umbral", cuerpo: "Uso: {porcentaje} por ciento del presupuesto.", parametros: ["porcentaje"], enlace: "/superadmin/gasto-api", dedupe: "una por umbral (80, 100) por mes", venceDias: 31, productor: { estado: "conectado", archivo: "apps/api/src/production/llm-usage-gateway-adapters.ts" } },
  { id: "superadmin.llm.modelo_caido", ambito: "superadmin", categoria: "salud", severidad: "critica", roles: [], icono: "TriangleAlert", titulo: "Un modelo de IA dejó de responder", cuerpo: "Modelo: {modelo}. El gateway pasa al siguiente modelo de la escalera.", parametros: ["modelo"], enlace: "/superadmin/salud", dedupe: "una por modelo por dia", venceDias: 7, productor: { estado: "conectado", archivo: "apps/api/src/production/llm-gateway.ts" } },
  { id: "superadmin.organizacion.accion_pendiente", ambito: "superadmin", categoria: "aprobaciones", severidad: "atencion", roles: [], icono: "UserRoundCheck", titulo: "Una acción sobre una organización espera la aprobación de un segundo superadmin", cuerpo: null, parametros: [], enlace: "/superadmin/gestion-organizaciones", dedupe: "una por solicitud", venceDias: 2, productor: { estado: "conectado", archivo: "apps/api/src/routes/superadmin-organizaciones.ts" } },
];

export function eventoPorId(id: string): EventoNotificacion | undefined {
  return CATALOGO_NOTIFICACIONES.find((e) => e.id === id);
}
