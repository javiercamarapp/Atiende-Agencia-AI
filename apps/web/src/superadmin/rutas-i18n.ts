// i18n ES/EN del menu de superadmin. rutas.ts conserva la etiqueta canonica en espanol (la usan otras pantallas y specs y viaja
// en el bundle de arranque); aqui, que solo importa SuperAdminShell (chunk perezoso), se asocia cada (ruta, etiqueta) y cada
// titulo de seccion con su clave del catalogo. La prueba i18n-shell exige que no falte ninguna.
import type { Clave } from "@atiende/ui";

export const CLAVE_RUTA_SUPERADMIN: Readonly<Record<string, Clave>> = {
  "/superadmin|Resumen": "nav.resumen",
  "/superadmin/copiloto|Copiloto": "nav.copiloto",
  "/superadmin/agentes|Panel de agentes": "nav.panelAgentes",
  "/superadmin/agente-extractor|Agente extractor": "nav.agenteExtractor",
  "/superadmin/agente-conciliacion|Agente de conciliación": "nav.agenteConciliacion",
  "/superadmin/agente-whatsapp|Agente de WhatsApp y voz": "nav.agenteWhatsappVoz",
  "/superadmin/model-ops|Model Ops": "nav.modelOps",
  "/superadmin/acciones|Acciones": "nav.acciones",
  "/superadmin/cerebro|Cerebro de ventas": "nav.cerebroVentas",
  "/superadmin/mapa-prospectos|Mapa de prospectos": "nav.mapaProspectos",
  "/superadmin/organizaciones|Organizaciones": "nav.organizaciones",
  "/superadmin/costos-facturacion|Costos y facturación": "nav.costosFacturacion",
  "/superadmin/consumo-ia|Consumo de IA": "nav.consumoIa",
  "/superadmin/ejecutivo|Ejecutivo / Board": "nav.ejecutivo",
  "/superadmin/integraciones|Integraciones": "nav.integraciones",
  "/superadmin/seguridad|Seguridad (MFA)": "nav.seguridadMfa",
  "/superadmin/impersonacion|Impersonación": "nav.impersonacion",
  "/superadmin/break-glass|Romper cristal": "nav.romperCristal",
  "/superadmin/auditoria-denegaciones|Auditoría de denegaciones": "nav.auditoriaDenegaciones",
  "/superadmin/privacidad|Privacidad": "nav.privacidad",
  "/superadmin/supresion|Supresión de contactos": "nav.supresion",
  "/superadmin/zona-cfo|Zona CFO segura": "nav.zonaCfo",
  "/superadmin/planes|Planes y precios": "nav.planes",
  "/superadmin/interruptores|Interruptores": "nav.interruptores",
  "/superadmin/salud|Salud operativa": "nav.saludOperativa",
  "/superadmin/organizaciones|Orgs": "nav.orgs",
  "/superadmin/salud|Salud": "nav.salud",
  "/superadmin/costos-facturacion|Costos de IA": "nav.costosIa",
  "/superadmin/paneles|Ver los otros paneles": "nav.otrosPaneles",
};

export const CLAVE_SECCION_SUPERADMIN: Readonly<Record<string, Clave>> = {
  "Agentes": "nav.agentes",
  "Negocio": "nav.negocio",
  "Plataforma": "nav.plataforma",
  "Control": "nav.control",
  "Sistema": "nav.sistema",
};

/** Clave de una entrada del menu (ruta + etiqueta canonica); `undefined` si nadie la registro (la prueba lo impide). */
export function claveRutaSuperadmin(to: string, label: string): Clave | undefined {
  return CLAVE_RUTA_SUPERADMIN[`${to}|${label}`];
}
