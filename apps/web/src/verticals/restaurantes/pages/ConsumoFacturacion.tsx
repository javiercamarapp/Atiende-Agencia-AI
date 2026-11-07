// «Consumo y facturación» (restaurantes, owner/admin): uso del mes contra la bolsa del plan, factura proyectada al cierre con
// rango, desglose por sucursal e historial. Backend real: GET /billing/consumo (apps/api/src/routes/cobro-consumo.ts); un
// miembro sin permiso recibe 403 y la base decide la autoridad. Sin migraciones o sin plan medido: estado honesto, nunca cifras
// inventadas. Textos en el modulo de area `@atiende/ui/i18n/consumo` (carga perezosa).
import { useCallback, useEffect, useState } from "react";
import { Receipt } from "lucide-react";
import { Card, EstadoCargando, EstadoError, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useT, useTituloBarra } from "@atiende/ui";
import { consumo } from "@atiende/ui/i18n/consumo";
import { useFormatos } from "@atiende/ui/i18n/formato";
import { BarraProgreso } from "../../../components/BarraProgreso.tsx";

interface Factura {
  readonly subtotalMxn: number;
  readonly ivaMxn: number;
  readonly totalMxn: number;
}
interface Bolsa {
  readonly incluido: number;
  readonly usado: number;
  readonly porcentaje: number | null;
}
interface Consumo {
  readonly disponible: true;
  readonly mes: string;
  readonly zonaHoraria: string;
  readonly plan: { readonly nombre: string } | null;
  readonly totales: { readonly llamadas: number; readonly minutosVoz: number; readonly duracionPromedioS: number | null; readonly conversacionesWa: number; readonly pedidosAgentes: number };
  readonly bolsa: { readonly voz: Bolsa; readonly whatsapp: Bolsa } | null;
  readonly facturaAlCorte: Factura | null;
  readonly proyeccion: { readonly diasDelMes: number; readonly diasTranscurridos: number; readonly rangoConfiable: boolean; readonly factura: { readonly bajo: Factura; readonly central: Factura; readonly alto: Factura } | null };
  readonly sucursales: ReadonlyArray<{ readonly propertyId: string; readonly nombre: string; readonly llamadas: number; readonly minutosVoz: number; readonly duracionPromedioS: number | null; readonly pedidosAgentes: number }>;
  readonly historial: ReadonlyArray<{ readonly mes: string; readonly llamadas: number; readonly minutosVoz: number; readonly conversacionesWa: number }>;
}

type Fase = { fase: "cargando" } | { fase: "error"; mensaje: string } | { fase: "no-disponible"; mensaje: string } | { fase: "listo"; datos: Consumo };

