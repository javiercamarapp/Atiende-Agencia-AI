// Tipos y helpers compartidos por la tabla de Organizaciones (SA-L-20) y la Ficha 360 (SA-07). La forma es la de
// apps/api/src/routes/superadmin-organizaciones-ficha.ts: un dato que no se pudo medir llega como `{ valor: null, razon }` y se
// pinta "—" con su razon, nunca como 0.
import { formatMoney } from "@atiende/ui";

export interface CampoOrg<T> {
  readonly valor: T | null;
  readonly razon: string | null;
}

export interface MargenOrg {
  readonly mxn: number;
  readonly pct: number;
  readonly ingresoMxn: number;
}

export interface FilaOrganizacion {
  readonly id: string;
  readonly nombre: string;
  readonly slug: string;
  readonly vertical: string;
  readonly estado: "trial" | "active" | "suspended";
  readonly creadaEn: string;
  readonly staff: number;
  readonly plan: CampoOrg<{ readonly id: string; readonly nombre: string }>;
  readonly operaciones30d: CampoOrg<number>;
  readonly costoIa30dUsd: CampoOrg<number>;
  readonly onboarding: CampoOrg<{ readonly hechos: number; readonly total: number; readonly noMedibles: number }>;
}

export interface RespuestaResumen {
  readonly disponible: boolean;
  readonly mensaje: string | null;
  readonly ventanaDias: number;
  readonly organizaciones: readonly FilaOrganizacion[];
}

export interface RespuestaMargen {
  readonly disponible: boolean;
  readonly mes: string;
  readonly mensaje: string | null;
  readonly margenes: Readonly<Record<string, CampoOrg<MargenOrg>>>;
}

export type EstadoPasoOnboarding = "hecho" | "pendiente" | "no_se_pudo_medir";

export interface PasoOnboardingFicha {
  readonly paso: string;
  readonly titulo: string;
  readonly estado: EstadoPasoOnboarding;
  readonly razon: string | null;
  readonly razonTexto: string | null;
}

export interface FichaOrganizacion {
  readonly disponible: true;
  readonly mes: string;
  readonly organizacion: { readonly id: string; readonly nombre: string; readonly slug: string; readonly vertical: string; readonly estado: "trial" | "active" | "suspended"; readonly creadaEn: string };
  readonly uso: { readonly operaciones30d: CampoOrg<number>; readonly conversaciones30d: CampoOrg<number>; readonly minutosVoz30d: CampoOrg<number> };
  readonly costo: { readonly llm30dUsd: CampoOrg<number>; readonly eventos30dUsd: CampoOrg<number>; readonly costoPorEventoUsd: CampoOrg<number> };
  readonly membresias: {
    readonly porRol: readonly { readonly rol: string; readonly cantidad: number }[];
    readonly ultimosAccesos: CampoOrg<readonly { readonly rol: string; readonly ultimoAcceso: string | null }[]>;
  };
  readonly errores: {
    readonly outboxMuerto: CampoOrg<number>;
    readonly denegaciones30d: CampoOrg<number> & { readonly ultimas: readonly { readonly ruta: string; readonly motivo: string | null; readonly cuando: string }[] };
    readonly crons: CampoOrg<number>;
  };
  readonly facturacion: {
    readonly plan: { readonly id: string; readonly nombre: string } | null;
    readonly cobro: { readonly estado: string; readonly periodoHasta: string | null; readonly asientos: number } | null;
    readonly contrato: { readonly contractId: string; readonly version: number | null } | null;
  };
  readonly onboarding: readonly PasoOnboardingFicha[];
}

export interface FichaNoDisponible {
  readonly disponible: false;
  readonly mensaje: string;
  readonly organizacion: { readonly id: string; readonly nombre: string; readonly slug: string; readonly vertical: string; readonly estado: "trial" | "active" | "suspended"; readonly creadaEn: string };
}

export const NOMBRE_VERTICAL: Readonly<Record<string, string>> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
};

export const NOMBRE_ESTADO_ORG: Readonly<Record<string, string>> = { active: "Activa", suspended: "Suspendida", trial: "Prueba" };

export const NOMBRE_ESTADO_PASO: Readonly<Record<EstadoPasoOnboarding, string>> = { hecho: "Hecho", pendiente: "Pendiente", no_se_pudo_medir: "No se pudo medir" };

/** Motivo minimo de una sesion de impersonacion (igual que la base: core.impersonation_session.reason). */
export const MOTIVO_IMPERSONACION_MINIMO = 20;

export const usd = (v: number): string => `US$${formatMoney(v, 2)}`;
export const mxn = (v: number): string => `$${formatMoney(v, 0)}`;
export const entero = (v: number): string => formatMoney(v, 0);
