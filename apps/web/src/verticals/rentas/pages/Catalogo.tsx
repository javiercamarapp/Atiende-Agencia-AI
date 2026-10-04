// Rn-19 -- Catálogo: alta y edición de propiedades, unidades y propietarios desde el panel (hasta ahora solo el registro
// inicial creaba esas filas). Solo admin_gestora escribe (`puedeEditar` del servidor, cosmético: el servidor y la función
// SQL vuelven a exigirlo); el operador de acceso total y el contador ven el catálogo en solo lectura.
//
// Validación: zona horaria IANA y moneda MXN/USD. Cambiar la moneda de una propiedad con movimientos financieros se
// rechaza en el servidor (mezclaría monedas en sus reportes); el formulario avisa y muestra el mensaje real si ocurre.
// UNI-C-rentas: PageHeader (único h1), tarjetas con CardTitle limpio, FormDialog con FormField, DataTable y notify.
import { useCallback, useEffect, useState } from "react";
import { Building2, Pencil, Plus, UserRound } from "lucide-react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, NativeSelect, notify, PageContainer, PageHeader } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { crearPropiedad, crearPropietario, crearUnidad, editarPropiedad, editarPropietario, editarUnidad, fetchCatalogo, MONEDAS } from "../lib/catalogo-client.ts";
import type { Catalogo, Moneda, Propietario, UnidadCatalogo } from "../lib/catalogo-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";

