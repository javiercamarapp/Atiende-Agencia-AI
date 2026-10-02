// Mapa ruta-de-cron -> {vertical, nombre humano} para "Agentes de las verticales -- ultima corrida" (SA-L-06, fase 1).
// La fuente real es `core.cron_heartbeat` (un renglon por cron); aqui solo se le pone nombre. Un cron nuevo en
// `vercel.json` sin entrada aqui rompe apps/api/tests/superadmin-consola.spec.ts: hay que nombrarlo.
export interface CronAgente {
  readonly vertical: string;
  readonly nombre: string;
}

export const AGENTES_CRON: Readonly<Record<string, CronAgente>> = {
  "/internal/licitaciones/discover-tenders": { vertical: "licitaciones", nombre: "Descubrimiento de convocatorias" },
  "/internal/licitaciones/deadline-reminders": { vertical: "licitaciones", nombre: "Recordatorios de fecha límite" },
  "/internal/licitaciones/alert-notifications": { vertical: "licitaciones", nombre: "Avisos de licitaciones" },
  "/internal/licitaciones/email-dispatch": { vertical: "licitaciones", nombre: "Despacho de correo de licitaciones" },
  "/internal/hoteles/identidad-purga": { vertical: "hoteles", nombre: "Purga de identidades de huéspedes" },
  "/internal/hoteles/night-audit": { vertical: "hoteles", nombre: "Auditoría nocturna de hoteles" },
  "/internal/hoteles/email-dispatch": { vertical: "hoteles", nombre: "Despacho de correo de hoteles" },
  "/internal/hoteles/revenue-recommendations": { vertical: "hoteles", nombre: "Recomendaciones de tarifas" },
  "/internal/hoteles/tickets-sla": { vertical: "hoteles", nombre: "SLA de tickets de hoteles" },
  "/internal/hoteles/aprobaciones-expiracion": { vertical: "hoteles", nombre: "Expiración de aprobaciones" },
  "/internal/hoteles/grupos-liberacion": { vertical: "hoteles", nombre: "Liberación de bloqueos de grupos" },
  "/internal/citas/confirmacion-cita": { vertical: "citas", nombre: "Recordatorios de citas" },
  "/internal/citas/email-dispatch": { vertical: "citas", nombre: "Despacho de correo de citas" },
  "/internal/citas/google-calendar-sync": { vertical: "citas", nombre: "Sincronización de Google Calendar" },
  "/internal/restaurantes/email-dispatch": { vertical: "restaurantes", nombre: "Despacho de correo de restaurantes" },
  "/internal/restaurantes/promover-programados": { vertical: "restaurantes", nombre: "Promoción de pedidos programados" },
  "/internal/restaurantes/softrestaurant-dispatch": { vertical: "restaurantes", nombre: "Envío a SoftRestaurant" },
  "/internal/restaurantes/privacidad-retencion": { vertical: "restaurantes", nombre: "Retención de privacidad de restaurantes" },
  "/internal/despachos/cobranza-reminders": { vertical: "despachos", nombre: "Recordatorios de cobranza" },
  "/internal/despachos/email-dispatch": { vertical: "despachos", nombre: "Despacho de correo de despachos" },
  "/internal/rentas/email-dispatch": { vertical: "rentas", nombre: "Despacho de correo de rentas" },
  "/internal/rentas/checkin-recordatorio": { vertical: "rentas", nombre: "Recordatorios de check-in" },
  "/internal/rentas/ical-sync": { vertical: "rentas", nombre: "Sincronización iCal de rentas" },
  "/internal/rentas/checkout-sweep": { vertical: "rentas", nombre: "Barrido de check-out" },
  "/internal/rentas/acceso-huesped": { vertical: "rentas", nombre: "Acceso de huéspedes" },
  "/internal/whatsapp/dispatch": { vertical: "plataforma", nombre: "Despacho de WhatsApp" },
  "/internal/superadmin/resumen-diario": { vertical: "plataforma", nombre: "Parte diario" },
  "/internal/superadmin/mantenimiento": { vertical: "plataforma", nombre: "Mantenimiento de plataforma" },
  "/internal/superadmin/alertas-cfo": { vertical: "plataforma", nombre: "Alertas CFO" },
};
