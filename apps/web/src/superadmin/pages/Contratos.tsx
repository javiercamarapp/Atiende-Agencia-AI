// Contrato por cliente (SA-43): condiciones comerciales de cada organizacion (base mensual, por sucursal,
// bolsa de minutos de voz, excedente, instalacion, descuentos, vigencia), historial inmutable de versiones con
// quien las cambio y facturacion ESTIMADA del mes. Backend real: apps/api/src/routes/superadmin-contratos.ts
// (ver docs/SUPERADMIN_CONTRATOS.md). Dar de alta o cambiar condiciones pide tu codigo MFA (step-up).
//
// La estimacion es un calculo: NO cobra, NO emite factura y NO envia nada a nadie. Todo dinero es MXN en
// centavos enteros (nunca flotantes); si falta el contrato o los minutos medidos se dice «no disponible» y por
// que, jamas un cero inventado.
//
// Presentacion (DS v2): PageContainer/PageHeader, Card por bloque, StatCard, StatusBadge, Callout y
// FormDialog/FormField para el formulario.
import { useCallback, useEffect, useMemo, useState } from "react";
import { PhoneCall, Receipt, Wallet } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormField, FormDialog, Input, NativeSelect, PageContainer, PageHeader, StatCard, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@atiende/ui";
import { fetchConStepUp } from "../lib/stepup.ts";
import { bpAEditable, bpATexto, centavosAEditable, centavosAPesos, fechaIsoATexto, mesActual, pesosACentavos, porcentajeABp } from "../lib/contratos.ts";

interface Organizacion {
  readonly id: string;
  readonly name: string;
  readonly vertical: string;
  readonly status: string;
}

interface Version {
  readonly id: string;
  readonly contractId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
  readonly baseCentavos: number;
  readonly porSucursalCentavos: number;
  readonly sucursalesIncluidas: number;
  readonly bolsaMinutos: number;
  readonly excedenteCentavosMinuto: number;
  readonly instalacionCentavos: number;
  readonly descuentoBp: number;
  readonly descuentoFijoCentavos: number;
  readonly motivo: string;
  readonly creadoPor: string;
  readonly creadoPorCorreo: string | null;
  readonly creadoEnMs: number;
}

interface Segmento {
  readonly version: number;
  readonly desde: string;
  readonly hasta: string;
  readonly dias: number;
  readonly sucursalesExtra: number;
  readonly mensualCentavos: number;
  readonly proporcionalCentavos: number;
}

interface Estimacion {
  readonly estado: "estimado" | "sin_contrato";
  readonly diasDelMes: number;
  readonly segmentos: readonly Segmento[];
  readonly recurrenteCentavos: number | null;
  readonly bolsaMinutos: number | null;
  readonly minutosUsados: number | null;
  readonly minutosExcedentes: number | null;
  readonly tarifaExcedenteCentavosMinuto: number | null;
  readonly excedenteCentavos: number | null;
  readonly totalCentavos: number | null;
  readonly razonTotal: string | null;
  readonly supuestos: readonly string[];
}

interface RespuestaEstimacion {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly estimacion: Estimacion | null;
  readonly inconsistente?: string;
  readonly insumos?: { readonly sucursalesActivas: number; readonly minutosVoz: number | null; readonly eventosVoz: number };
}

interface RespuestaVersiones {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly versiones: readonly Version[];
}

interface Formulario {
  readonly modo: "alta" | "enmienda";
  readonly contractId: string | null;
}

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo completar la solicitud.");
  }
  return res.json() as Promise<T>;
}

