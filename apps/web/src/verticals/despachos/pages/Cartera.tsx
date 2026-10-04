// D-21 -- Cartera de clientes del despacho: alta y ficha fiscal de contribuyente por cliente (RFC, razon social,
// regimen(es), CP fiscal, periodicidad de pagos provisionales, responsable). Sin RFC no se puede distinguir un CFDI
// EMITIDO de uno RECIBIDO, asi que los clientes sin ficha se senalan. Datos: GET/POST .../admin/cartera y
// GET/PUT .../cartera/ficha (cartera.ts). El servidor y la base validan de verdad; esta pantalla solo da
// retroalimentacion inmediata y oculta acciones que el servidor rechazaria (el enforcement real es server-side).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Pencil, Plus } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  Checkbox,
  DataTable,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  NativeSelect,
  PageContainer,
  PageHeader,
  StatusBadge,
} from "@atiende/ui";
import {
  crearCliente,
  erroresFormulario,
  etiquetaTipoPersona,
  fetchCartera,
  FORMULARIO_VACIO,
  formularioDesdeCliente,
  guardarFicha,
  mensajeRfc,
  PERIODICIDAD_ETIQUETAS,
  REGIMENES_FISCALES,
  resumenCartera,
  tipoPersonaDeRfc,
} from "../lib/cartera-client.ts";
import type { CarteraRespuesta, ClienteCartera, FichaFormulario, PeriodicidadPagos } from "../lib/cartera-client.ts";
import { fetchOrgMembers } from "../lib/staff-client.ts";
import type { OrgMember } from "../lib/staff-client.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Espejo cosmetico de GESTIONAR_CARTERA_ROLES (@atiende/domain-despachos/src/roles.ts); el servidor es la autoridad.
const GESTIONAR_ROLES: ReadonlySet<string> = new Set(["admin", "contador"]);

interface FormularioClienteProps {
  readonly inicial: FichaFormulario;
  /** Alta de un cliente nuevo (pide nombre) o ficha de uno existente (el RFC ya registrado no se cambia). */
  readonly alta: boolean;
  readonly rfcBloqueado: boolean;
  readonly miembros: readonly OrgMember[] | null;
  readonly guardando: boolean;
  readonly errorServidor: string | null;
  readonly onGuardar: (f: FichaFormulario) => void;
  readonly idFormulario: string;
}

