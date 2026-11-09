// Organizaciones / Clientes (SA-L-20): la composicion de "Flotas / Clientes" de Likida con los colores de Atiende.
//   * odometro con el total de organizaciones;
//   * DataTable: Organizacion, Vertical, Estado, Plan, Operaciones y Costo de IA a 30 dias, Margen del mes, Onboarding x/y, "Entrar" y "Ficha";
//   * HBars "Top por costo de IA" (30 dias);
//   * pestana "Gestion": el GestionOrganizaciones de siempre (alta, suspender, reactivar, plan; doble control y step-up intactos).
// Cada cifra sale de un endpoint real (GET /superadmin/organizaciones/resumen y /margen; apps/api/src/routes/superadmin-organizaciones-ficha.ts).
// Un dato que no se pudo medir se pinta "—" con su razon, nunca 0. El margen es de la zona CFO (step-up y bitacora): se pide APARTE y, si se
// rechaza, solo esa columna queda en blanco. Base sin la migracion 0052: aviso honesto y las columnas nuevas en "—".
// Un solo <h1> (PageHeader). La barra de pagina (icono + nombre) la pone el shell.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DoorOpen, FileText } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  HBars,
  Odometro,
  PageContainer,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  statusTone,
  useT,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { comun } from "@atiende/ui/i18n/comun";
import { superadminComun } from "@atiende/ui/i18n/superadmin/comun";
import { superadminOrganizaciones } from "@atiende/ui/i18n/superadmin/organizaciones";
import { fetchJson } from "../lib/fetch-json.ts";
import { ORG_STATUS_TONES } from "../lib/status-tones.ts";
import { NOMBRE_ESTADO_ORG, NOMBRE_VERTICAL, entero, mxn, usd } from "../lib/organizaciones.ts";
import type { CampoOrg, FilaOrganizacion, MargenOrg, RespuestaMargen, RespuestaResumen } from "../lib/organizaciones.ts";
import { useEntrarOrganizacion } from "../components/EntrarOrganizacion.tsx";
import { SuperAdminGestionOrganizacionesPage } from "./GestionOrganizaciones.tsx";

type Carga<T> = { readonly estado: "cargando" } | { readonly estado: "error"; readonly mensaje: string } | { readonly estado: "ok"; readonly data: T };

/** Celda de un dato medible: la cifra, o "—" con la razon en el tooltip y como texto accesible. */
export function CeldaCampo<T>({ campo, formato }: { readonly campo: CampoOrg<T> | undefined; readonly formato: (v: T) => string }) {
  const t = useT(superadminComun);
  if (!campo) return <span className="text-muted-foreground">—</span>;
  if (campo.valor === null) {
    return (
      <span className="text-muted-foreground" title={campo.razon ?? undefined}>
        —<span className="sr-only"> {campo.razon ?? t("superadmin.comun.sinDato")}</span>
      </span>
    );
  }
  return <span className="tabular-nums">{formato(campo.valor)}</span>;
}

export function SuperAdminOrganizacionesPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const t = useT(comun, superadminComun, superadminOrganizaciones);
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "gestion" ? "gestion" : "clientes";
  const [resumen, setResumen] = useState<Carga<RespuestaResumen>>({ estado: "cargando" });
  const [margen, setMargen] = useState<Carga<RespuestaMargen>>({ estado: "cargando" });
  const { entrar, dialogo } = useEntrarOrganizacion(apiBaseUrl, token);

  const cargar = useCallback(async () => {
    setResumen({ estado: "cargando" });
    setMargen({ estado: "cargando" });
    // Cada fuente por separado: el rechazo del step-up del margen no tumba la tabla.
    const pedirResumen = fetchJson<RespuestaResumen>(apiBaseUrl, token, "/superadmin/organizaciones/resumen")
      .then((data) => setResumen({ estado: "ok", data }))
      .catch(() => setResumen({ estado: "error", mensaje: t("superadmin.comun.error.organizaciones") }));
    const pedirMargen = fetchJson<RespuestaMargen>(apiBaseUrl, token, "/superadmin/organizaciones/margen")
      .then((data) => setMargen({ estado: "ok", data }))
      .catch((err: unknown) => setMargen({ estado: "error", mensaje: err instanceof Error ? err.message : t("superadmin.comun.error.margen") }));
    await Promise.all([pedirResumen, pedirMargen]);
    // Sin `t` en las dependencias: cambiar de idioma no debe volver a pedir los datos (el mensaje de error es de esta carga).
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const filas = resumen.estado === "ok" ? resumen.data.organizaciones : [];
  const margenDe = (id: string): CampoOrg<MargenOrg> | undefined => {
    if (margen.estado === "ok") return margen.data.margenes[id] ?? { valor: null, razon: margen.data.mensaje ?? t("superadmin.comun.sinMargen") };
    if (margen.estado === "error") return { valor: null, razon: margen.mensaje };
    return undefined;
  };

  const topCosto = useMemo(
    () =>
      filas
        .filter((f) => f.costoIa30dUsd.valor !== null && f.costoIa30dUsd.valor > 0)
        .sort((a, b) => (b.costoIa30dUsd.valor ?? 0) - (a.costoIa30dUsd.valor ?? 0))
        .slice(0, 6)
        .map((f) => ({ etiqueta: f.nombre, valor: f.costoIa30dUsd.valor ?? 0 })),
    [filas],
  );

  const columnas: readonly DataTableColumna<FilaOrganizacion>[] = [
    {
      id: "organizacion",
      encabezado: t("superadmin.comun.col.organizacion"),
      principal: true,
      valorOrden: (f) => f.nombre,
      celda: (f) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-foreground">{f.nombre}</span>
          <span className="block truncate text-xs text-muted-foreground">{f.slug}</span>
        </span>
      ),
    },
    { id: "vertical", encabezado: t("superadmin.comun.col.vertical"), valorOrden: (f) => NOMBRE_VERTICAL[f.vertical] ?? f.vertical, celda: (f) => NOMBRE_VERTICAL[f.vertical] ?? f.vertical },
    {
      id: "estado",
      encabezado: t("superadmin.comun.col.estado"),
      valorOrden: (f) => f.estado,
      celda: (f) => <StatusBadge tone={statusTone(ORG_STATUS_TONES, f.estado)}>{NOMBRE_ESTADO_ORG[f.estado] ?? f.estado}</StatusBadge>,
    },
    { id: "plan", encabezado: t("superadmin.comun.col.plan"), valorOrden: (f) => f.plan.valor?.nombre ?? null, celda: (f) => <CeldaCampo campo={f.plan} formato={(p) => p.nombre} /> },
    {
      id: "operaciones",
      encabezado: t("superadmin.organizaciones.col.operaciones"),
      alinear: "right",
      valorOrden: (f) => f.operaciones30d.valor,
      celda: (f) => <CeldaCampo campo={f.operaciones30d} formato={entero} />,
    },
    {
      id: "costoIa",
      encabezado: t("superadmin.organizaciones.col.costoIa"),
      alinear: "right",
      valorOrden: (f) => f.costoIa30dUsd.valor,
      celda: (f) => <CeldaCampo campo={f.costoIa30dUsd} formato={usd} />,
    },
    {
      id: "margen",
      encabezado: t("superadmin.organizaciones.col.margen"),
      alinear: "right",
      valorOrden: (f) => margenDe(f.id)?.valor?.mxn ?? null,
      celda: (f) => <CeldaCampo campo={margenDe(f.id)} formato={(m) => `${mxn(m.mxn)} · ${Math.round(m.pct)}%`} />,
    },
    {
      id: "onboarding",
      encabezado: t("superadmin.organizaciones.col.onboarding"),
      alinear: "right",
      valorOrden: (f) => (f.onboarding.valor && f.onboarding.valor.total > 0 ? f.onboarding.valor.hechos / f.onboarding.valor.total : null),
      celda: (f) => (
        <CeldaCampo
          campo={f.onboarding}
          formato={(o) => `${o.hechos}/${o.total}${o.noMedibles > 0 ? ` ${t("superadmin.organizaciones.sinMedir", { n: String(o.noMedibles) })}` : ""}`}
        />
      ),
    },
    {
      id: "acciones",
      encabezado: t("superadmin.organizaciones.col.acciones"),
      etiqueta: t("superadmin.organizaciones.col.acciones"),
      alinear: "right",
      ocultarEnTarjeta: false,
      celda: (f) => (
        <span className="inline-flex items-center justify-end gap-1.5">
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => entrar({ id: f.id, nombre: f.nombre })}>
            <DoorOpen className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            {t("superadmin.comun.entrar")}
            <span className="sr-only"> {t("superadmin.comun.srA", { nombre: f.nombre })}</span>
          </Button>
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to={`/superadmin/organizaciones/${f.id}`}>
              <FileText className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              {t("superadmin.organizaciones.ficha")}
              <span className="sr-only"> {t("superadmin.organizaciones.srDe", { nombre: f.nombre })}</span>
            </Link>
          </Button>
        </span>
      ),
    },
  ];

  const total = resumen.estado === "ok" ? resumen.data.organizaciones.length : null;
  const noDisponible = resumen.estado === "ok" && !resumen.data.disponible;

  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <PageHeader
        titulo={t("superadmin.comun.organizaciones")}
        descripcion={t("superadmin.organizaciones.descripcion")}
        acciones={<Odometro valor={total} digitos={3} etiqueta={t("superadmin.organizaciones.odometro")} sinDato={resumen.estado === "error" ? resumen.mensaje : t("comun.cargando")} tamano="md" />}
      />
      {total !== null && (
        <p className="text-ui text-muted-foreground sm:hidden">
          {t("superadmin.comun.organizaciones")} <span className="font-medium tabular-nums text-foreground">{total}</span>
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setParams(v === "gestion" ? { tab: "gestion" } : {}, { replace: true })} className="grid gap-2.5">
        <TabsList aria-label={t("superadmin.organizaciones.tabs")}>
          <TabsTrigger value="clientes">{t("superadmin.organizaciones.tab.clientes")}</TabsTrigger>
          <TabsTrigger value="gestion">{t("superadmin.organizaciones.tab.gestion")}</TabsTrigger>
        </TabsList>

        <TabsContent value="clientes" className="mt-0 grid gap-2.5">
          {noDisponible && (
            <Callout tone="warning" role="status">
              {resumen.data.mensaje ?? t("superadmin.organizaciones.metricasNoDisponibles")} {t("superadmin.organizaciones.listaCompleta")}
            </Callout>
          )}
          {margen.estado === "ok" && !margen.data.disponible && (
            <Callout tone="info" role="status">
              {margen.data.mensaje ?? t("superadmin.organizaciones.margenNoDisponibleAun")}
            </Callout>
          )}
          {margen.estado === "error" && (
            <Callout tone="info" role="status">
              {t("superadmin.organizaciones.margenNoDisponible", { mensaje: margen.mensaje })}
            </Callout>
          )}

          <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>{t("superadmin.organizaciones.todas")}</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable
                  etiqueta={t("superadmin.comun.organizaciones")}
                  columnas={columnas}
                  filas={filas}
                  obtenerId={(f) => f.id}
                  estado={resumen.estado === "cargando" ? "loading" : resumen.estado === "error" ? "error" : filas.length === 0 ? "empty" : "ok"}
                  vacio={{ mensaje: t("superadmin.organizaciones.vacio") }}
                  error={{ mensaje: resumen.estado === "error" ? resumen.mensaje : undefined, onReintentar: () => void cargar() }}
                  atributosFila={(f) => ({ "data-org-id": f.id })}
                  paginacion={{ tamano: 10 }}
                />
              </CardContent>
            </Card>

            <Card className="min-w-0 self-start">
              <CardHeader>
                <CardTitle>{t("superadmin.organizaciones.top")}</CardTitle>
              </CardHeader>
              <CardContent>
                {resumen.estado === "cargando" ? (
                  <p className="text-ui text-muted-foreground">{t("comun.cargando")}</p>
                ) : (
                  <HBars datos={topCosto} formato="usd" sinDatos={noDisponible ? t("superadmin.organizaciones.top.sinMetricas") : t("superadmin.organizaciones.top.sinCosto")} />
                )}
                <p className="mt-3 text-xs text-faint">{t("superadmin.organizaciones.top.nota")}</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="gestion" className="mt-0">
          <SuperAdminGestionOrganizacionesPage apiBaseUrl={apiBaseUrl} token={token} embebida />
        </TabsContent>
      </Tabs>
      {dialogo}
    </PageContainer>
  );
}

