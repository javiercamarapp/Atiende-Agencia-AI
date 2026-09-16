// Finanzas (Fase 16) — cierra el hallazgo de auditoría ALTA "Finanzas (movimientos,
// owner statements, payouts/conciliación) sin UI para admin_gestora ni contador":
// finanzas.ts (POST/GET .../reservas/:ocupacionId/movimiento), finanzas-statements.ts
// (POST/GET .../owners/:ownerId/statements, GET .../statements/:id) y
// finanzas-payouts.ts (POST .../payouts, GET .../payouts/:id) ya estaban montados y
// probados en apps/api sin que ninguna página de apps/web los invocara.
//
// Tres secciones independientes, mismo patrón de "gate en el CLIENTE solo por UX,
// el servidor SIEMPRE re-valida vía assertVerticalRole" que ya usa Precios.tsx:
//  1. Movimiento financiero por reserva -- LECTURA para FINANZAS_LECTURA_ROLES
//     (admin_gestora + contador), ESCRITURA (registrar) solo admin_gestora
//     (FINANZAS_ESCRITURA_ROLES en packages/domain-rentas/src/roles.ts).
//  2. Owner statements -- misma separación lectura/escritura. Generar exige
//     motivoVersion cuando ya existe una versión previa (el servidor lo exige; esta
//     UI lo pide siempre que haya al menos un statement listado, para no
//     sorprender con un 400).
//  3. Payouts de canal + conciliación -- crear (POST) es escritura; ver el detalle
//     de un payout ya creado es lectura.
//
// Límite real (documentado también en finanzas-client.ts): ningún endpoint expone
// un catálogo de propietarios de una property ni una lista de payouts ya
// importados -- `ownerId`/`payoutId` se piden como texto libre, igual que
// pricing-client.ts documenta la ausencia de un GET de configuración de pricing.
//
// Portal de propietario (Fase 3 backend, UI de esta fase): "Invitar a este
// propietario" en la sección de owner statements llama
// POST .../owners/:ownerId/portal-invite (owner-portal-invite.ts) -- mismo
// FINANZAS_LECTURA_ROLES que ya gatea esta sección completa, el servidor
// re-valida con assertVerticalRole igual que el resto de esta página. El token
// de invitación se muestra UNA sola vez (nunca se puede recuperar de nuevo) para
// que staff lo copie/pegue en el mensaje que le mande al propietario -- no hay
// envío de correo real en este monorepo todavía (ver el comentario de cabecera
// de owner-portal-invite.ts). El propietario activa su cuenta y consulta sus
// statements en una superficie SEPARADA de este panel de staff (ver
// pages/OwnerPortalLogin.tsx/OwnerPortalActivar.tsx/OwnerPortalDashboard.tsx --
// login propio contra el JWT del portal, nunca el de staff).
//
// Ronda de portado del sistema de diseño real (@atiende/ui): Card/Button/Input/
// Label/Table/Badge/EstadoVacio + clases de token en lugar de los `style={{...}}`
// hechos a mano. CERO cambios de lógica: mismos submits, mismas validaciones
// locales, mismas ramas de render, mismos gates de rol, mismos payloads.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FileSpreadsheet, Mail, Plus, Search, Wallet } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoVacio,
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
  CANALES_PAYOUT,
  centavosAPesos,
  fetchMovimiento,
  fetchOcupaciones,
  fetchOwnerStatementDetalle,
  fetchOwnerStatements,
  fetchPayoutDetalle,
  fetchUnidades,
  generarOwnerStatement,
  importarPayout,
  invitarPropietarioAlPortal,
  pesosACentavos,
  porcentajeABasisPoints,
  registrarMovimiento,
} from "../lib/finanzas-client.ts";
import type {
  BaseComisionGestor,
  LineaGastoEntrada,
  LineaImpuestoEntrada,
  LineaOwnerStatement,
  MovimientoDetalle,
  OcupacionCalendario,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutCreado,
  PayoutDetalle,
  PortalInviteEmitida,
  UnidadOption,
} from "../lib/finanzas-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const FINANZAS_LECTURA_ROLES = new Set(["admin_gestora", "contador"]);
const FINANZAS_ESCRITURA_ROLES = new Set(["admin_gestora"]);

/** Mismos tokens que el <Input> de @atiende/ui aplicados a los <select> nativos: son
 * dropdowns de datos reales (unidad, reserva, canal, base de comisión) con estados
 * `<option>Cargando…</option>` / `<option>Sin reservas en esta unidad</option>` --
 * se quedan nativos y solo se re-estilan. */