/** Formulario de la ficha fiscal (reutilizado por el dialogo de la pagina y por el alta del primer cliente). */
export function FormularioCliente({ inicial, alta, rfcBloqueado, miembros, guardando, errorServidor, onGuardar, idFormulario }: FormularioClienteProps) {
  const [f, setF] = useState<FichaFormulario>(inicial);
  const [intento, setIntento] = useState(false);
  const errores = erroresFormulario(f, { alta });
  const tipo = tipoPersonaDeRfc(f.rfc);
  const set = <K extends keyof FichaFormulario>(k: K, v: FichaFormulario[K]) => setF((prev) => ({ ...prev, [k]: v }));

  function enviar(e: FormEvent) {
    e.preventDefault();
    setIntento(true);
    if (Object.keys(errores).length > 0 || guardando) return;
    onGuardar(f);
  }
  const err = (campo: string) => (intento ? errores[campo] : undefined);

  return (
    <form id={idFormulario} onSubmit={enviar} className="flex flex-col gap-4" noValidate>
      {alta && (
        <FormField label="Nombre del cliente" error={err("nombre")}>
          <Input id={`${idFormulario}-nombre`} value={f.nombre} maxLength={120} onChange={(e) => set("nombre", e.target.value)} placeholder="Como lo identifica tu despacho" />
        </FormField>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="RFC"
          error={err("rfc")}
          hint={rfcBloqueado ? "El RFC de un cliente registrado no se modifica." : tipo ? etiquetaTipoPersona(tipo) : f.rfc.trim() !== "" && mensajeRfc(f.rfc) ? mensajeRfc(f.rfc) : "12 caracteres (persona moral) o 13 (persona física)."}
        >
          <Input
            id={`${idFormulario}-rfc`}
            value={f.rfc}
            maxLength={13}
            disabled={rfcBloqueado}
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono uppercase"
            onChange={(e) => set("rfc", e.target.value.toUpperCase())}
          />
        </FormField>
        <FormField label="Código postal fiscal" error={err("cpFiscal")}>
          <Input id={`${idFormulario}-cp`} value={f.cpFiscal} inputMode="numeric" maxLength={5} className="font-mono" onChange={(e) => set("cpFiscal", e.target.value.replace(/\D/g, ""))} />
        </FormField>
      </div>
      <FormField label="Razón social" error={err("razonSocial")}>
        <Input id={`${idFormulario}-razon`} value={f.razonSocial} maxLength={250} onChange={(e) => set("razonSocial", e.target.value)} placeholder="Tal como aparece en su constancia de situación fiscal" />
      </FormField>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-foreground">Régimen(es) fiscal(es)</legend>
        <p className="text-xs text-muted-foreground">Claves del catálogo del SAT (c_RegimenFiscal). Puede tener más de uno.</p>
        <div className="grid max-h-56 gap-1.5 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-2">
          {REGIMENES_FISCALES.map((r) => (
            <Checkbox
              key={r.clave}
              checked={f.regimenesFiscales.includes(r.clave)}
              onChange={(e) => set("regimenesFiscales", e.target.checked ? [...f.regimenesFiscales, r.clave].sort() : f.regimenesFiscales.filter((x) => x !== r.clave))}
              label={`${r.clave} · ${r.nombre}`}
            />
          ))}
        </div>
        {err("regimenesFiscales") && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {err("regimenesFiscales")}
          </p>
        )}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Periodicidad de pagos provisionales">
          <NativeSelect id={`${idFormulario}-periodicidad`} value={f.periodicidad} onChange={(e) => set("periodicidad", e.target.value as PeriodicidadPagos)}>
            {(Object.keys(PERIODICIDAD_ETIQUETAS) as PeriodicidadPagos[]).map((p) => (
              <option key={p} value={p}>
                {PERIODICIDAD_ETIQUETAS[p]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {miembros && miembros.length > 0 && (
          <FormField label="Responsable en el despacho">
            <NativeSelect id={`${idFormulario}-responsable`} value={f.responsableId} onChange={(e) => set("responsableId", e.target.value)}>
              <option value="">Sin asignar</option>
              {miembros.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName} ({m.email})
                </option>
              ))}
            </NativeSelect>
          </FormField>
        )}
      </div>
      {errorServidor && <Callout tone="danger">{errorServidor}</Callout>}
    </form>
  );
}

export function CarteraPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const [cartera, setCartera] = useState<CarteraRespuesta | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [miembros, setMiembros] = useState<readonly OrgMember[] | null>(null);
  // `editando`: null = dialogo cerrado; "nuevo" = alta; un cliente = ficha de ese cliente.
  const [editando, setEditando] = useState<ClienteCartera | "nuevo" | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const puedeGestionar = GESTIONAR_ROLES.has(role);

  async function cargar() {
    setCargando(true);
    setError(null);
    try {
      setCartera(await fetchCartera(fetch, apiBaseUrl, token, orgSlug));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la cartera.");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token, orgSlug]);

  // El selector de responsable es opcional: la lista de staff solo la entrega el servidor al administrador; sin ella se omite el campo.
  useEffect(() => {
    if (!puedeGestionar) return;
    fetchOrgMembers(fetch, apiBaseUrl, token, propertyId).then(setMiembros, () => setMiembros(null));
  }, [apiBaseUrl, token, propertyId, puedeGestionar]);

  async function guardar(f: FichaFormulario) {
    if (editando === null) return;
    setGuardando(true);
    setErrorGuardar(null);
    try {
      if (editando === "nuevo") {
        await crearCliente(fetch, apiBaseUrl, token, orgSlug, f);
        setAviso(`Cliente «${f.nombre.trim()}» dado de alta.`);
      } else {
        await guardarFicha(fetch, apiBaseUrl, token, editando.propertyId, f);
        setAviso(`Ficha de «${editando.nombre}» guardada.`);
      }
      setEditando(null);
      await cargar();
    } catch (err) {
      setErrorGuardar(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  const resumen = cartera ? resumenCartera(cartera) : null;
  const puedeAlta = puedeGestionar && cartera?.puedeDarDeAlta === true && cartera.estado === "disponible";
  const abierto = editando !== null;
  const esAlta = editando === "nuevo";

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Cartera de clientes"
        descripcion="Ficha fiscal de cada contribuyente que atiende tu despacho."
        acciones={
          puedeAlta ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setErrorGuardar(null);
                setAviso(null);
                setEditando("nuevo");
              }}
            >
              <Plus />
              Nuevo cliente
            </Button>
          ) : undefined
        }
      />

      {aviso && (
        <Callout tone="success" onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}
      {error && <EstadoError mensaje={error} onReintentar={() => void cargar()} />}
      {cargando && !cartera && <EstadoCargando etiqueta="Cargando cartera…" />}

      {cartera && resumen && (
        <Callout tone={cartera.estado === "no_disponible" ? "warning" : resumen.sinFicha > 0 ? "warning" : "success"} role="status">
          {resumen.mensaje}
        </Callout>
      )}

      {cartera && cartera.clientes.length === 0 && !cargando && <EstadoVacio mensaje="Todavía no hay clientes en la cartera." />}

      {cartera && cartera.clientes.length > 0 && (
        <DataTable
          etiqueta="Clientes del despacho"
          obtenerId={(c) => c.propertyId}
          filas={cartera.clientes}
          paginacion={false}
          columnas={[
            {
              id: "cliente",
              encabezado: "Cliente",
              principal: true,
              celda: (c) => (
                <>
                  <span className="font-semibold text-foreground">{c.nombre}</span>
                  {c.ficha && <div className="text-xs font-normal text-muted-foreground">{c.ficha.razonSocial}</div>}
                </>
              ),
            },
            {
              id: "rfc",
              encabezado: "RFC",
              celda: (c) =>
                c.ficha ? (
                  <>
                    <span className="font-mono text-xs">{c.ficha.rfc}</span>
                    <div className="text-xs text-muted-foreground">{etiquetaTipoPersona(c.ficha.tipoPersona)}</div>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                ),
            },
            {
              id: "regimen",
              encabezado: "Régimen fiscal",
              celda: (c) => (c.ficha ? <span className="text-sm text-muted-foreground">{c.ficha.regimenesFiscales.map((r) => `${r.clave} ${r.nombre}`).join("; ")}</span> : <span className="text-muted-foreground">—</span>),
            },
            { id: "cp", encabezado: "CP fiscal", celda: (c) => <span className="font-mono text-xs text-muted-foreground">{c.ficha?.cpFiscal ?? "—"}</span> },
            { id: "periodicidad", encabezado: "Pagos provisionales", celda: (c) => <span className="text-muted-foreground">{c.ficha ? PERIODICIDAD_ETIQUETAS[c.ficha.periodicidad] : "—"}</span> },
            {
              id: "estatus",
              encabezado: "Ficha",
              celda: (c) => (c.ficha ? <StatusBadge tone="success">Completa</StatusBadge> : <StatusBadge tone="warning">Sin ficha</StatusBadge>),
            },
            {
              id: "acciones",
              encabezado: "",
              celda: (c) =>
                puedeGestionar && cartera.estado === "disponible" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setErrorGuardar(null);
                      setAviso(null);
                      setEditando(c);
                    }}
                  >
                    <Pencil />
                    {c.ficha ? "Editar ficha" : "Completar ficha"}
                  </Button>
                ) : null,
            },
          ]}
        />
      )}

      <FormDialog
        open={abierto}
        onOpenChange={(abrir) => !abrir && !guardando && setEditando(null)}
        titulo={esAlta ? "Nuevo cliente" : "Ficha fiscal del cliente"}
        subtitulo={editando === "nuevo" ? "Da de alta al contribuyente con su ficha fiscal." : editando !== null ? editando.nombre : undefined}
        anchoClase="max-w-3xl"
        bloquearCierre={guardando}
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => setEditando(null)} disabled={guardando}>
              Cancelar
            </Button>
            <Button type="submit" form="form-cartera" loading={guardando}>
              {esAlta ? "Dar de alta" : "Guardar ficha"}
            </Button>
          </>
        }
      >
        {editando !== null && (
          <FormularioCliente
            key={editando === "nuevo" ? "nuevo" : editando.propertyId}
            idFormulario="form-cartera"
            inicial={editando === "nuevo" ? FORMULARIO_VACIO : formularioDesdeCliente(editando)}
            alta={editando === "nuevo"}
            rfcBloqueado={editando !== "nuevo" && editando.ficha !== null}
            miembros={miembros}
            guardando={guardando}
            errorServidor={errorGuardar}
            onGuardar={(f) => void guardar(f)}
          />
        )}
      </FormDialog>
    </PageContainer>
  );
}

