// Cotizador + configuración de pricing (Fase 14) — cierra el hallazgo de auditoría
// "Cotizador y configuración de pricing (6 endpoints) sin UI": GET .../cotizacion
// (R2) y los 5 POST de pricing-config.ts (Fase 2) ya existían en el backend, pero
// ninguna página de apps/web los invocaba -- el admin_gestora no podía configurar
// precios desde el producto (Dashboard.tsx lo decía explícitamente, ver su línea
// "El cotizador y el panel de finanzas de rentas todavía no tienen UI").
//
// Dos secciones, mismo patrón de "unidad seleccionada -> panel" que Calendario.tsx:
//  1. Cotizador -- fechas + canal opcional -> GET cotización. Disponible para
//     CUALQUIER staff con acceso a la property (igual que el backend:
//     cotizaciones.ts no exige `PRICING_ESCRITURA_ROLES`, solo
//     `requirePropertyMembership`).
//  2. Configuración de pricing -- los 5 POST, gateados en el CLIENTE por
//     `PRICING_ESCRITURA_ROLES = ["admin_gestora"]` (packages/domain-rentas/src/
//     roles.ts) para no mostrarle a un operador un formulario que el servidor
//     rechazaría con 403 igual -- el servidor SIEMPRE re-valida vía
//     `assertVerticalRole` (pricing-config.ts), este gate es solo UX. Rol resuelto
//     de `session.organizations` (misma fuente que Dashboard.tsx ya usa para
//     mostrar "rol <strong>{org.rol}</strong>").
//
// Límite real, documentado también en pricing-client.ts: pricing-config.ts NUNCA
// expuso un GET que liste la configuración ya guardada (solo los 5 POST) -- por
// eso cada sub-formulario muestra "Configurado en esta sesión" en vez de un
// historial persistente; recargar la página pierde esa lista local (los datos en
// el servidor NO se pierden, solo la vista de "qué acabo de crear").
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Button/Input/
// Label/Badge/Table/EstadoError + clases de token en vez de los `style={{...}}`
// hechos a mano. CERO cambios de lógica: mismos submits, mismas validaciones
// locales, mismas ramas de render, mismos gates de rol.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertTriangle, Calculator } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoError,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import {
  basisPointsAPorcentaje,
  CANALES_CON_MARKUP,
  centavosAPesos,
  crearDescuentoDuracion,
  crearReglaCanal,
  crearReglaMinStay,
  crearTarifaBase,
  crearTemporada,
  fetchCotizacion,
  fetchUnidades,
  pesosACentavos,
  porcentajeABasisPoints,
  TODOS_LOS_CANALES,
} from "../lib/pricing-client.ts";
import type {
  DescuentoDuracionCreado,
  MinStayCreada,
  ReglaCanalCreada,
  ResultadoCotizacion,
  TarifaBaseCreada,
  TemporadaCreada,
  UnidadOption,
} from "../lib/pricing-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const PRICING_ESCRITURA_ROLES = new Set(["admin_gestora"]);

/** Mismos tokens que el <Input> de @atiende/ui aplicados al <select> nativo: todos
 * los selectores de esta pantalla son dropdowns de datos reales (unidad con su
 * estado `<option>Cargando…</option>`, canal, día de la semana) -- se quedan nativos
 * y solo se re-estilan. */
const SELECT_CLASES =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASES = "flex flex-col gap-1.5 text-[13px] text-foreground";
const NOTA_CLASES = "m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground";

const DIA_SEMANA_LABELS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

export function PreciosPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeEscribir = org ? PRICING_ESCRITURA_ROLES.has(org.rol) : false;

  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setUnidades(list);
        setUnidadId((current) => current || list[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las unidades de esta propiedad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  if (unidades && unidades.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Precios</h1>
        <EstadoError titulo="Sin unidades" mensaje="Esta propiedad todavía no tiene ninguna unidad configurada." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 max-w-[640px]">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Precios</h1>
        <p className="m-0 text-[13px] text-muted-foreground">Cotiza una estadía y, si tu rol lo permite, configura la tarifa de la unidad.</p>
      </header>

      <Label className={`${LABEL_CLASES} max-w-[320px]`}>
        Unidad
        <select value={unidadId} onChange={(e) => setUnidadId(e.target.value)} className={SELECT_CLASES} disabled={!unidades}>
          {!unidades && <option>Cargando…</option>}
          {unidades?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre}
            </option>
          ))}
        </select>
      </Label>

      {error && <EstadoError mensaje={error} />}

      {unidadId && <Cotizador apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />}

      {unidadId && puedeEscribir && <ConfiguracionPricing apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />}

      {unidadId && !puedeEscribir && (
        <p className="m-0 text-[13px] text-muted-foreground">
          Solo el rol <strong className="text-foreground">admin_gestora</strong> puede configurar tarifa base, temporadas, descuentos por duración, estancia mínima y reglas por canal
          {org ? (
            <>
              {" "}
              — tu rol actual es <strong className="text-foreground">{org.rol}</strong>.
            </>
          ) : (
            "."
          )}
        </p>
      )}
    </div>
  );
}

