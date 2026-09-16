// "Cerebro de ventas" — mapa de prospectos del back office de plataforma. Adaptado
// de la referencia real de Likida (`~/likida.ai/src/app/admin/mapa-prospectos`,
// solo lectura, nunca modificada): mismo vocabulario de embudo (nuevo→contactado→
// demo→propuesta→negociación→ganado/perdido/descartado), adaptado a que aquí un
// prospecto puede comprar CUALQUIERA de las 6 soluciones (columna `vertical` real,
// ver el comentario de cabecera de la migración 0012), no siempre una flota.
//
// Backend real: GET/POST /superadmin/prospectos + PATCH /superadmin/prospectos/:id
// (apps/api/src/routes/superadmin.ts), wireados a las 3 funciones security definer
// de core.prospecto (ya verificadas en producción). Sin acciones fingidas: cambiar
// el estado de la fila dispara el PATCH real al instante (actualización optimista,
// mismo criterio que useNotifications.ts).
import { useEffect, useState, type FormEvent } from "react";
import { Building2, Plus, TrendingUp } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { ModalFormularioLateral } from "../../components/ModalFormularioLateral.tsx";

interface Prospecto {
  readonly id: string;
  readonly empresa: string;
  readonly vertical: string;
  readonly ciudad: string | null;
  readonly contactoNombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly estado: string;
  readonly fuente: string | null;
  readonly notas: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const NOMBRE_VERTICAL: Record<string, string> = {
  hoteles: "Hoteles",
  restaurantes: "Restaurantes",
  citas: "Citas",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  rentas: "Rentas vacacionales",
};

// Mismo orden real del embudo que la migración 0012 -- 5 etapas de avance +
// 3 desenlaces terminales (los últimos 3 se muestran aparte en el resumen).
const ESTADOS: readonly string[] = ["nuevo", "contactado", "demo", "propuesta", "negociacion", "ganado", "perdido", "descartado"];

const NOMBRE_ESTADO: Record<string, string> = {
  nuevo: "Nuevo",
  contactado: "Contactado",
  demo: "Demo",
  propuesta: "Propuesta",
  negociacion: "Negociación",
  ganado: "Ganado",
  perdido: "Perdido",
  descartado: "Descartado",
};

function badgeDeEstado(estado: string) {
  if (estado === "ganado") return <Badge>Ganado</Badge>;
  if (estado === "perdido" || estado === "descartado") return <Badge variant="destructive">{NOMBRE_ESTADO[estado]}</Badge>;
  if (estado === "nuevo") return <Badge variant="secondary">Nuevo</Badge>;
  return <Badge variant="outline">{NOMBRE_ESTADO[estado] ?? estado}</Badge>;
}

const SELECT_CLASES =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const FORM_VACIO = { empresa: "", vertical: "hoteles", ciudad: "", contactoNombre: "", telefono: "", correo: "", fuente: "", notas: "" };

export function SuperAdminProspectosPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [prospectos, setProspectos] = useState<readonly Prospecto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtroVertical, setFiltroVertical] = useState<string>("todos");
  const [filtroEstado, setFiltroEstado] = useState<string>("todos");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(FORM_VACIO);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cambiandoId, setCambiandoId] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/superadmin/prospectos`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("no se pudo cargar");
      const body = (await res.json()) as { prospectos: Prospecto[] };
      setProspectos(body.prospectos);
    } catch {
      setError("No se pudieron cargar los prospectos.");
    }
  }

  useEffect(() => {
    void cargar();
  }, [apiBaseUrl, token]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!form.empresa.trim()) {
      setFormError("La empresa es requerida.");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/superadmin/prospectos`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          empresa: form.empresa.trim(),
          vertical: form.vertical,
          ciudad: form.ciudad || null,
          contactoNombre: form.contactoNombre || null,
          telefono: form.telefono || null,
          correo: form.correo || null,
          fuente: form.fuente || null,
          notas: form.notas || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "No se pudo crear el prospecto.");
      }
      setForm(FORM_VACIO);
      setShowForm(false);
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo crear el prospecto.");
    } finally {
      setSubmitting(false);
    }
  }

  // Actualización optimista -- el mismo criterio que useNotifications.ts: la fila
  // cambia de estado al instante, el PATCH real corre en segundo plano; si falla,
  // se revierte y se muestra el error (nunca deja la UI mintiendo sobre el estado
  // real de un prospecto).
  async function handleCambiarEstado(prospecto: Prospecto, nuevoEstado: string) {
    const anterior = prospectos;
    setProspectos((cur) => (cur ? cur.map((p) => (p.id === prospecto.id ? { ...p, estado: nuevoEstado } : p)) : cur));
    setCambiandoId(prospecto.id);
    try {
      const res = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/superadmin/prospectos/${prospecto.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ estado: nuevoEstado }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setProspectos(anterior);
      setError("No se pudo mover ese prospecto de etapa. Intenta de nuevo.");
    } finally {
      setCambiandoId(null);
    }
  }

  if (error && !prospectos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!prospectos) return <EstadoCargando etiqueta="Cargando prospectos…" />;

  const visibles = prospectos.filter((p) => (filtroVertical === "todos" || p.vertical === filtroVertical) && (filtroEstado === "todos" || p.estado === filtroEstado));
  const activos = prospectos.filter((p) => !["ganado", "perdido", "descartado"].includes(p.estado));
  const ganados = prospectos.filter((p) => p.estado === "ganado").length;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Prospectos</h1>
          <p className="text-sm text-muted-foreground mt-1">A quién podemos venderle cada solución — cerebro de ventas de la plataforma.</p>
        </div>
        <Button onClick={() => setShowForm(true)} className="rounded-full gap-1.5">
          <Plus className="w-4 h-4" strokeWidth={1.75} />
          Nuevo prospecto
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard label="Prospectos totales" value={String(prospectos.length)} icon={Building2} />
        <StatCard label="En proceso" value={String(activos.length)} icon={TrendingUp} />
        <StatCard label="Ganados" value={String(ganados)} icon={Building2} />
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <select value={filtroVertical} onChange={(e) => setFiltroVertical(e.target.value)} className={SELECT_CLASES} aria-label="Filtrar por vertical">
          <option value="todos">Todas las verticales</option>
          {Object.entries(NOMBRE_VERTICAL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value)} className={SELECT_CLASES} aria-label="Filtrar por etapa">
          <option value="todos">Todas las etapas</option>
          {ESTADOS.map((estado) => (
            <option key={estado} value={estado}>
              {NOMBRE_ESTADO[estado]}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{visibles.length === prospectos.length ? "Todos los prospectos" : `${visibles.length} de ${prospectos.length} prospectos`}</CardTitle>
        </CardHeader>
        <CardContent>
          {prospectos.length === 0 ? (
            <EstadoVacio mensaje="Todavía no hay prospectos registrados. Agrega el primero con “Nuevo prospecto”." />
          ) : visibles.length === 0 ? (
            <EstadoVacio mensaje="Ningún prospecto coincide con este filtro." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Empresa</TableHead>
                  <TableHead>Solución</TableHead>
                  <TableHead>Contacto</TableHead>
                  <TableHead>Etapa</TableHead>
                  <TableHead>Fuente</TableHead>
                  <TableHead>Actualizado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibles.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <span className="font-medium text-foreground">{p.empresa}</span>
                      {p.ciudad && <span className="block text-xs text-muted-foreground">{p.ciudad}</span>}
                    </TableCell>
                    <TableCell>{NOMBRE_VERTICAL[p.vertical] ?? p.vertical}</TableCell>
                    <TableCell>
                      {p.contactoNombre && <span className="block text-foreground">{p.contactoNombre}</span>}
                      {(p.telefono || p.correo) && <span className="block text-xs text-muted-foreground">{[p.telefono, p.correo].filter(Boolean).join(" · ")}</span>}
                      {!p.contactoNombre && !p.telefono && !p.correo && <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {badgeDeEstado(p.estado)}
                        <select
                          value={p.estado}
                          onChange={(e) => void handleCambiarEstado(p, e.target.value)}
                          disabled={cambiandoId === p.id}
                          className={SELECT_CLASES}
                          aria-label={`Cambiar etapa de ${p.empresa}`}
                        >
                          {ESTADOS.map((estado) => (
                            <option key={estado} value={estado}>
                              {NOMBRE_ESTADO[estado]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.fuente || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(p.updatedAt).toLocaleDateString("es-MX")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ModalFormularioLateral
        open={showForm}
        onOpenChange={(open) => {
          setShowForm(open);
          if (!open) setFormError(null);
        }}
        titulo="Nuevo prospecto"
        subtitulo="A qué negocio podemos venderle cuál de las 6 soluciones."
        anchoClase="max-w-3xl"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => setShowForm(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" form="form-nuevo-prospecto" className="rounded-full px-6" disabled={submitting}>
              {submitting ? "Guardando…" : "Guardar prospecto"}
            </Button>
          </>
        }
      >
        <form id="form-nuevo-prospecto" onSubmit={handleCreate} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="prospecto-empresa">Empresa *</Label>
            <Input id="prospecto-empresa" value={form.empresa} onChange={(e) => setForm({ ...form, empresa: e.target.value })} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="prospecto-vertical">Solución de interés *</Label>
            <select id="prospecto-vertical" value={form.vertical} onChange={(e) => setForm({ ...form, vertical: e.target.value })} className={SELECT_CLASES + " w-full"}>
              {Object.entries(NOMBRE_VERTICAL).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospecto-ciudad">Ciudad</Label>
              <Input id="prospecto-ciudad" value={form.ciudad} onChange={(e) => setForm({ ...form, ciudad: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospecto-fuente">Fuente</Label>
              <Input id="prospecto-fuente" value={form.fuente} onChange={(e) => setForm({ ...form, fuente: e.target.value })} placeholder="p. ej. referido, LinkedIn, feria" />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="prospecto-contacto">Nombre de contacto</Label>
            <Input id="prospecto-contacto" value={form.contactoNombre} onChange={(e) => setForm({ ...form, contactoNombre: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospecto-telefono">Teléfono</Label>
              <Input id="prospecto-telefono" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prospecto-correo">Correo</Label>
              <Input id="prospecto-correo" type="email" value={form.correo} onChange={(e) => setForm({ ...form, correo: e.target.value })} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="prospecto-notas">Notas</Label>
            <textarea
              id="prospecto-notas"
              value={form.notas}
              onChange={(e) => setForm({ ...form, notas: e.target.value })}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
          {formError && (
            <p role="alert" className="text-[13px] text-destructive">
              {formError}
            </p>
          )}
        </form>
      </ModalFormularioLateral>
    </div>
  );
}