const SELECT_CLASES =
  "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASES = "flex flex-col gap-1.5 text-[13px] text-foreground";
const NOTA_CLASES = "m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground";

const TIPO_LINEA_LABELS: Record<string, string> = {
  ingreso: "Ingreso",
  comision_canal: "Comisión de canal",
  comision_gestor: "Comisión de gestor",
  gasto: "Gasto",
  impuesto: "Impuesto",
};

const ESTADO_CONCILIACION_LABELS: Record<string, string> = {
  conciliado: "Conciliado",
  pendiente: "Pendiente",
  discrepancia: "Discrepancia",
};

/** Mismo criterio semántico que la tabla previa en texto plano, ahora con <Badge>. */
function varianteConciliacion(estado: string): "default" | "secondary" | "destructive" | "outline" {
  if (estado === "conciliado") return "default";
  if (estado === "discrepancia") return "destructive";
  if (estado === "pendiente") return "secondary";
  return "outline";
}

export function FinanzasPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeLeer = org ? FINANZAS_LECTURA_ROLES.has(org.rol) : false;
  const puedeEscribir = org ? FINANZAS_ESCRITURA_ROLES.has(org.rol) : false;

  if (!puedeLeer) {
    return (
      <div className="flex flex-col gap-4 max-w-[640px]">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Finanzas</h1>
        <p className="m-0 text-[13px] text-muted-foreground">
          Tu rol actual{org ? <> (<strong className="text-foreground">{org.rol}</strong>)</> : ""} no tiene acceso de lectura a Finanzas. Roles con acceso:{" "}
          <strong className="text-foreground">admin_gestora</strong> y <strong className="text-foreground">contador</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-[720px]">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Finanzas</h1>
        <p className="m-0 text-[13px] text-muted-foreground">
          Movimiento financiero por reserva, owner statements y payouts de canal.
          {!puedeEscribir && (
            <>
              {" "}
              Tu rol (<strong className="text-foreground">{org?.rol}</strong>) es de solo lectura — registrar/generar es exclusivo de{" "}
              <strong className="text-foreground">admin_gestora</strong>.
            </>
          )}
        </p>
      </header>

      <MovimientoSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
      <OwnerStatementsSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
      <PayoutsSection apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeEscribir={puedeEscribir} />
    </div>
  );
}

interface SectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeEscribir: boolean;
}

// ---------------------------------------------------------------------------
// 1. Movimiento financiero por reserva
// ---------------------------------------------------------------------------

function MovimientoSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState("");
  const [ocupaciones, setOcupaciones] = useState<readonly OcupacionCalendario[] | null>(null);
  const [ocupacionId, setOcupacionId] = useState("");
  const [cargando, setCargando] = useState(false);
  const [movimiento, setMovimiento] = useState<MovimientoDetalle | null>(null);
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

  useEffect(() => {
    if (!unidadId) return;
    let cancelado = false;
    setOcupaciones(null);
    setOcupacionId("");
    setMovimiento(null);
    (async () => {
      try {
        const list = await fetchOcupaciones(fetch, apiBaseUrl, token, propertyId, unidadId);
        if (cancelado) return;
        const reservas = list.filter((o) => o.capa === "reserva");
        setOcupaciones(reservas);
        setOcupacionId(reservas[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las reservas de esta unidad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, unidadId]);

  async function handleVerMovimiento() {
    if (!ocupacionId) return;
    setError(null);
    setCargando(true);
    setMovimiento(null);
    try {
      const m = await fetchMovimiento(fetch, apiBaseUrl, token, propertyId, ocupacionId);
      setMovimiento(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el movimiento financiero.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-[15px] font-semibold">Movimiento financiero por reserva</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <div className="flex gap-2.5 flex-wrap">
          <Label className={`${LABEL_CLASES} flex-1 min-w-[180px]`}>
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
          <Label className={`${LABEL_CLASES} flex-1 min-w-[220px]`}>
            Reserva
            <select value={ocupacionId} onChange={(e) => setOcupacionId(e.target.value)} className={SELECT_CLASES} disabled={!ocupaciones || ocupaciones.length === 0}>
              {!ocupaciones && <option>Cargando…</option>}
              {ocupaciones && ocupaciones.length === 0 && <option>Sin reservas en esta unidad</option>}
              {ocupaciones?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.rango.inicio} → {o.rango.fin} {o.huespedNombre ? `· ${o.huespedNombre}` : ""} ({o.estado})
                </option>
              ))}
            </select>
          </Label>
        </div>

        <Button type="button" variant="outline" size="sm" onClick={handleVerMovimiento} disabled={!ocupacionId || cargando} className="self-start">
          <Search className="w-4 h-4" strokeWidth={1.75} />
          {cargando ? "Consultando…" : "Ver movimiento registrado"}
        </Button>

        {error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {error}
          </p>
        )}

        {movimiento && <MovimientoResumen m={movimiento} />}

        {puedeEscribir && ocupacionId && (
          <RegistrarMovimientoForm
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            ocupacionId={ocupacionId}
            onRegistrado={(m) => setMovimiento(m)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function MovimientoResumen({ m }: { m: MovimientoDetalle }) {
  return (
    <div className="flex flex-col gap-1 text-[13px] border-t border-border pt-2.5">
      <Linea label="Ingreso bruto" valorCentavos={m.ingresoBrutoCentavos} moneda={m.moneda} />
      <Linea label={`Comisión de canal (${m.comisionCanalFuente})`} valorCentavos={-m.comisionCanalCentavos} moneda={m.moneda} />
      <Linea label="Monto recibido del canal" valorCentavos={m.montoRecibidoCentavos} moneda={m.moneda} />
      <Linea label="Comisión de gestor" valorCentavos={-m.comisionGestorCentavos} moneda={m.moneda} />
      <Linea label="Gastos" valorCentavos={-m.gastosCentavos} moneda={m.moneda} />
      <Linea label="Impuestos" valorCentavos={-m.impuestosCentavos} moneda={m.moneda} />
      <Linea label="Neto" valorCentavos={m.netoCentavos} moneda={m.moneda} fuerte />
    </div>
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

interface GastoRow {
  readonly key: string;
  tipo: string;
  descripcion: string;
  monto: string;
}

interface ImpuestoRow {
  readonly key: string;
  tipo: string;
  monto: string;
}

let filaSeq = 0;
function nuevaKey(): string {
  filaSeq += 1;
  return `fila-${filaSeq}`;
}

function RegistrarMovimientoForm({
  apiBaseUrl,
  token,
  propertyId,
  ocupacionId,
  onRegistrado,
}: {
  apiBaseUrl: string;
  token: string;
  propertyId: string;
  ocupacionId: string;
  onRegistrado: (m: MovimientoDetalle) => void;
}) {
  const [moneda, setMoneda] = useState("MXN");
  const [montoBruto, setMontoBruto] = useState("");
  const [comisionGestorPct, setComisionGestorPct] = useState("");
  const [comisionGestorBase, setComisionGestorBase] = useState<BaseComisionGestor>("bruto");
  const [gastos, setGastos] = useState<readonly GastoRow[]>([]);
  const [impuestos, setImpuestos] = useState<readonly ImpuestoRow[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function agregarGasto() {
    setGastos((prev) => [...prev, { key: nuevaKey(), tipo: "", descripcion: "", monto: "" }]);
  }
  function actualizarGasto(key: string, patch: Partial<GastoRow>) {
    setGastos((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  }
  function quitarGasto(key: string) {
    setGastos((prev) => prev.filter((g) => g.key !== key));
  }

  function agregarImpuesto() {
    setImpuestos((prev) => [...prev, { key: nuevaKey(), tipo: "", monto: "" }]);
  }
  function actualizarImpuesto(key: string, patch: Partial<ImpuestoRow>) {
    setImpuestos((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }
  function quitarImpuesto(key: string) {
    setImpuestos((prev) => prev.filter((i) => i.key !== key));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const brutoNum = Number(montoBruto);
    const pctNum = Number(comisionGestorPct);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (!montoBruto || Number.isNaN(brutoNum) || brutoNum < 0) return setError("Monto bruto inválido.");
    if (!comisionGestorPct || Number.isNaN(pctNum) || pctNum < 0 || pctNum > 100) return setError("Comisión de gestor: 0 a 100%.");
    for (const g of gastos) {
      if (!g.tipo.trim()) return setError("Cada gasto necesita un tipo.");
      if (!g.monto || Number.isNaN(Number(g.monto)) || Number(g.monto) < 0) return setError(`Monto inválido en gasto "${g.tipo}".`);
    }
    for (const i of impuestos) {
      if (!i.tipo.trim()) return setError("Cada impuesto necesita un tipo.");
      if (!i.monto || Number.isNaN(Number(i.monto)) || Number(i.monto) < 0) return setError(`Monto inválido en impuesto "${i.tipo}".`);
    }

    const gastosPayload: LineaGastoEntrada[] = gastos.map((g) => ({ tipo: g.tipo.trim(), descripcion: g.descripcion.trim() || null, montoCentavos: pesosACentavos(Number(g.monto)) }));
    const impuestosPayload: LineaImpuestoEntrada[] = impuestos.map((i) => ({ tipo: i.tipo.trim(), montoCentavos: pesosACentavos(Number(i.monto)) }));

    setGuardando(true);
    try {
      const creado = await registrarMovimiento(fetch, apiBaseUrl, token, propertyId, ocupacionId, {
        moneda: moneda.toUpperCase(),
        montoBrutoCentavos: pesosACentavos(brutoNum),
        comisionGestorBasisPoints: porcentajeABasisPoints(pctNum),
        comisionGestorBase,
        gastos: gastosPayload,
        impuestos: impuestosPayload,
      });
      onRegistrado(creado);
      setMontoBruto("");
      setComisionGestorPct("");
      setGastos([]);
      setImpuestos([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo registrar el movimiento.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold">Registrar movimiento</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} w-[90px]`}>
              Moneda
              <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required placeholder="MXN" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Monto bruto (por el canal)
              <Input type="number" min="0" step="0.01" value={montoBruto} onChange={(e) => setMontoBruto(e.target.value)} required placeholder="5000.00" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Comisión de gestor (%)
              <Input type="number" min="0" max="100" step="0.01" value={comisionGestorPct} onChange={(e) => setComisionGestorPct(e.target.value)} required placeholder="10" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[180px]`}>
              Base de la comisión de gestor
              <select value={comisionGestorBase} onChange={(e) => setComisionGestorBase(e.target.value as BaseComisionGestor)} className={SELECT_CLASES}>
                <option value="bruto">Sobre el bruto</option>
                <option value="neto_de_canal">Sobre el neto de comisión de canal</option>
              </select>
            </Label>
          </div>

          <div>
            <p className="m-0 mb-1.5 text-[13px] text-foreground">Gastos (opcional)</p>
            {gastos.map((g) => (
              <div key={g.key} className="flex gap-2.5 flex-wrap mb-1.5">
                <Input value={g.tipo} onChange={(e) => actualizarGasto(g.key, { tipo: e.target.value })} placeholder="Tipo (ej. limpieza)" className="flex-1 min-w-[140px]" />
                <Input
                  value={g.descripcion}
                  onChange={(e) => actualizarGasto(g.key, { descripcion: e.target.value })}
                  placeholder="Descripción (opcional)"
                  className="flex-1 min-w-[160px]"
                />
                <Input type="number" min="0" step="0.01" value={g.monto} onChange={(e) => actualizarGasto(g.key, { monto: e.target.value })} placeholder="Monto" className="w-[110px]" />
                <Button type="button" variant="outline" size="sm" onClick={() => quitarGasto(g.key)}>
                  Quitar
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={agregarGasto}>
              <Plus className="w-4 h-4" strokeWidth={1.75} />+ Agregar gasto
            </Button>
          </div>

          <div>
            <p className="m-0 mb-1.5 text-[13px] text-foreground">Impuestos (opcional — siempre sujetos a revisión fiscal)</p>
            {impuestos.map((i) => (
              <div key={i.key} className="flex gap-2.5 flex-wrap mb-1.5">
                <Input value={i.tipo} onChange={(e) => actualizarImpuesto(i.key, { tipo: e.target.value })} placeholder="Tipo (ej. ISR retenido)" className="flex-1 min-w-[160px]" />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={i.monto}
                  onChange={(e) => actualizarImpuesto(i.key, { monto: e.target.value })}
                  placeholder="Monto"
                  className="w-[110px]"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => quitarImpuesto(i.key)}>
                  Quitar
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={agregarImpuesto}>
              <Plus className="w-4 h-4" strokeWidth={1.75} />+ Agregar impuesto
            </Button>
          </div>

          {error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={guardando} className="self-start">
            {guardando ? "Registrando…" : "Registrar movimiento"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2. Owner statements
// ---------------------------------------------------------------------------

function OwnerStatementsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [ownerId, setOwnerId] = useState("");
  const [statements, setStatements] = useState<readonly OwnerStatementSummary[] | null>(null);
  const [detalle, setDetalle] = useState<OwnerStatementDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ultimoResultado, setUltimoResultado] = useState<string | null>(null);
  const [invitando, setInvitando] = useState(false);
  const [invite, setInvite] = useState<PortalInviteEmitida | null>(null);
  const [errorInvite, setErrorInvite] = useState<string | null>(null);

  async function invitarPropietario() {
    if (!ownerId.trim()) return setErrorInvite("Ingresa primero el id del propietario arriba.");
    setErrorInvite(null);
    setInvite(null);
    setInvitando(true);
    try {
      const resultado = await invitarPropietarioAlPortal(fetch, apiBaseUrl, token, propertyId, ownerId.trim());
      setInvite(resultado);
    } catch (err) {
      setErrorInvite(err instanceof Error ? err.message : "No se pudo invitar a este propietario.");
    } finally {
      setInvitando(false);
    }
  }

  async function cargarStatements(idOwner: string) {
    if (!idOwner.trim()) return setError("Se necesita el id del propietario.");
    setError(null);
    setCargando(true);
    setDetalle(null);
    try {
      const list = await fetchOwnerStatements(fetch, apiBaseUrl, token, propertyId, idOwner.trim());
      setStatements(list);
    } catch (err) {
      setStatements(null);
      setError(err instanceof Error ? err.message : "No se pudieron cargar los statements de este propietario.");
    } finally {
      setCargando(false);
    }
  }

  async function verDetalle(statementId: string) {
    setError(null);
    try {
      const d = await fetchOwnerStatementDetalle(fetch, apiBaseUrl, token, propertyId, statementId);
      setDetalle(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el detalle del statement.");
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-[15px] font-semibold">Owner statements</CardTitle>
        <CardDescription className="text-xs">
          No hay un catálogo de propietarios en el backend todavía — ingresa el id del propietario (mismo que usa el portal del propietario).
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <div className="flex gap-2.5 flex-wrap items-end">
          <Label className={`${LABEL_CLASES} flex-1 min-w-[220px]`}>
            Id del propietario (ownerId)
            <Input value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="uuid del propietario" />
          </Label>
          <Button type="button" variant="outline" size="sm" onClick={() => cargarStatements(ownerId)} disabled={cargando}>
            <Search className="w-4 h-4" strokeWidth={1.75} />
            {cargando ? "Consultando…" : "Ver statements"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={invitarPropietario} disabled={invitando}>
            <Mail className="w-4 h-4" strokeWidth={1.75} />
            {invitando ? "Invitando…" : "Invitar a este propietario"}
          </Button>
        </div>

        {errorInvite && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {errorInvite}
          </p>
        )}
        {invite && (
          <p className={NOTA_CLASES}>
            Invitación creada (vence {invite.expiresAt}). Comparte este token con el propietario para que active su cuenta en el portal:{" "}
            <code className="select-all rounded bg-background px-1 py-0.5 font-mono">{invite.inviteToken}</code>
          </p>
        )}

        {error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {error}
          </p>
        )}

        {statements && statements.length === 0 && (
          <EstadoVacio icon={FileSpreadsheet} titulo="Sin statements" mensaje="Este propietario no tiene ningún statement generado todavía." />
        )}

        {statements && statements.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-9 px-2">Periodo</TableHead>
                <TableHead className="h-9 px-2">Versión</TableHead>
                <TableHead className="h-9 px-2 text-right">Neto</TableHead>
                <TableHead className="h-9 px-2">Generado</TableHead>
                <TableHead className="h-9 px-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {statements.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="p-2">
                    {s.periodo.inicio} → {s.periodo.fin}
                  </TableCell>
                  <TableCell className="p-2">v{s.version}</TableCell>
                  <TableCell className="p-2 text-right tabular-nums">
                    {centavosAPesos(s.netoCentavos)} {s.moneda}
                  </TableCell>
                  <TableCell className="p-2 text-muted-foreground">{s.generadoEn}</TableCell>
                  <TableCell className="p-2">
                    <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={() => verDetalle(s.id)}>
                      Ver detalle
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {detalle && (
          <div className="border-t border-border pt-2.5 flex flex-col gap-2">
            <p className="m-0 text-[13px] font-semibold text-foreground">
              Statement v{detalle.version} — {detalle.periodo.inicio} → {detalle.periodo.fin}
            </p>
            {detalle.motivoVersion && <p className="m-0 text-xs text-muted-foreground">Motivo de esta versión: {detalle.motivoVersion}</p>}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 px-2 text-xs">Reserva</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Tipo</TableHead>
                  <TableHead className="h-8 px-2 text-xs text-right">Monto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detalle.lineas.map((l: LineaOwnerStatement, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="p-2 text-xs">{l.ocupacionId}</TableCell>
                    <TableCell className="p-2 text-xs">{TIPO_LINEA_LABELS[l.tipo] ?? l.tipo}</TableCell>
                    <TableCell className="p-2 text-xs text-right tabular-nums">
                      {centavosAPesos(l.montoCentavos)} {detalle.moneda}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex flex-col gap-0.5 text-[13px]">
              <Linea label="Ingresos brutos" valorCentavos={detalle.totales.ingresosBrutosCentavos} moneda={detalle.moneda} />
              <Linea label="Comisión de canal" valorCentavos={-detalle.totales.comisionCanalCentavos} moneda={detalle.moneda} />
              <Linea label="Comisión de gestor" valorCentavos={-detalle.totales.comisionGestorCentavos} moneda={detalle.moneda} />
              <Linea label="Gastos" valorCentavos={-detalle.totales.gastosCentavos} moneda={detalle.moneda} />
              <Linea label="Impuestos" valorCentavos={-detalle.totales.impuestosCentavos} moneda={detalle.moneda} />
              <Linea label="Neto" valorCentavos={detalle.totales.netoCentavos} moneda={detalle.moneda} fuerte />
            </div>
          </div>
        )}

        {puedeEscribir && (
          <GenerarStatementForm
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            ownerId={ownerId}
            hayVersionPrevia={(statements?.length ?? 0) > 0}
            onGenerado={(resultado) => {
              setUltimoResultado(
                resultado.creado
                  ? `Statement nuevo creado: versión ${resultado.version}.`
                  : `Sin cambios: el contenido es idéntico al de la versión ${resultado.version} ya existente (idempotente).`,
              );
              if (ownerId.trim()) cargarStatements(ownerId);
            }}
          />
        )}
        {ultimoResultado && <p className={NOTA_CLASES}>{ultimoResultado}</p>}
      </CardContent>
    </Card>
  );
}

function GenerarStatementForm({
  apiBaseUrl,
  token,
  propertyId,
  ownerId,
  hayVersionPrevia,
  onGenerado,
}: {
  apiBaseUrl: string;
  token: string;
  propertyId: string;
  ownerId: string;
  hayVersionPrevia: boolean;
  onGenerado: (r: { creado: boolean; version: number }) => void;
}) {
  const [periodoInicio, setPeriodoInicio] = useState("");
  const [periodoFin, setPeriodoFin] = useState("");
  const [motivoVersion, setMotivoVersion] = useState("");
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!ownerId.trim()) return setError("Ingresa primero el id del propietario arriba.");
    if (!periodoInicio || !periodoFin) return setError("Periodo inicio y fin son requeridos.");
    if (hayVersionPrevia && !motivoVersion.trim()) return setError("Ya existe una versión previa para este propietario — el motivo de la nueva versión es obligatorio.");
    setGenerando(true);
    try {
      const resultado = await generarOwnerStatement(fetch, apiBaseUrl, token, propertyId, ownerId.trim(), {
        periodoInicio,
        periodoFin,
        motivoVersion: motivoVersion.trim() || undefined,
      });
      onGenerado(resultado);
      setMotivoVersion("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el statement.");
    } finally {
      setGenerando(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold">Generar statement</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Periodo inicio
              <Input type="date" value={periodoInicio} onChange={(e) => setPeriodoInicio(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[130px]`}>
              Periodo fin
              <Input type="date" value={periodoFin} onChange={(e) => setPeriodoFin(e.target.value)} required />
            </Label>
          </div>
          <Label className={LABEL_CLASES}>
            Motivo de nueva versión {hayVersionPrevia ? "(obligatorio: ya existe al menos una versión)" : "(opcional — todavía no hay ninguna versión previa)"}
            <Input value={motivoVersion} onChange={(e) => setMotivoVersion(e.target.value)} placeholder="Corrección de gastos de limpieza reportados tarde" />
          </Label>
          {error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={generando} className="self-start">
            {generando ? "Generando…" : "Generar statement"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. Payouts de canal + conciliación
// ---------------------------------------------------------------------------

interface LineaPayoutRow {
  readonly key: string;
  referencia: string;
  monto: string;
}

function PayoutsSection({ apiBaseUrl, token, propertyId, puedeEscribir }: SectionProps) {
  const [payoutId, setPayoutId] = useState("");
  const [detalle, setDetalle] = useState<PayoutDetalle | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verPayout(id: string) {
    if (!id.trim()) return setError("Se necesita el id del payout.");
    setError(null);
    setCargando(true);
    try {
      const d = await fetchPayoutDetalle(fetch, apiBaseUrl, token, propertyId, id.trim());
      setDetalle(d);
    } catch (err) {
      setDetalle(null);
      setError(err instanceof Error ? err.message : "No se pudo cargar el payout.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-[15px] font-semibold">Payouts de canal + conciliación</CardTitle>
        <CardDescription className="text-xs">
          No hay un listado de payouts ya importados en el backend todavía — al crear uno aquí, su id queda precargado abajo para consultarlo.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        <div className="flex gap-2.5 flex-wrap items-end">
          <Label className={`${LABEL_CLASES} flex-1 min-w-[220px]`}>
            Id del payout
            <Input value={payoutId} onChange={(e) => setPayoutId(e.target.value)} placeholder="uuid del payout" />
          </Label>
          <Button type="button" variant="outline" size="sm" onClick={() => verPayout(payoutId)} disabled={cargando}>
            <Wallet className="w-4 h-4" strokeWidth={1.75} />
            {cargando ? "Consultando…" : "Ver payout"}
          </Button>
        </div>

        {error && (
          <p role="alert" className="m-0 text-[13px] text-destructive">
            {error}
          </p>
        )}

        {detalle && <PayoutResumen detalle={detalle} />}

        {puedeEscribir && (
          <ImportarPayoutForm
            apiBaseUrl={apiBaseUrl}
            token={token}
            propertyId={propertyId}
            onCreado={(creado) => {
              setPayoutId(creado.id);
              setDetalle({ id: creado.id, propertyId, canalCodigo: creado.canalCodigo, moneda: creado.moneda, montoTotalCentavos: creado.montoTotalCentavos, fechaPayout: creado.fechaPayout, referenciaExterna: null, resumen: creado.resumen, lineas: creado.lineas });
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PayoutResumen({ detalle }: { detalle: PayoutDetalle }) {
  return (
    <div className="border-t border-border pt-2.5 flex flex-col gap-2">
      <p className="m-0 text-[13px] text-foreground">
        <strong>{detalle.canalCodigo}</strong> · {centavosAPesos(detalle.montoTotalCentavos)} {detalle.moneda} · pagado {detalle.fechaPayout}
        {detalle.referenciaExterna ? ` · ref. ${detalle.referenciaExterna}` : ""}
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        {detalle.resumen.conciliadas} conciliadas · {detalle.resumen.pendientes} pendientes · {detalle.resumen.discrepancias} con discrepancia
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 px-2 text-xs">Referencia</TableHead>
            <TableHead className="h-8 px-2 text-xs">Reserva</TableHead>
            <TableHead className="h-8 px-2 text-xs text-right">Monto</TableHead>
            <TableHead className="h-8 px-2 text-xs text-right">Esperado</TableHead>
            <TableHead className="h-8 px-2 text-xs">Estado</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detalle.lineas.map((l, i) => (
            <TableRow key={i}>
              <TableCell className="p-2 text-xs">{l.referenciaExternaReserva ?? "—"}</TableCell>
              <TableCell className="p-2 text-xs">{l.ocupacionId ?? "sin match"}</TableCell>
              <TableCell className="p-2 text-xs text-right tabular-nums">{centavosAPesos(l.montoCentavos)}</TableCell>
              <TableCell className="p-2 text-xs text-right tabular-nums">{l.montoEsperadoCentavos !== null ? centavosAPesos(l.montoEsperadoCentavos) : "—"}</TableCell>
              <TableCell className="p-2 text-xs">
                <Badge variant={varianteConciliacion(l.estado)}>{ESTADO_CONCILIACION_LABELS[l.estado] ?? l.estado}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ImportarPayoutForm({ apiBaseUrl, token, propertyId, onCreado }: { apiBaseUrl: string; token: string; propertyId: string; onCreado: (creado: PayoutCreado) => void }) {
  const [canalCodigo, setCanalCodigo] = useState(CANALES_PAYOUT[0]!.codigo);
  const [moneda, setMoneda] = useState("MXN");
  const [fechaPayout, setFechaPayout] = useState("");
  const [referenciaExterna, setReferenciaExterna] = useState("");
  const [lineas, setLineas] = useState<readonly LineaPayoutRow[]>([{ key: nuevaKey(), referencia: "", monto: "" }]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ultimoResumen, setUltimoResumen] = useState<string | null>(null);

  function agregarLinea() {
    setLineas((prev) => [...prev, { key: nuevaKey(), referencia: "", monto: "" }]);
  }
  function actualizarLinea(key: string, patch: Partial<LineaPayoutRow>) {
    setLineas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function quitarLinea(key: string) {
    setLineas((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!/^[A-Za-z]{3}$/.test(moneda)) return setError("Moneda: se esperan 3 letras (código ISO 4217), ej. MXN.");
    if (!fechaPayout) return setError("La fecha del payout es requerida.");
    if (lineas.length === 0) return setError("Se necesita al menos una línea.");
    for (const l of lineas) {
      if (!l.monto || Number.isNaN(Number(l.monto)) || Number(l.monto) < 0) return setError("Cada línea necesita un monto válido.");
    }

    setGuardando(true);
    try {
      const creado = await importarPayout(fetch, apiBaseUrl, token, propertyId, {
        canalCodigo,
        moneda: moneda.toUpperCase(),
        fechaPayout,
        referenciaExterna: referenciaExterna.trim() || null,
        lineas: lineas.map((l) => ({ referenciaExternaReserva: l.referencia.trim() || null, montoCentavos: pesosACentavos(Number(l.monto)) })),
      });
      onCreado(creado);
      setUltimoResumen(`Payout ${creado.id}: ${creado.resumen.conciliadas} conciliadas · ${creado.resumen.pendientes} pendientes · ${creado.resumen.discrepancias} con discrepancia.`);
      setFechaPayout("");
      setReferenciaExterna("");
      setLineas([{ key: nuevaKey(), referencia: "", monto: "" }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar el payout.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm font-semibold">Importar payout</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} flex-1 min-w-[150px]`}>
              Canal
              <select value={canalCodigo} onChange={(e) => setCanalCodigo(e.target.value)} className={SELECT_CLASES}>
                {CANALES_PAYOUT.map((c) => (
                  <option key={c.codigo} value={c.codigo}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </Label>
            <Label className={`${LABEL_CLASES} w-[90px]`}>
              Moneda
              <Input value={moneda} onChange={(e) => setMoneda(e.target.value.toUpperCase())} maxLength={3} required placeholder="MXN" />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[140px]`}>
              Fecha de pago
              <Input type="date" value={fechaPayout} onChange={(e) => setFechaPayout(e.target.value)} required />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Referencia externa (opcional)
              <Input value={referenciaExterna} onChange={(e) => setReferenciaExterna(e.target.value)} placeholder="Id del reporte del canal" />
            </Label>
          </div>

          <div>
            <p className="m-0 mb-1.5 text-[13px] text-foreground">Líneas del payout (según el reporte del canal, ya normalizadas)</p>
            {lineas.map((l) => (
              <div key={l.key} className="flex gap-2.5 flex-wrap mb-1.5">
                <Input
                  value={l.referencia}
                  onChange={(e) => actualizarLinea(l.key, { referencia: e.target.value })}
                  placeholder="Referencia externa de la reserva (opcional)"
                  className="flex-1 min-w-[200px]"
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={l.monto}
                  onChange={(e) => actualizarLinea(l.key, { monto: e.target.value })}
                  placeholder="Monto"
                  required
                  className="w-[110px]"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => quitarLinea(l.key)} disabled={lineas.length === 1}>
                  Quitar
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={agregarLinea}>
              <Plus className="w-4 h-4" strokeWidth={1.75} />+ Agregar línea
            </Button>
          </div>

          {error && (
            <p role="alert" className="m-0 text-[13px] text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" size="sm" disabled={guardando} className="self-start">
            {guardando ? "Importando…" : "Importar payout"}
          </Button>
          {ultimoResumen && <p className={NOTA_CLASES}>{ultimoResumen}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