export function ConsumoFacturacion({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const t = useT(consumo);
  const f = useFormatos();
  useTituloBarra(t("consumo.titulo"), Receipt);
  const [estado, setEstado] = useState<Fase>({ fase: "cargando" });

  const cargar = useCallback(async () => {
    setEstado({ fase: "cargando" });
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/billing/consumo`, { headers: { authorization: `Bearer ${token}` } });
      const body = (await res.json().catch(() => ({}))) as { disponible?: boolean; motivo?: string; message?: string };
      if (!res.ok) return setEstado({ fase: "error", mensaje: body.message ?? t("consumo.errorCarga") });
      if (!body.disponible) return setEstado({ fase: "no-disponible", mensaje: body.motivo ?? "" });
      setEstado({ fase: "listo", datos: body as Consumo });
    } catch {
      setEstado({ fase: "error", mensaje: t("consumo.errorCarga") });
    }
  }, [apiBaseUrl, token, t]);

  useEffect(() => {
    if (token !== "") void cargar();
  }, [cargar, token]);

  if (estado.fase === "cargando") return <EstadoCargando variante="tarjeta" etiqueta={t("consumo.titulo")} />;
  if (estado.fase === "error") return <EstadoError titulo={t("consumo.errorCarga")} mensaje={estado.mensaje} onReintentar={() => void cargar()} compacto />;
  if (estado.fase === "no-disponible") {
    return (
      <Card className="p-4">
        <p className="text-ui font-medium">{t("consumo.noDisponible")}</p>
        <p className="mt-1 text-eyebrow text-muted-foreground">{estado.mensaje}</p>
      </Card>
    );
  }
  const d = estado.datos;
  const kpis: Array<[string, string]> = [
    [t("consumo.llamadas"), f.numero(d.totales.llamadas)],
    [t("consumo.minutos"), f.numero(d.totales.minutosVoz)],
    [t("consumo.duracion"), d.totales.duracionPromedioS === null ? "—" : t("consumo.duracionValor", { minutos: f.numero(d.totales.duracionPromedioS / 60, { maximumFractionDigits: 1 }) })],
    [t("consumo.conversaciones"), f.numero(d.totales.conversacionesWa)],
    [t("consumo.pedidos"), f.numero(d.totales.pedidosAgentes)],
  ];
  const pf = d.proyeccion.factura;
  const maxPct = Math.max(d.bolsa?.voz.porcentaje ?? 0, d.bolsa?.whatsapp.porcentaje ?? 0);
  return (
    <div className="space-y-3">
      <p className="text-eyebrow text-faint">{t("consumo.intro")}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="consumo-kpis">
        {kpis.map(([k, v]) => (
          <Card key={k} className="p-3">
            <p className="text-eyebrow text-muted-foreground">{k}</p>
            <p className="mt-1 text-ui font-medium">{v}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4" data-testid="consumo-bolsa">
        <p className="text-ui font-medium">{t("consumo.bolsa")}{d.plan ? ` · ${d.plan.nombre}` : ""}</p>
        {!d.bolsa ? (
          <p className="mt-1 text-eyebrow text-muted-foreground">{t("consumo.sinPlan")}</p>
        ) : (
          <div className="mt-2 space-y-2">
            {d.bolsa.voz.incluido > 0 && (
              <div>
                <p className="text-eyebrow">{t("consumo.bolsaVoz", { usado: f.numero(d.bolsa.voz.usado), incluido: f.numero(d.bolsa.voz.incluido), pct: d.bolsa.voz.porcentaje ?? 0 })}</p>
                <BarraProgreso valor={Math.min(d.bolsa.voz.porcentaje ?? 0, 100)} tono={(d.bolsa.voz.porcentaje ?? 0) >= 100 ? "danger" : (d.bolsa.voz.porcentaje ?? 0) >= 80 ? "warning" : "primary"} className="mt-1" aria-label={t("consumo.minutos")} />
              </div>
            )}
            {d.bolsa.whatsapp.incluido > 0 && (
              <div>
                <p className="text-eyebrow">{t("consumo.bolsaWa", { usado: f.numero(d.bolsa.whatsapp.usado), incluido: f.numero(d.bolsa.whatsapp.incluido), pct: d.bolsa.whatsapp.porcentaje ?? 0 })}</p>
                <BarraProgreso valor={Math.min(d.bolsa.whatsapp.porcentaje ?? 0, 100)} tono={(d.bolsa.whatsapp.porcentaje ?? 0) >= 100 ? "danger" : (d.bolsa.whatsapp.porcentaje ?? 0) >= 80 ? "warning" : "primary"} className="mt-1" aria-label={t("consumo.conversaciones")} />
              </div>
            )}
            {maxPct >= 100 ? <p className="text-eyebrow text-destructive">{t("consumo.aviso100")}</p> : maxPct >= 80 ? <p className="text-eyebrow text-warning">{t("consumo.aviso80")}</p> : null}
          </div>
        )}
      </Card>

      {pf && (
        <Card className="p-4" data-testid="consumo-proyeccion">
          <p className="text-ui font-medium">{t("consumo.proyeccion")}</p>
          <p className="mt-1 text-ui">
            {d.proyeccion.rangoConfiable
              ? t("consumo.proyeccionRango", { bajo: f.moneda(pf.bajo.subtotalMxn), alto: f.moneda(pf.alto.subtotalMxn), central: f.moneda(pf.central.subtotalMxn) })
              : t("consumo.proyeccionSinRango", { central: f.moneda(pf.central.subtotalMxn) })}
          </p>
          <p className="mt-1 text-eyebrow text-faint">{t("consumo.proyeccionNota", { dias: d.proyeccion.diasTranscurridos, total: d.proyeccion.diasDelMes })}</p>
          {d.facturaAlCorte && <p className="mt-1 text-eyebrow text-muted-foreground">{t("consumo.facturaCorte", { subtotal: f.moneda(d.facturaAlCorte.subtotalMxn), iva: f.moneda(d.facturaAlCorte.ivaMxn), total: f.moneda(d.facturaAlCorte.totalMxn) })}</p>}
        </Card>
      )}

      <Card className="p-4" data-testid="consumo-sucursales">
        <p className="text-ui font-medium">{t("consumo.sucursales")}</p>
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>{t("consumo.sucursal")}</TableHead>
              <TableHead className="text-right">{t("consumo.llamadas")}</TableHead>
              <TableHead className="text-right">{t("consumo.minutos")}</TableHead>
              <TableHead className="text-right">{t("consumo.duracion")}</TableHead>
              <TableHead className="text-right">{t("consumo.pedidos")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.sucursales.map((s) => (
              <TableRow key={s.propertyId}>
                <TableCell>{s.nombre}</TableCell>
                <TableCell className="text-right">{f.numero(s.llamadas)}</TableCell>
                <TableCell className="text-right">{f.numero(s.minutosVoz)}</TableCell>
                <TableCell className="text-right">{s.duracionPromedioS === null ? "—" : f.numero(s.duracionPromedioS / 60, { maximumFractionDigits: 1 })}</TableCell>
                <TableCell className="text-right">{f.numero(s.pedidosAgentes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-2 text-eyebrow text-faint">{t("consumo.waNoDesglosa")}</p>
      </Card>

      {d.historial.length > 0 && (
        <Card className="p-4" data-testid="consumo-historial">
          <p className="text-ui font-medium">{t("consumo.historial")}</p>
          <Table className="mt-2">
            <TableHeader>
              <TableRow>
                <TableHead>{t("consumo.mes")}</TableHead>
                <TableHead className="text-right">{t("consumo.llamadas")}</TableHead>
                <TableHead className="text-right">{t("consumo.minutos")}</TableHead>
                <TableHead className="text-right">{t("consumo.conversaciones")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.historial.map((h) => (
                <TableRow key={h.mes}>
                  <TableCell>{f.fecha(`${h.mes}T12:00:00`, "mesAnio")}</TableCell>
                  <TableCell className="text-right">{f.numero(h.llamadas)}</TableCell>
                  <TableCell className="text-right">{f.numero(h.minutosVoz)}</TableCell>
                  <TableCell className="text-right">{f.numero(h.conversacionesWa)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