const fechaHora = (ms: number) => new Date(ms).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
const MESES_VALIDOS = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function SuperAdminContratosPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [orgs, setOrgs] = useState<readonly Organizacion[] | null>(null);
  const [orgId, setOrgId] = useState("");
  const [mes, setMes] = useState(mesActual());
  const [versiones, setVersiones] = useState<RespuestaVersiones | null>(null);
  const [estimacion, setEstimacion] = useState<RespuestaEstimacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [form, setForm] = useState<Formulario | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [base, setBase] = useState("");
  const [porSucursal, setPorSucursal] = useState("");
  const [incluidas, setIncluidas] = useState("0");
  const [bolsa, setBolsa] = useState("0");
  const [excedente, setExcedente] = useState("");
  const [instalacion, setInstalacion] = useState("");
  const [descuentoPct, setDescuentoPct] = useState("");
  const [descuentoFijo, setDescuentoFijo] = useState("");
  const [motivo, setMotivo] = useState("");

  const cargarOrgs = useCallback(async () => {
    setError(null);
    try {
      const r = await fetchJson<{ organizations: Organizacion[] }>(apiBaseUrl, token, "/superadmin/organizations");
      setOrgs(r.organizations);
      setOrgId((actual) => actual || r.organizations[0]?.id || "");
    } catch {
      setError("No se pudieron cargar las organizaciones.");
    }
  }, [apiBaseUrl, token]);

  const cargarContrato = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    try {
      const v = await fetchJson<RespuestaVersiones>(apiBaseUrl, token, `/superadmin/contratos?organizationId=${encodeURIComponent(orgId)}`);
      setVersiones(v);
      if (v.disponible && MESES_VALIDOS.test(mes)) {
        setEstimacion(await fetchJson<RespuestaEstimacion>(apiBaseUrl, token, `/superadmin/contratos/estimacion?organizationId=${encodeURIComponent(orgId)}&mes=${mes}`));
      } else {
        setEstimacion(null);
      }
    } catch {
      setError("No se pudo cargar el contrato de esta organización.");
    }
  }, [apiBaseUrl, token, orgId, mes]);

  useEffect(() => {
    void cargarOrgs();
  }, [cargarOrgs]);

  useEffect(() => {
    void cargarContrato();
  }, [cargarContrato]);

  const org = useMemo(() => orgs?.find((o) => o.id === orgId) ?? null, [orgs, orgId]);
  const disponible = versiones?.disponible ?? true;

  // La version vigente de cada contrato (la mas reciente) es la que se enmienda.
  const ultimas = useMemo(() => {
    const m = new Map<string, Version>();
    for (const v of versiones?.versiones ?? []) {
      const actual = m.get(v.contractId);
      if (!actual || v.version > actual.version) m.set(v.contractId, v);
    }
    return m;
  }, [versiones]);

  function abrir(modo: Formulario["modo"], contractId: string | null) {
    const base0 = contractId ? ultimas.get(contractId) : undefined;
    setForm({ modo, contractId });
    setFormError(null);
    setDesde("");
    setHasta(base0?.vigenteHasta ?? "");
    setBase(base0 ? centavosAEditable(base0.baseCentavos) : "");
    setPorSucursal(base0 ? centavosAEditable(base0.porSucursalCentavos) : "");
    setIncluidas(String(base0?.sucursalesIncluidas ?? 0));
    setBolsa(String(base0?.bolsaMinutos ?? 0));
    setExcedente(base0 ? centavosAEditable(base0.excedenteCentavosMinuto) : "");
    setInstalacion(base0 ? centavosAEditable(base0.instalacionCentavos) : "");
    setDescuentoPct(base0 ? bpAEditable(base0.descuentoBp) : "");
    setDescuentoFijo(base0 ? centavosAEditable(base0.descuentoFijoCentavos) : "");
    setMotivo("");
  }

  async function guardar() {
    if (!form || !orgId) return;
    const entero = (t: string) => (/^\d{1,9}$/u.test(t.trim()) ? Number(t.trim()) : undefined);
    const baseC = pesosACentavos(base);
    const porSucC = pesosACentavos(porSucursal);
    const excC = pesosACentavos(excedente);
    const instC = instalacion.trim() === "" ? 0 : pesosACentavos(instalacion);
    const descFijoC = descuentoFijo.trim() === "" ? 0 : pesosACentavos(descuentoFijo);
    const bp = porcentajeABp(descuentoPct);
    const incl = entero(incluidas);
    const bols = entero(bolsa);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(desde)) return setFormError("Indica desde cuándo rige (fecha completa).");
    if (hasta !== "" && hasta < desde) return setFormError("El fin de la vigencia no puede ser anterior al inicio.");
    if (baseC === undefined || porSucC === undefined || excC === undefined) return setFormError("Base, tarifa por sucursal y excedente por minuto son montos en MXN (hasta 2 decimales).");
    if (instC === undefined || descFijoC === undefined) return setFormError("Instalación y descuento fijo son montos en MXN (hasta 2 decimales).");
    if (bp === undefined) return setFormError("El descuento porcentual va de 0 a 100 (hasta 2 decimales).");
    if (incl === undefined || bols === undefined) return setFormError("Sucursales incluidas y minutos de la bolsa son enteros mayores o iguales a 0.");
    if (motivo.trim().length < 20) return setFormError("El motivo debe tener al menos 20 caracteres.");
    setGuardando(true);
    setFormError(null);
    const cuerpo = {
      vigenteDesde: desde,
      vigenteHasta: hasta === "" ? null : hasta,
      baseCentavos: baseC,
      porSucursalCentavos: porSucC,
      sucursalesIncluidas: incl,
      bolsaMinutos: bols,
      excedenteCentavosMinuto: excC,
      instalacionCentavos: instC,
      descuentoBp: bp,
      descuentoFijoCentavos: descFijoC,
      motivo: motivo.trim(),
    };
    try {
      if (form.modo === "alta") {
        await fetchJson(apiBaseUrl, token, "/superadmin/contratos", { method: "POST", body: JSON.stringify({ organizationId: orgId, ...cuerpo }) });
        setAviso("Contrato registrado (versión 1).");
      } else {
        await fetchJson(apiBaseUrl, token, `/superadmin/contratos/${form.contractId}/enmiendas`, { method: "POST", body: JSON.stringify(cuerpo) });
        setAviso("Condiciones cambiadas: se creó una versión nueva y la anterior quedó intacta.");
      }
      setForm(null);
      await cargarContrato();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo guardar el contrato.");
    } finally {
      setGuardando(false);
    }
  }

  if (error && !orgs) return <EstadoError mensaje={error} onReintentar={() => void cargarOrgs()} />;
  if (!orgs) return <EstadoCargando etiqueta="Cargando contratos…" />;

  const est = estimacion?.estimacion ?? null;

  return (
    <PageContainer>
      <PageHeader
        titulo="Contratos por cliente"
        descripcion="Lo que se pactó con cada cliente: base mensual, tarifa por sucursal, bolsa de minutos de voz, excedente, descuentos y vigencia. Cada cambio crea una versión nueva e inmutable con quién la hizo."
        acciones={
          disponible && org ? (
            <Button className="rounded-full" onClick={() => abrir("alta", null)}>
              Nuevo contrato
            </Button>
          ) : undefined
        }
      />

      {versiones && !versiones.disponible && (
        <Callout tone="warning" titulo="Todavía no disponible en esta base">
          {versiones.mensaje ?? "Falta aplicar la migración 0037_superadmin_contrato_cliente."}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" titulo="No se pudo completar la acción">
          {error}
        </Callout>
      )}
      {aviso && (
        <Callout tone="success" titulo="Listo" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}

      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2">
          <FormField label="Organización">
            <NativeSelect value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.vertical})
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Mes a estimar">
            <Input type="month" value={mes} onChange={(e) => setMes(e.target.value)} />
          </FormField>
        </CardContent>
      </Card>

      {orgs.length === 0 && <EstadoVacio mensaje="Todavía no hay organizaciones." />}

      {disponible && org && (
        <Card>
          <CardHeader>
            <CardTitle>Facturación estimada de {mes}</CardTitle>
            <CardDescription>Cálculo a partir del contrato, las sucursales activas hoy y los minutos de voz medidos. Subtotal antes de IVA. No cobra ni envía nada.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {estimacion?.inconsistente && (
              <Callout tone="danger" titulo="Contrato inconsistente">
                {estimacion.inconsistente}
              </Callout>
            )}
            {est?.estado === "sin_contrato" && (
              <Callout tone="info" titulo="Sin contrato vigente en este mes">
                No se inventa una cifra: registra el contrato o elige otro mes.
              </Callout>
            )}
            {est && est.estado === "estimado" && (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <StatCard icon={Wallet} label="Recurrente" value={centavosAPesos(est.recurrenteCentavos)} />
                  <StatCard icon={PhoneCall} label="Excedente de voz" value={centavosAPesos(est.excedenteCentavos)} {...(est.excedenteCentavos === null ? { sinDato: "Minutos de voz no medidos" } : {})} />
                  <StatCard icon={Receipt} label="Total estimado" value={centavosAPesos(est.totalCentavos)} {...(est.totalCentavos === null ? { sinDato: "No disponible" } : {})} />
                </div>
                {est.razonTotal && (
                  <Callout tone="warning" titulo="Total no disponible">
                    {est.razonTotal}
                  </Callout>
                )}
                <p className="text-[13px] text-muted-foreground">
                  Sucursales activas: {estimacion?.insumos?.sucursalesActivas ?? "—"}. Bolsa del mes: {est.bolsaMinutos ?? "—"} min. Minutos usados:{" "}
                  {est.minutosUsados === null ? "no medidos" : est.minutosUsados}
                  {est.minutosExcedentes ? `, ${est.minutosExcedentes} min de excedente a ${centavosAPesos(est.tarifaExcedenteCentavosMinuto)} por minuto` : ""}.
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Versión</TableHead>
                        <TableHead>Del</TableHead>
                        <TableHead>Al</TableHead>
                        <TableHead>Días</TableHead>
                        <TableHead>Mensual completo</TableHead>
                        <TableHead>Proporcional</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {est.segmentos.map((s) => (
                        <TableRow key={s.version}>
                          <TableCell>v{s.version}</TableCell>
                          <TableCell>{fechaIsoATexto(s.desde)}</TableCell>
                          <TableCell>{fechaIsoATexto(s.hasta)}</TableCell>
                          <TableCell>
                            {s.dias} de {est.diasDelMes}
                          </TableCell>
                          <TableCell>{centavosAPesos(s.mensualCentavos)}</TableCell>
                          <TableCell>{centavosAPesos(s.proporcionalCentavos)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
            {est && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {est.supuestos.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {disponible && org && (
        <Card>
          <CardHeader>
            <CardTitle>Contratos e historial de versiones — {org.name}</CardTitle>
            <CardDescription>Las versiones no se editan ni se borran: un cambio de condiciones es una versión nueva con su motivo y su autor.</CardDescription>
          </CardHeader>
          <CardContent>
            {!versiones ? (
              <EstadoCargando etiqueta="Cargando el historial…" />
            ) : versiones.versiones.length === 0 ? (
              <EstadoVacio mensaje="Esta organización todavía no tiene contrato registrado." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Versión</TableHead>
                      <TableHead>Vigencia</TableHead>
                      <TableHead>Base / mes</TableHead>
                      <TableHead>Por sucursal</TableHead>
                      <TableHead>Bolsa de voz</TableHead>
                      <TableHead>Descuentos</TableHead>
                      <TableHead>Instalación</TableHead>
                      <TableHead>Quién y cuándo</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versiones.versiones.map((v) => {
                      const esUltima = ultimas.get(v.contractId)?.id === v.id;
                      return (
                        <TableRow key={v.id}>
                          <TableCell>
                            <span className="font-medium">v{v.version}</span> {esUltima && <StatusBadge tone="success">Vigente</StatusBadge>}
                          </TableCell>
                          <TableCell>
                            {fechaIsoATexto(v.vigenteDesde)} → {fechaIsoATexto(v.vigenteHasta)}
                          </TableCell>
                          <TableCell>{centavosAPesos(v.baseCentavos)}</TableCell>
                          <TableCell>
                            {centavosAPesos(v.porSucursalCentavos)}
                            <div className="text-xs text-muted-foreground">{v.sucursalesIncluidas} incluidas</div>
                          </TableCell>
                          <TableCell>
                            {v.bolsaMinutos} min
                            <div className="text-xs text-muted-foreground">excedente {centavosAPesos(v.excedenteCentavosMinuto)}/min</div>
                          </TableCell>
                          <TableCell>
                            {bpATexto(v.descuentoBp)}
                            {v.descuentoFijoCentavos > 0 && <div className="text-xs text-muted-foreground">− {centavosAPesos(v.descuentoFijoCentavos)} fijo</div>}
                          </TableCell>
                          <TableCell>{centavosAPesos(v.instalacionCentavos)}</TableCell>
                          <TableCell>
                            {v.creadoPorCorreo ?? v.creadoPor}
                            <div className="text-xs text-muted-foreground">{fechaHora(v.creadoEnMs)}</div>
                            <div className="max-w-[18rem] truncate text-xs text-muted-foreground" title={v.motivo}>
                              {v.motivo}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {esUltima && (
                              <Button variant="outline" size="sm" onClick={() => abrir("enmienda", v.contractId)}>
                                Cambiar condiciones
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <FormDialog
        open={form !== null}
        onOpenChange={(open) => !open && !guardando && setForm(null)}
        titulo={form?.modo === "alta" ? `Nuevo contrato — ${org?.name ?? ""}` : `Cambiar condiciones — ${org?.name ?? ""}`}
        subtitulo={form?.modo === "alta" ? "Registra lo pactado con el cliente. Moneda: MXN." : "Se crea una versión nueva; la anterior queda intacta. No puede empezar antes del mes en curso."}
        anchoClase="max-w-2xl"
        onGuardar={() => void guardar()}
        guardando={guardando}
        textoBotonGuardar={form?.modo === "alta" ? "Registrar contrato" : "Guardar versión nueva"}
        bloquearCierre={guardando}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Vigente desde" required>
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </FormField>
          <FormField label="Vigente hasta (opcional)" hint="Vacío = sin fecha de fin.">
            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </FormField>
          <FormField label="Base mensual (MXN)" required>
            <Input inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} placeholder="5900" />
          </FormField>
          <FormField label="Por sucursal adicional (MXN)" required>
            <Input inputMode="decimal" value={porSucursal} onChange={(e) => setPorSucursal(e.target.value)} placeholder="4000" />
          </FormField>
          <FormField label="Sucursales incluidas en la base" required>
            <Input inputMode="numeric" value={incluidas} onChange={(e) => setIncluidas(e.target.value)} />
          </FormField>
          <FormField label="Bolsa de minutos de voz al mes" required>
            <Input inputMode="numeric" value={bolsa} onChange={(e) => setBolsa(e.target.value)} />
          </FormField>
          <FormField label="Excedente por minuto (MXN)" required>
            <Input inputMode="decimal" value={excedente} onChange={(e) => setExcedente(e.target.value)} placeholder="3" />
          </FormField>
          <FormField label="Instalación (MXN)" hint="Se factura por hito; no entra en la estimación mensual.">
            <Input inputMode="decimal" value={instalacion} onChange={(e) => setInstalacion(e.target.value)} />
          </FormField>
          <FormField label="Descuento porcentual (%)">
            <Input inputMode="decimal" value={descuentoPct} onChange={(e) => setDescuentoPct(e.target.value)} />
          </FormField>
          <FormField label="Descuento fijo mensual (MXN)">
            <Input inputMode="decimal" value={descuentoFijo} onChange={(e) => setDescuentoFijo(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Motivo (obligatorio, mínimo 20 caracteres)" required className="mt-3">
          <Textarea value={motivo} rows={3} maxLength={500} onChange={(e) => setMotivo(e.target.value)} />
        </FormField>
        {formError && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {formError}
          </p>
        )}
      </FormDialog>
    </PageContainer>
  );
}