interface UnidadPanelProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly unidadId: string;
}

function Cotizador({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [canal, setCanal] = useState("");
  const [cotizando, setCotizando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoCotizacion | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCotizar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!checkIn || !checkOut) return setError("Check-in y check-out son requeridos.");
    setCotizando(true);
    setResultado(null);
    try {
      const r = await fetchCotizacion(fetch, apiBaseUrl, token, propertyId, unidadId, { inicio: checkIn, fin: checkOut }, canal || undefined);
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular la cotización.");
    } finally {
      setCotizando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-[15px] font-semibold">Cotizador</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <form onSubmit={handleCotizar} className="flex flex-col gap-2.5">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Check-in
              <Input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Check-out
              <Input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Canal (opcional)
              <select value={canal} onChange={(e) => setCanal(e.target.value)} className={SELECT_CLASES}>
                <option value="">Reserva directa (sin canal)</option>
                {TODOS_LOS_CANALES.map((c) => (
                  <option key={c.codigo} value={c.codigo}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </Label>
          </div>
          {error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={cotizando} className="self-start">
            <Calculator className="w-4 h-4" strokeWidth={1.75} />
            {cotizando ? "Cotizando…" : "Cotizar"}
          </Button>
        </form>

        {resultado && (
          <div className="flex flex-col gap-2.5 border-t border-border pt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-9 px-2">Noche</TableHead>
                  <TableHead className="h-9 px-2">Origen</TableHead>
                  <TableHead className="h-9 px-2 text-right">Precio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resultado.desgloseNoches.map((n) => (
                  <TableRow key={n.fecha}>
                    <TableCell className="p-2">{n.fecha}</TableCell>
                    <TableCell className="p-2 text-muted-foreground">{n.origen === "temporada" ? `Temporada: ${n.temporadaNombre}` : "Base"}</TableCell>
                    <TableCell className="p-2 text-right tabular-nums">
                      {centavosAPesos(n.precioCentavos)} {resultado.moneda}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-col gap-1 text-[13px]">
              <Linea label={`Subtotal (${resultado.noches} noche${resultado.noches === 1 ? "" : "s"})`} valorCentavos={resultado.subtotalAntesDescuentoCentavos} moneda={resultado.moneda} />
              {resultado.descuentoAplicado && (
                <Linea
                  label={`Descuento (${resultado.descuentoAplicado.nochesMinimas}+ noches, ${basisPointsAPorcentaje(resultado.descuentoAplicado.porcentajeDescuentoBasisPoints)}% — ${resultado.descuentoAplicado.fuente})`}
                  valorCentavos={-resultado.descuentoAplicado.montoCentavos}
                  moneda={resultado.moneda}
                />
              )}
              {resultado.markupCanalCentavos > 0 && <Linea label="Markup de canal" valorCentavos={resultado.markupCanalCentavos} moneda={resultado.moneda} />}
              <Linea label="Total" valorCentavos={resultado.totalCentavos} moneda={resultado.moneda} fuerte />
            </div>

            {resultado.violacionesMinStay.length > 0 && (
              <div className="flex gap-2 rounded-lg border border-dashed border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={1.75} />
                <div>
                  {resultado.violacionesMinStay.map((v, i) => (
                    <p key={i} className={i === 0 ? "m-0" : "mt-1 mb-0"}>
                      No cumple la estancia mínima de {v.regla.nochesMinimas} noches
                      {v.regla.diaSemanaCheckIn !== null ? ` para check-in en ${DIA_SEMANA_LABELS[v.regla.diaSemanaCheckIn]}` : ""} ({v.regla.rango.inicio}..{v.regla.rango.fin}) — se
                      solicitaron {v.nochesSolicitadas}. Esto es informativo: el precio de arriba SÍ es el precio real, la decisión de bloquear la reserva es del calendario, no del
                      cotizador.
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Linea({ label, valorCentavos, moneda, fuerte }: { label: string; valorCentavos: number; moneda: string; fuerte?: boolean }) {
  const signo = valorCentavos < 0 ? "-" : "";
  return (
    <div className={fuerte ? "flex justify-between font-bold text-foreground" : "flex justify-between text-foreground"}>
      <span>{label}</span>
      <span className="tabular-nums">
        {signo}
        {centavosAPesos(Math.abs(valorCentavos))} {moneda}
      </span>
    </div>
  );
}

function ConfiguracionPricing({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[15px] font-semibold text-foreground m-0">Configuración de pricing</h2>
      <TarifaBaseForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <TemporadaForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <DescuentoDuracionForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <MinStayForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
      <ReglaCanalForm apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />
    </section>
  );
}

/** Envoltura común de los 5 sub-formularios de configuración: <Card> con título y un
 * <form> dentro, misma anatomía que tenía el `sectionStyle` inline previo. */
function BloqueConfig({ titulo, onSubmit, children }: { titulo: string; onSubmit: (e: FormEvent<HTMLFormElement>) => void; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold">{titulo}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {children}
        </form>
      </CardContent>
    </Card>
  );
}

function TarifaBaseForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [precio, setPrecio] = useState("");
  const [moneda, setMoneda] = useState("MXN");
  const [vigenteDesde, setVigenteDesde] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly TarifaBaseCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const precioNum = Number(precio);
    if (!precio || Number.isNaN(precioNum) || precioNum < 0) return setError("Precio por noche inválido.");
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    setGuardando(true);
    try {
      const creada = await crearTarifaBase(fetch, apiBaseUrl, token, propertyId, unidadId, {
        precioNocheCentavos: pesosACentavos(precioNum),
        moneda: moneda.toUpperCase(),
        vigenteDesde: vigenteDesde || undefined,
      });
      setCreadas((prev) => [creada, ...prev]);
      setPrecio("");
      setVigenteDesde("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la tarifa base.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <BloqueConfig titulo="Tarifa base" onSubmit={handleSubmit}>
      <div className="flex gap-2.5 flex-wrap">
        <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
          Precio por noche
          <Input type="number" min="0" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} required placeholder="1000.00" />
        </Label>
        <Label className={`${LABEL_CLASES} w-[90px]`}>
          Moneda
          <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required placeholder="MXN" />
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
          Vigente desde (opcional, hoy si se deja vacío)
          <Input type="date" value={vigenteDesde} onChange={(e) => setVigenteDesde(e.target.value)} />
        </Label>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={guardando} className="self-start">
        {guardando ? "Guardando…" : "Guardar tarifa base"}
      </Button>
      {creadas.length > 0 && (
        <div>
          <p className={NOTA_CLASES}>Configurado en esta sesión (no hay lectura persistente todavía — ver comentario en pricing-client.ts):</p>
          <ul className="mt-1 mb-0 p-0 list-none flex flex-col gap-1 text-xs text-muted-foreground">
            {creadas.map((c) => (
              <li key={c.id}>
                {centavosAPesos(c.precioNocheCentavos)} {c.moneda} · vigente desde {c.vigenteDesde}
              </li>
            ))}
          </ul>
        </div>
      )}
    </BloqueConfig>
  );
}

function TemporadaForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [nombre, setNombre] = useState("");
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [precio, setPrecio] = useState("");
  const [moneda, setMoneda] = useState("MXN");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly TemporadaCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const precioNum = Number(precio);
    if (!nombre.trim()) return setError("El nombre de la temporada es requerido.");
    if (!inicio || !fin) return setError("Inicio y fin son requeridos.");
    if (!precio || Number.isNaN(precioNum) || precioNum < 0) return setError("Precio por noche inválido.");
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    setGuardando(true);
    try {
      const creada = await crearTemporada(fetch, apiBaseUrl, token, propertyId, unidadId, {
        nombre: nombre.trim(),
        rango: { inicio, fin },
        precioNocheCentavos: pesosACentavos(precioNum),
        moneda: moneda.toUpperCase(),
      });
      setCreadas((prev) => [creada, ...prev]);
      setNombre("");
      setInicio("");
      setFin("");
      setPrecio("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la temporada.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <BloqueConfig titulo="Temporadas" onSubmit={handleSubmit}>
      <div className="flex gap-2.5 flex-wrap">
        <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
          Nombre
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} required placeholder="Semana Santa" />
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
          Inicio
          <Input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} required />
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
          Fin (exclusivo)
          <Input type="date" value={fin} onChange={(e) => setFin(e.target.value)} required />
        </Label>
      </div>
      <div className="flex gap-2.5 flex-wrap">
        <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
          Precio por noche
          <Input type="number" min="0" step="0.01" value={precio} onChange={(e) => setPrecio(e.target.value)} required placeholder="1500.00" />
        </Label>
        <Label className={`${LABEL_CLASES} w-[90px]`}>
          Moneda
          <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required placeholder="MXN" />
        </Label>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={guardando} className="self-start">
        {guardando ? "Guardando…" : "Agregar temporada"}
      </Button>
      {creadas.length > 0 && (
        <div>
          <p className={NOTA_CLASES}>Configurado en esta sesión:</p>
          <ul className="mt-1 mb-0 p-0 list-none flex flex-col gap-1 text-xs text-muted-foreground">
            {creadas.map((c) => (
              <li key={c.id}>
                {c.nombre}: {c.rango.inicio} → {c.rango.fin} · {centavosAPesos(c.precioNocheCentavos)} {c.moneda}
              </li>
            ))}
          </ul>
        </div>
      )}
    </BloqueConfig>
  );
}

function DescuentoDuracionForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [nochesMinimas, setNochesMinimas] = useState("");
  const [porcentaje, setPorcentaje] = useState("");
  const [fuente, setFuente] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creados, setCreados] = useState<readonly DescuentoDuracionCreado[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const noches = Number(nochesMinimas);
    const pct = Number(porcentaje);
    if (!nochesMinimas || !Number.isInteger(noches) || noches < 1) return setError("Noches mínimas: entero >= 1.");
    if (!porcentaje || Number.isNaN(pct) || pct < 0 || pct > 100) return setError("Porcentaje de descuento: 0 a 100.");
    if (!fuente.trim()) return setError("La fuente del descuento es requerida (ej. \"promoción semanal\").");
    setGuardando(true);
    try {
      const creado = await crearDescuentoDuracion(fetch, apiBaseUrl, token, propertyId, unidadId, {
        nochesMinimas: noches,
        porcentajeDescuentoBasisPoints: porcentajeABasisPoints(pct),
        fuente: fuente.trim(),
      });
      setCreados((prev) => [creado, ...prev]);
      setNochesMinimas("");
      setPorcentaje("");
      setFuente("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el descuento por duración.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <BloqueConfig titulo="Descuentos por duración" onSubmit={handleSubmit}>
      <div className="flex gap-2.5 flex-wrap">
        <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
          Noches mínimas
          <Input type="number" min="1" step="1" value={nochesMinimas} onChange={(e) => setNochesMinimas(e.target.value)} required placeholder="7" />
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
          Descuento (%)
          <Input type="number" min="0" max="100" step="0.01" value={porcentaje} onChange={(e) => setPorcentaje(e.target.value)} required placeholder="10" />
        </Label>
        <Label className={`${LABEL_CLASES} flex-[2] min-w-[200px]`}>
          Fuente
          <Input value={fuente} onChange={(e) => setFuente(e.target.value)} required placeholder="Promoción semanal" />
        </Label>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={guardando} className="self-start">
        {guardando ? "Guardando…" : "Agregar descuento"}
      </Button>
      {creados.length > 0 && (
        <div>
          <p className={NOTA_CLASES}>Configurado en esta sesión:</p>
          <ul className="mt-1 mb-0 p-0 list-none flex flex-col gap-1 text-xs text-muted-foreground">
            {creados.map((c) => (
              <li key={c.id}>
                {c.nochesMinimas}+ noches: {basisPointsAPorcentaje(c.porcentajeDescuentoBasisPoints)}% ({c.fuente})
              </li>
            ))}
          </ul>
        </div>
      )}
    </BloqueConfig>
  );
}

function MinStayForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [inicio, setInicio] = useState("");
  const [fin, setFin] = useState("");
  const [diaSemana, setDiaSemana] = useState("");
  const [nochesMinimas, setNochesMinimas] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly MinStayCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const noches = Number(nochesMinimas);
    if (!inicio || !fin) return setError("Inicio y fin son requeridos.");
    if (!nochesMinimas || !Number.isInteger(noches) || noches < 1) return setError("Noches mínimas: entero >= 1.");
    setGuardando(true);
    try {
      const creada = await crearReglaMinStay(fetch, apiBaseUrl, token, propertyId, unidadId, {
        rango: { inicio, fin },
        diaSemanaCheckIn: diaSemana === "" ? null : Number(diaSemana),
        nochesMinimas: noches,
      });
      setCreadas((prev) => [creada, ...prev]);
      setInicio("");
      setFin("");
      setDiaSemana("");
      setNochesMinimas("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la regla de estancia mínima.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <BloqueConfig titulo="Estancia mínima (min-stay)" onSubmit={handleSubmit}>
      <div className="flex gap-2.5 flex-wrap">
        <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
          Inicio
          <Input type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} required />
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
          Fin (exclusivo)
          <Input type="date" value={fin} onChange={(e) => setFin(e.target.value)} required />
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[150px]`}>
          Día de check-in
          <select value={diaSemana} onChange={(e) => setDiaSemana(e.target.value)} className={SELECT_CLASES}>
            <option value="">Todos los días</option>
            {DIA_SEMANA_LABELS.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
          Noches mínimas
          <Input type="number" min="1" step="1" value={nochesMinimas} onChange={(e) => setNochesMinimas(e.target.value)} required placeholder="3" />
        </Label>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={guardando} className="self-start">
        {guardando ? "Guardando…" : "Agregar regla"}
      </Button>
      {creadas.length > 0 && (
        <div>
          <p className={NOTA_CLASES}>Configurado en esta sesión:</p>
          <ul className="mt-1 mb-0 p-0 list-none flex flex-col gap-1 text-xs text-muted-foreground">
            {creadas.map((c) => (
              <li key={c.id}>
                {c.rango.inicio} → {c.rango.fin}
                {c.diaSemanaCheckIn !== null ? ` (${DIA_SEMANA_LABELS[c.diaSemanaCheckIn]})` : ""}: mínimo {c.nochesMinimas} noches
              </li>
            ))}
          </ul>
        </div>
      )}
    </BloqueConfig>
  );
}

function ReglaCanalForm({ apiBaseUrl, token, propertyId, unidadId }: UnidadPanelProps) {
  const [canalCodigo, setCanalCodigo] = useState(CANALES_CON_MARKUP[0]!.codigo);
  const [markup, setMarkup] = useState("");
  const [activo, setActivo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creadas, setCreadas] = useState<readonly ReglaCanalCreada[]>([]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const pct = Number(markup);
    if (!markup || Number.isNaN(pct) || pct < 0 || pct > 100) return setError("Markup: 0 a 100%.");
    setGuardando(true);
    try {
      const creada = await crearReglaCanal(fetch, apiBaseUrl, token, propertyId, unidadId, {
        canalCodigo,
        markupBasisPoints: porcentajeABasisPoints(pct),
        activo,
      });
      setCreadas((prev) => [creada, ...prev]);
      setMarkup("");
      setActivo(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la regla de canal.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <BloqueConfig titulo="Reglas por canal" onSubmit={handleSubmit}>
      <div className="flex gap-2.5 flex-wrap">
        <Label className={`${LABEL_CLASES} flex-1 min-w-[150px]`}>
          Canal
          <select value={canalCodigo} onChange={(e) => setCanalCodigo(e.target.value)} className={SELECT_CLASES}>
            {CANALES_CON_MARKUP.map((c) => (
              <option key={c.codigo} value={c.codigo}>
                {c.nombre}
              </option>
            ))}
          </select>
        </Label>
        <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
          Markup (%)
          <Input type="number" min="0" max="100" step="0.01" value={markup} onChange={(e) => setMarkup(e.target.value)} required placeholder="15" />
        </Label>
        <Label className="flex flex-row items-center gap-2 mt-5 text-[13px] text-foreground">
          <input type="checkbox" className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]" checked={activo} onChange={(e) => setActivo(e.target.checked)} />
          Activa (aplica al cotizar para este canal)
        </Label>
      </div>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={guardando} className="self-start">
        {guardando ? "Guardando…" : "Guardar regla de canal"}
      </Button>
      {creadas.length > 0 && (
        <div>
          <p className={NOTA_CLASES}>Configurado en esta sesión:</p>
          <ul className="mt-1 mb-0 p-0 list-none flex flex-col gap-1 text-xs text-muted-foreground">
            {creadas.map((c) => (
              <li key={c.id}>
                {c.canalCodigo}: {basisPointsAPorcentaje(c.markupBasisPoints)}% markup — {c.activo ? "activa" : "inactiva"}
              </li>
            ))}
          </ul>
        </div>
      )}
    </BloqueConfig>
  );
}