/** Alta del PRIMER cliente de un despacho recien creado: sin ningun cliente el panel no tiene contribuyente activo, asi que esta
 * pantalla ocupa su lugar (la usa DespachosShell en la fase "vacio"). Al guardar, `onCreado` recarga los contribuyentes. */
export function AltaPrimerCliente({ apiBaseUrl, token, orgSlug, onCreado }: { readonly apiBaseUrl: string; readonly token: string; readonly orgSlug: string; readonly onCreado: () => void }) {
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guardar(f: FichaFormulario) {
    setGuardando(true);
    setError(null);
    try {
      await crearCliente(fetch, apiBaseUrl, token, orgSlug, f);
      onCreado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo dar de alta al cliente.");
      setGuardando(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="grid w-full max-w-3xl gap-2.5">
        <PageHeader titulo="Da de alta tu primer cliente" descripcion="Este despacho todavía no tiene ningún contribuyente. Captura su ficha fiscal para empezar a ingestar sus CFDI." />
        <Card>
          <CardContent className="flex flex-col gap-4 p-4">
            <FormularioCliente idFormulario="form-primer-cliente" inicial={FORMULARIO_VACIO} alta rfcBloqueado={false} miembros={null} guardando={guardando} errorServidor={error} onGuardar={(f) => void guardar(f)} />
            <div className="flex justify-end">
              <Button type="submit" form="form-primer-cliente" loading={guardando}>
                Dar de alta
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
