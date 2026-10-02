// Mapa de rutas del superadmin: ARCHIVO PLANO Y UNICO (equivalente a `admin/rutas.ts` de Likida).
// De aqui salen el sidebar, la hoja "Mas" del movil, el rail colapsado y el pie; cualquier consumidor
// futuro (paleta de comandos, rejilla "Orquestacion de agentes" del Resumen) debe leer `TODAS_LAS_RUTAS`
// o `SECCIONES` en vez de repetir una lista a mano.
//
// REGLA NO-MAQUETAS: aqui solo entra una ruta que tiene PAGINA REAL detras (ver App.tsx). Las paginas
// del menu objetivo de Likida que todavia no existen NO aparecen como entrada fantasma ni deshabilitada:
// se registran en `PENDIENTES` con el ticket que las cierra y el motivo, y entran a `SECCIONES` el dia
// que su pagina exista. El orden de las secciones y de las entradas sigue el de Likida
// (Agentes, Negocio, Plataforma, Control, Sistema); una seccion sin ninguna pagina real no se pinta.
//
// Sin JSX ni hooks a proposito: lo importan el shell (cliente) y las pruebas.
import {
  Activity,
  AlertOctagon,
  ArrowLeftRight,
  BellOff,
  Building2,
  Coins,
  DollarSign,
  FileSignature,
  KeyRound,
  LayoutGrid,
  LineChart,
  ListChecks,
  Lock,
  Newspaper,
  Plug,
  Power,
  Receipt,
  ReceiptText,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Tags,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface RutaSuperadmin {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Activa solo con coincidencia exacta (la raiz no debe quedar activa en todas las hijas). */
  readonly end?: boolean;
}

export interface SeccionSuperadmin {
  readonly title: string;
  readonly items: readonly RutaSuperadmin[];
}

/** "Resumen": arriba y fuera de las secciones (en Likida, `Inicio`). Hoy muestra el parte diario real. */
export const RESUMEN: RutaSuperadmin = { to: "/superadmin", label: "Resumen", icon: LayoutGrid, end: true };

/**
 * Agentes: ninguna pagina real todavia (el Copiloto, el Panel de agentes y los agentes extractor,
 * conciliacion y WhatsApp estan en `PENDIENTES`). Las palancas por agente viven hoy en Interruptores
 * (Sistema).
 */
export const AGENTES: readonly RutaSuperadmin[] = [];

export const NEGOCIO: readonly RutaSuperadmin[] = [
  { to: "/superadmin/acciones", label: "Acciones", icon: ListChecks },
  { to: "/superadmin/prospectos", label: "Prospectos", icon: TrendingUp },
  { to: "/superadmin/organizaciones", label: "Organizaciones", icon: Building2 },
  { to: "/superadmin/gestion-organizaciones", label: "Gestión de organizaciones", icon: Building2 },
  { to: "/superadmin/costos-margen", label: "Costos y margen", icon: Coins },
  { to: "/superadmin/pyl", label: "P&L por vertical", icon: ReceiptText },
  { to: "/superadmin/contratos", label: "Contratos por cliente", icon: FileSignature },
  { to: "/superadmin/facturacion", label: "Facturación", icon: Receipt },
  { to: "/superadmin/gasto-api", label: "Gasto de API de LLM", icon: DollarSign },
  { to: "/superadmin/cfo", label: "Dashboard CFO", icon: LineChart },
];

export const PLATAFORMA: readonly RutaSuperadmin[] = [{ to: "/superadmin/integraciones", label: "Integraciones", icon: Plug }];

export const CONTROL: readonly RutaSuperadmin[] = [
  { to: "/superadmin/seguridad", label: "Seguridad (MFA)", icon: KeyRound },
  { to: "/superadmin/impersonacion", label: "Impersonación", icon: ShieldAlert },
  { to: "/superadmin/break-glass", label: "Romper cristal", icon: AlertOctagon },
  { to: "/superadmin/auditoria-denegaciones", label: "Auditoría de denegaciones", icon: ShieldOff },
  { to: "/superadmin/privacidad", label: "Privacidad", icon: Lock },
  { to: "/superadmin/supresion", label: "Supresión de contactos", icon: BellOff },
  { to: "/superadmin/zona-cfo", label: "Zona CFO segura", icon: ShieldCheck },
  { to: "/superadmin/planes", label: "Planes y precios", icon: Tags },
];

export const SISTEMA: readonly RutaSuperadmin[] = [
  { to: "/superadmin/interruptores", label: "Interruptores", icon: Power },
  { to: "/superadmin/salud", label: "Salud operativa", icon: Activity },
];

/** Las cinco secciones con el rotulo y el orden de Likida. Una seccion sin paginas reales no se pinta. */
export const SECCIONES: readonly SeccionSuperadmin[] = [
  { title: "Agentes", items: AGENTES },
  { title: "Negocio", items: NEGOCIO },
  { title: "Plataforma", items: PLATAFORMA },
  { title: "Control", items: CONTROL },
  { title: "Sistema", items: SISTEMA },
].filter((s) => s.items.length > 0);

/** Lista plana con Resumen primero (la usaran la paleta, el rail y la rejilla del Resumen). */
export const TODAS_LAS_RUTAS: readonly RutaSuperadmin[] = [RESUMEN, ...SECCIONES.flatMap((s) => s.items)];

/**
 * Pie fijo del sidebar. Cada pildora lleva a una pagina real: "Costos de IA" abre el gasto real de LLM
 * (`Gasto de API de LLM`) y "Ver los otros paneles" el selector de paneles (`Paneles.tsx`).
 */
export const PIE_SUPERADMIN = [
  { label: "Costos de IA", to: "/superadmin/gasto-api" },
  { label: "Ver los otros paneles", to: "/superadmin/paneles", icon: ArrowLeftRight },
] as const;

/** Barra inferior movil: destinos de uso diario; el 5.o lugar es "Mas" (lo agrega el shell). */
export const MOVIL_SUPERADMIN: readonly RutaSuperadmin[] = [
  { to: "/superadmin", label: "Resumen", icon: Newspaper, end: true },
  { to: "/superadmin/organizaciones", label: "Orgs", icon: Building2 },
  { to: "/superadmin/salud", label: "Salud", icon: Activity },
  { to: "/superadmin/acciones", label: "Acciones", icon: ListChecks },
];

/** Rutas web que cambiaron de lugar: la vieja redirige a la nueva (sin 404). */
export const REDIRECCIONES_SUPERADMIN: Readonly<Record<string, string>> = {
  "/superadmin/resumen": "/superadmin",
};

export interface PendienteSuperadmin {
  readonly seccion: "Agentes" | "Negocio" | "Plataforma" | "Control" | "Sistema";
  readonly label: string;
  /** Ruta propuesta por la paridad con Likida; NO existe todavia como pagina. */
  readonly ruta: string;
  /** Ticket del tablero que la cierra (o el motivo si depende de credenciales). */
  readonly ticket: string;
}

/**
 * Paginas del menu objetivo de Likida que aun NO existen. Honestas: ninguna se pinta en el menu ni se
 * maqueta. Cuando una pagina se construye, se mueve de aqui a su seccion de `SECCIONES`.
 */
export const PENDIENTES: readonly PendienteSuperadmin[] = [
  { seccion: "Agentes", label: "Copiloto", ruta: "/superadmin/copiloto", ticket: "SA-33/SA-34 (paridad2 §3)" },
  { seccion: "Agentes", label: "Panel de agentes", ruta: "/superadmin/agentes", ticket: "paridad2 §2.2" },
  { seccion: "Agentes", label: "Agente extractor de documentos", ruta: "/superadmin/agente-extractor", ticket: "paridad2 §2.2" },
  { seccion: "Agentes", label: "Agente de conciliación", ruta: "/superadmin/agente-conciliacion", ticket: "paridad2 §2.2" },
  { seccion: "Agentes", label: "Agente de WhatsApp y voz", ruta: "/superadmin/agente-whatsapp", ticket: "paridad2 §2.2" },
  { seccion: "Agentes", label: "Model Ops", ruta: "/superadmin/model-ops", ticket: "paridad2 §4" },
  { seccion: "Agentes", label: "Evals", ruta: "/superadmin/evals", ticket: "paridad2 §4" },
  { seccion: "Agentes", label: "Playground", ruta: "/superadmin/playground", ticket: "paridad2 §4" },
  { seccion: "Agentes", label: "QA autónomo", ruta: "/superadmin/qa", ticket: "paridad2 §4" },
  { seccion: "Negocio", label: "Tu turno", ruta: "/superadmin/tu-turno", ticket: "paridad2 §2.3" },
  { seccion: "Negocio", label: "Escalaciones", ruta: "/superadmin/escalaciones", ticket: "SA-16" },
  { seccion: "Negocio", label: "Aprobaciones", ruta: "/superadmin/aprobaciones", ticket: "paridad2 §6" },
  { seccion: "Negocio", label: "Vendedores", ruta: "/superadmin/vendedores", ticket: "paridad2 §2.3 (no existe el rol vendedor)" },
  { seccion: "Negocio", label: "Conversaciones", ruta: "/superadmin/conversaciones", ticket: "paridad2 §2.3" },
  { seccion: "Negocio", label: "Analítica & Stats", ruta: "/superadmin/analitica", ticket: "paridad2 §2.3 (usa el kit de gráficas SA-L-03)" },
  { seccion: "Negocio", label: "Cobranza", ruta: "/superadmin/cobranza", ticket: "SA-09" },
  { seccion: "Negocio", label: "Crecimiento", ruta: "/superadmin/crecimiento", ticket: "SA-25 / SA-08" },
  { seccion: "Negocio", label: "Estudio de marketing", ruta: "/superadmin/marketing", ticket: "paridad2 §2.3" },
  { seccion: "Negocio", label: "Nuevo usuario", ruta: "/superadmin/usuarios/nuevo", ticket: "paridad2 §2.3" },
  { seccion: "Plataforma", label: "WhatsApp Infra", ruta: "/superadmin/whatsapp-infra", ticket: "paridad2 §2.4" },
  { seccion: "Plataforma", label: "Conocimiento / RAG", ruta: "/superadmin/conocimiento", ticket: "PL-26" },
  { seccion: "Plataforma", label: "Comunicación", ruta: "/superadmin/comunicacion", ticket: "PL-34" },
  { seccion: "Control", label: "Equipo", ruta: "/superadmin/equipo", ticket: "SA-23" },
  { seccion: "Sistema", label: "Relojes", ruta: "/superadmin/relojes", ticket: "paridad2 §2.6" },
  { seccion: "Sistema", label: "Calidad & Evals", ruta: "/superadmin/calidad", ticket: "paridad2 §4" },
  { seccion: "Sistema", label: "Actividad de código", ruta: "/superadmin/actividad-codigo", ticket: "requiere GITHUB_TOKEN" },
  { seccion: "Sistema", label: "Soporte", ruta: "/superadmin/soporte", ticket: "SA-16" },
  { seccion: "Sistema", label: "Capacidad & Forecast", ruta: "/superadmin/capacidad", ticket: "SA-25" },
];