const ZONAS_COMUNES = ["America/Mexico_City", "America/Cancun", "America/Merida", "America/Monterrey", "America/Chihuahua", "America/Mazatlan", "America/Hermosillo", "America/Tijuana", "America/Bogota", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
const ROLES_LECTURA = new Set(["admin_gestora", "operador:acceso_total", "contador"]);

type Formulario =
  | { readonly tipo: "propiedad-editar"; readonly nombre: string; readonly zonaHoraria: string; readonly moneda: Moneda }
  | { readonly tipo: "propiedad-nueva"; readonly nombre: string; readonly zonaHoraria: string; readonly moneda: Moneda }
  | { readonly tipo: "unidad"; readonly id: string | null; readonly nombre: string; readonly propietarioId: string; readonly noches: string }
  | { readonly tipo: "propietario"; readonly id: string | null; readonly nombre: string; readonly email: string };

function aMoneda(valor: string | null): Moneda {
  return valor === "USD" ? "USD" : "MXN";
}

export function CatalogoPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeVer = org ? ROLES_LECTURA.has(org.rol) : false;

  const [catalogo, setCatalogo] = useState<Catalogo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [form, setForm] = useState<Formulario | null>(null);
  const [errorForm, setErrorForm] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!puedeVer) return;
    let cancelado = false;
    setError(null);
    fetchCatalogo(fetch, apiBaseUrl, token, propertyId).then(
      (c) => {
        if (!cancelado) setCatalogo(c);
      },
      (err: unknown) => {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo.");
      },
    );
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeVer, recarga]);

  const abrir = useCallback((f: Formulario) => {
    setErrorForm(null);
    setForm(f);
  }, []);

  const guardar = useCallback(async () => {
    if (!form) return;
    setErrorForm(null);
    setGuardando(true);
    try {
      if (form.tipo === "propiedad-editar") {
        await editarPropiedad(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), zonaHoraria: form.zonaHoraria.trim(), moneda: form.moneda });
      } else if (form.tipo === "propiedad-nueva") {
        await crearPropiedad(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), zonaHoraria: form.zonaHoraria.trim(), moneda: form.moneda });
      } else if (form.tipo === "unidad") {
        const noches = Number(form.noches);
        if (!Number.isInteger(noches) || noches < 1 || noches > 365) {
          setErrorForm("La estancia mínima debe ser un número entero de noches entre 1 y 365.");
          return;
        }
        const propietarioId = form.propietarioId === "" ? null : form.propietarioId;
        if (form.id) await editarUnidad(fetch, apiBaseUrl, token, propertyId, form.id, { nombre: form.nombre.trim(), propietarioId, duracionMinimaNoches: noches });
        else await crearUnidad(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), propietarioId, duracionMinimaNoches: noches });
      } else {
        const email = form.email.trim() === "" ? null : form.email.trim();
        if (form.id) await editarPropietario(fetch, apiBaseUrl, token, propertyId, form.id, { nombre: form.nombre.trim(), email });
        else await crearPropietario(fetch, apiBaseUrl, token, propertyId, { nombre: form.nombre.trim(), email });
      }
      setForm(null);
      notify.success("Cambios guardados.");
      setRecarga((n) => n + 1);
    } catch (err) {
      // El formulario queda abierto con el mensaje real del servidor (nombre duplicado, moneda inmutable, sin permiso...).
      setErrorForm(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }, [form, apiBaseUrl, token, propertyId]);

  if (!puedeVer) {
    return (
      <PageContainer>
        <PageHeader titulo="Catálogo" />
        <Callout tone="info" titulo="Sin acceso al catálogo">
          Tu rol actual{org ? ` (${org.rol})` : ""} no tiene acceso al catálogo de propiedades, unidades y propietarios.
        </Callout>
      </PageContainer>
    );
  }

  const puedeEditar = catalogo?.puedeEditar === true;
  const propiedad = catalogo?.propiedad ?? null;
  const propietarios = catalogo?.propietarios ?? [];
  const unidades = catalogo?.unidades ?? [];

  const columnaEditar = <T,>(etiquetaAria: (fila: T) => string, alEditar: (fila: T) => void): readonly DataTableColumna<T>[] =>
    puedeEditar
      ? [
          {
            id: "acciones",
            encabezado: "Acciones",
            alinear: "right",
            celda: (fila: T) => (
              <Button type="button" size="sm" variant="outline" aria-label={etiquetaAria(fila)} onClick={() => alEditar(fila)}>
                <Pencil /> Editar
              </Button>
            ),
          },
        ]
      : [];

  const columnasUnidad: readonly DataTableColumna<UnidadCatalogo>[] = [
    { id: "nombre", encabezado: "Nombre", principal: true, valorOrden: (u) => u.nombre, celda: (u) => <span className="font-medium text-foreground">{u.nombre}</span> },
    { id: "propietario", encabezado: "Propietario", valorOrden: (u) => u.propietarioNombre, celda: (u) => u.propietarioNombre ?? <span className="text-muted-foreground">Sin propietario</span> },
    { id: "noches", encabezado: "Estancia mínima", valorOrden: (u) => u.duracionMinimaNoches, celda: (u) => `${u.duracionMinimaNoches} ${u.duracionMinimaNoches === 1 ? "noche" : "noches"}` },
    ...columnaEditar<UnidadCatalogo>(
      (u) => `Editar la unidad ${u.nombre}`,
      (u) => abrir({ tipo: "unidad", id: u.id, nombre: u.nombre, propietarioId: u.propietarioId ?? "", noches: String(u.duracionMinimaNoches) }),
    ),
  ];

  const columnasPropietario: readonly DataTableColumna<Propietario>[] = [
    { id: "nombre", encabezado: "Nombre", principal: true, valorOrden: (p) => p.nombre, celda: (p) => <span className="font-medium text-foreground">{p.nombre}</span> },
    { id: "correo", encabezado: "Correo", valorOrden: (p) => p.email, celda: (p) => p.email ?? <span className="text-muted-foreground">Sin correo</span> },
    ...columnaEditar<Propietario>(
      (p) => `Editar al propietario ${p.nombre}`,
      (p) => abrir({ tipo: "propietario", id: p.id, nombre: p.nombre, email: p.email ?? "" }),
    ),
  ];

  const titulos: Record<Formulario["tipo"], string> = {
    "propiedad-editar": "Editar la propiedad",
    "propiedad-nueva": "Nueva propiedad",
    unidad: form?.tipo === "unidad" && form.id ? "Editar la unidad" : "Nueva unidad",
    propietario: form?.tipo === "propietario" && form.id ? "Editar el propietario" : "Nuevo propietario",
  };

  return (
    <PageContainer>
      <PageHeader
        titulo="Catálogo"
        descripcion={`Propiedades, unidades y propietarios de tu gestora.${catalogo && !puedeEditar ? " Tu rol es de solo lectura: solo la administradora de la gestora puede crear o editar." : ""}`}
      />

      {error && <EstadoError mensaje={error} onReintentar={() => setRecarga((n) => n + 1)} />}
      {!catalogo && !error && <EstadoCargando etiqueta="Cargando catálogo…" />}

      {catalogo && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="flex flex-col gap-1">
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="size-4" strokeWidth={1.75} /> Propiedad
                </CardTitle>
                <CardDescription>La zona horaria define el "hoy" del calendario y la moneda es la de sus reportes.</CardDescription>
              </div>
              {puedeEditar && (
                <div className="flex flex-wrap gap-2">
                  {propiedad && (
                    <Button type="button" size="sm" variant="outline" onClick={() => abrir({ tipo: "propiedad-editar", nombre: propiedad.nombre, zonaHoraria: propiedad.zonaHoraria ?? "America/Mexico_City", moneda: aMoneda(propiedad.moneda) })}>
                      <Pencil /> Editar
                    </Button>
                  )}
                  <Button type="button" size="sm" onClick={() => abrir({ tipo: "propiedad-nueva", nombre: "", zonaHoraria: "America/Mexico_City", moneda: "MXN" })}>
                    <Plus /> Nueva propiedad
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {propiedad ? (
                <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Nombre</dt>
                    <dd className="m-0 text-sm font-medium text-foreground">{propiedad.nombre}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Zona horaria</dt>
                    <dd className="m-0 text-sm font-medium text-foreground">{propiedad.zonaHoraria ?? "Sin configurar"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Moneda</dt>
                    <dd className="m-0 text-sm font-medium text-foreground">{propiedad.moneda ?? "Sin configurar"}</dd>
                  </div>
                </dl>
              ) : (
                <EstadoVacio mensaje="No se encontró la configuración de esta propiedad." />
              )}
              {catalogo.propiedades.length > 1 && (
                <p className="m-0 mt-3 text-xs text-muted-foreground">
                  Tu organización tiene {catalogo.propiedades.length} propiedades: {catalogo.propiedades.map((p) => p.nombre).join(", ")}. Cámbiala con el selector de propiedad.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="flex flex-col gap-1">
                <CardTitle>Unidades de esta propiedad</CardTitle>
                <CardDescription>Cada unidad es lo que se renta: el calendario, los precios y la limpieza cuelgan de ella.</CardDescription>
              </div>
              {puedeEditar && (
                <Button type="button" size="sm" onClick={() => abrir({ tipo: "unidad", id: null, nombre: "", propietarioId: "", noches: "1" })}>
                  <Plus /> Nueva unidad
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <DataTable etiqueta="Unidades de la propiedad" columnas={columnasUnidad} filas={unidades} obtenerId={(u) => u.id} vacio={{ titulo: "Sin unidades", mensaje: "Esta propiedad todavía no tiene unidades." }} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="flex flex-col gap-1">
                <CardTitle className="flex items-center gap-2">
                  <UserRound className="size-4" strokeWidth={1.75} /> Propietarios
                </CardTitle>
                <CardDescription>Los dueños de los inmuebles que administras. Reciben sus statements y acceden a su portal con el correo que registres.</CardDescription>
              </div>
              {puedeEditar && (
                <Button type="button" size="sm" onClick={() => abrir({ tipo: "propietario", id: null, nombre: "", email: "" })}>
                  <Plus /> Nuevo propietario
                </Button>
              )}
            </CardHeader>
            <CardContent className="p-0">
              <DataTable etiqueta="Propietarios" columnas={columnasPropietario} filas={propietarios} obtenerId={(p) => p.id} vacio={{ titulo: "Sin propietarios", mensaje: "Todavía no hay propietarios registrados." }} />
            </CardContent>
          </Card>
        </>
      )}

      <FormDialog
        open={form !== null}
        onOpenChange={(abierto) => {
          if (!abierto && !guardando) setForm(null);
        }}
        titulo={form ? titulos[form.tipo] : ""}
        anchoClase="max-w-2xl"
        onGuardar={() => void guardar()}
        guardando={guardando}
        textoBotonGuardar="Guardar"
        bloquearCierre={guardando}
      >
        {form && (
          <div className="flex flex-col gap-3">
            {errorForm && <EstadoError compacto titulo="No se pudo guardar" mensaje={errorForm} />}
            {(form.tipo === "propiedad-editar" || form.tipo === "propiedad-nueva") && (
              <>
                <FormField label="Nombre" required>
                  <Input value={form.nombre} maxLength={120} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
                </FormField>
                <FormField label="Zona horaria (IANA)" required>
                  <Input list="rentas-zonas-horarias" value={form.zonaHoraria} placeholder="America/Mexico_City" onChange={(e) => setForm({ ...form, zonaHoraria: e.target.value })} />
                </FormField>
                <datalist id="rentas-zonas-horarias">
                  {ZONAS_COMUNES.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
                <FormField label="Moneda" hint={form.tipo === "propiedad-editar" ? "Una propiedad con movimientos financieros ya registrados no puede cambiar de moneda." : undefined}>
                  <NativeSelect value={form.moneda} onChange={(e) => setForm({ ...form, moneda: aMoneda(e.target.value) })}>
                    {MONEDAS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              </>
            )}
            {form.tipo === "unidad" && (
              <>
                <FormField label="Nombre de la unidad" required>
                  <Input value={form.nombre} maxLength={120} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
                </FormField>
                <FormField label="Propietario">
                  <NativeSelect value={form.propietarioId} onChange={(e) => setForm({ ...form, propietarioId: e.target.value })}>
                    <option value="">Sin propietario</option>
                    {propietarios.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField label="Estancia mínima (noches)">
                  <Input type="number" inputMode="numeric" value={form.noches} onChange={(e) => setForm({ ...form, noches: e.target.value })} />
                </FormField>
              </>
            )}
            {form.tipo === "propietario" && (
              <>
                <FormField label="Nombre" required>
                  <Input value={form.nombre} maxLength={120} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
                </FormField>
                <FormField label="Correo (opcional)">
                  <Input type="email" value={form.email} maxLength={200} placeholder="propietario@ejemplo.com" onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </FormField>
              </>
            )}
          </div>
        )}
      </FormDialog>
    </PageContainer>
  );
}
