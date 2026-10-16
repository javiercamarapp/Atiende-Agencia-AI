// Catalogo de desarrollo de la familia de overlays (UNI-R0). Solo existe en `vite dev` (ruta /dev/catalogo, ver App.tsx):
// muestra cada primitivo y cada estado para revisarlos y capturarlos en claro, oscuro y 375 px. `?abrir=<id>` abre un
// pop-up al cargar (modal-sm, modal-md, modal-lg, modal-xl, modal-icono, confirmar, peligro, lateral, elegante, hoja, select, menu, centro).
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Bell, ChevronDown, FileX, Inbox, Pencil, Trash2, Truck } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CentroNotificaciones,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormDialogElegante,
  FormField,
  Input,
  Panel,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Selector,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  notify,
  useAmbitoVertical,
  type CentroNotificacionItem,
} from "@atiende/ui";

const ITEMS: readonly CentroNotificacionItem[] = [
  { id: "1", titulo: "Pedido nuevo por aprobar", cuerpo: "Marisol Pech · 3 productos · $245.00", cuando: "hace 2 min", severidad: "atencion", sinLeer: true, enlace: "/dev/catalogo" },
  { id: "2", titulo: "Falló la impresión del ticket", cuerpo: "Revisa la impresora de cocina.", cuando: "hace 18 min", severidad: "critica", sinLeer: true, enlace: "/dev/catalogo" },
  { id: "3", titulo: "Cierre del día listo", cuando: "ayer", severidad: "info", sinLeer: false },
];

type Abierto = null | "modal-sm" | "modal-md" | "modal-lg" | "modal-xl" | "modal-icono" | "confirmar" | "peligro" | "lateral" | "elegante" | "hoja";

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <Panel as="section" aria-labelledby={`s-${titulo}`}>
      <h2 id={`s-${titulo}`} className="font-mono text-eyebrow uppercase tracking-[0.08em] text-muted-foreground">
        {titulo}
      </h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </Panel>
  );
}

export function CatalogoOverlaysPage() {
  const [params] = useSearchParams();
  // Ambito de restaurantes (UNI-R0b), como en las pantallas reales. `?ambito=ninguno` apaga la paleta/botones/overlays del repo suelto
  // para capturar el "antes" (otra vertical) con el mismo estado.
  useAmbitoVertical(params.get("ambito") === "ninguno" ? "ninguno" : "restaurantes");
  const inicial = params.get("abrir");
  const [abierto, setAbierto] = useState<Abierto>(inicial && inicial.startsWith("modal") ? (inicial as Abierto) : (["confirmar", "peligro", "lateral", "elegante", "hoja"].includes(inicial ?? "") ? (inicial as Abierto) : null));
  const [valor, setValor] = useState("pendiente");
  const [centroListo, setCentroListo] = useState<"cargando" | "error" | "listo">("listo");
  useEffect(() => {
    document.title = "Catálogo de overlays";
  }, []);
  const cerrar = (v: boolean) => !v && setAbierto(null);
  const modal = (id: Exclude<Abierto, null>, size: "sm" | "md" | "lg" | "xl") => (
    <Dialog open={abierto === id} onOpenChange={cerrar}>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>Ventana {size.toUpperCase()}</DialogTitle>
          <DialogDescription>Texto de apoyo con el ancho cómodo de este tamaño.</DialogDescription>
        </DialogHeader>
        <p className="text-ui text-muted-foreground">Contenido de ejemplo del pop-up.</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAbierto(null)}>
            Cancelar
          </Button>
          <Button onClick={() => setAbierto(null)}>Aceptar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <TooltipProvider>
      <main className="mx-auto grid max-w-5xl gap-4 p-4">
        <h1 className="font-display text-xl font-semibold">Catálogo de overlays</h1>
        <p className="text-ui text-muted-foreground">Ruta de desarrollo: cada primitivo y estado de la familia única de pop-ups, listas, toasts y estados.</p>

        <Seccion titulo="Modales">
          {(["sm", "md", "lg", "xl"] as const).map((s) => (
            <Button key={s} variant="outline" onClick={() => setAbierto(`modal-${s}`)}>
              Modal {s}
            </Button>
          ))}
          <Button variant="outline" onClick={() => setAbierto("modal-icono")}>
            Con icono
          </Button>
          <Button variant="outline" onClick={() => setAbierto("confirmar")}>
            Confirmar
          </Button>
          <Button variant="danger" onClick={() => setAbierto("peligro")}>
            Confirmación destructiva
          </Button>
          <Button variant="outline" onClick={() => setAbierto("lateral")}>
            Formulario lateral
          </Button>
          <Button variant="outline" onClick={() => setAbierto("elegante")}>
            Formulario elegante
          </Button>
          <Button variant="outline" onClick={() => setAbierto("hoja")}>
            Hoja / drawer
          </Button>
        </Seccion>
        {modal("modal-sm", "sm")}
        {modal("modal-md", "md")}
        {modal("modal-lg", "lg")}
        {modal("modal-xl", "xl")}
        <Dialog open={abierto === "modal-icono"} onOpenChange={cerrar}>
          <DialogContent size="md">
            <DialogHeader icono={Truck}>
              <DialogTitle>Asignar repartidor</DialogTitle>
              <DialogDescription>Elige quién llevará el pedido N.º 1001.</DialogDescription>
            </DialogHeader>
            <FormField label="Repartidor">
              <Selector value={valor} onValueChange={setValor}>
                <option value="pendiente">Sin asignar</option>
                <option value="ana">Ana López</option>
                <option value="luis">Luis Pérez</option>
              </Selector>
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAbierto(null)}>
                Cancelar
              </Button>
              <Button onClick={() => setAbierto(null)}>Confirmar envío</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <ConfirmDialog open={abierto === "confirmar"} onOpenChange={cerrar} titulo="¿Publicar los cambios?" descripcion="Los clientes verán el menú nuevo de inmediato." confirmar="Publicar" onConfirm={() => void notify.success("Cambios publicados")} />
        <ConfirmDialog open={abierto === "peligro"} onOpenChange={cerrar} titulo="¿Cancelar este pedido?" descripcion={'N.º 1001 — Marisol Pech pasará a "Cancelado" y saldrá de Recibidos.'} tono="danger" confirmar="Sí, cancelar pedido" cancelar="Volver" onConfirm={() => void notify.warning("Pedido cancelado")} />
        <FormDialog open={abierto === "lateral"} onOpenChange={cerrar} titulo="Reportar incidencia" subtitulo="N.º 1001 — Marisol Pech" onGuardar={() => setAbierto(null)} textoBotonGuardar="Reportar incidencia" anchoClase="max-w-3xl">
          <FormField label="¿Qué pasó?" hint="Obligatorio">
            <Input placeholder="Ej. dirección incorrecta, cliente no contesta…" />
          </FormField>
        </FormDialog>
        <FormDialogElegante open={abierto === "elegante"} onOpenChange={cerrar} icono={Pencil} titulo="Editar horario" subtitulo="Días y horas en que recibes pedidos" onGuardar={() => setAbierto(null)}>
          <FormField label="Apertura">
            <Input defaultValue="09:00" />
          </FormField>
          <FormField label="Cierre" error="Debe ser posterior a la apertura">
            <Input defaultValue="08:00" />
          </FormField>
        </FormDialogElegante>
        <Sheet open={abierto === "hoja"} onOpenChange={cerrar}>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Panel lateral</SheetTitle>
              <SheetDescription>Detalle contextual que entra desde la derecha.</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>

        <Seccion titulo="Listas y menús">
          <div className="w-56">
            <Selector aria-label="Estado" value={valor} onValueChange={setValor}>
              <option value="pendiente">Pendiente</option>
              <option value="preparando">Preparando</option>
              <option value="listo">Listo para recoger</option>
              <option value="x" disabled>
                No disponible
              </option>
            </Selector>
          </div>
          <div className="w-56">
            <Selector aria-label="Zona" value="" onValueChange={() => {}} placeholder="Selecciona una zona">
              <optgroup label="Norte">
                <option value="a">Centro</option>
              </optgroup>
              <optgroup label="Sur">
                <option value="b">Itzimná</option>
              </optgroup>
            </Selector>
          </div>
          <div className="w-56">
            <Selector aria-label="Con error" aria-invalid="true" value="a" onValueChange={() => {}}>
              <option value="a">Con error</option>
            </Selector>
          </div>
          <div className="w-56">
            <Selector aria-label="Deshabilitado" disabled value="a" onValueChange={() => {}}>
              <option value="a">Deshabilitado</option>
            </Selector>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" iconRight={<ChevronDown />}>
                Acciones
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Pedido N.º 1001</DropdownMenuLabel>
              <DropdownMenuItem>
                <Pencil /> Editar
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Truck /> Asignar repartidor
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <Trash2 /> Cancelar
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Popover</Button>
            </PopoverTrigger>
            <PopoverContent>
              <p className="text-ui">Contenido flotante con la misma superficie que la lista y el menú.</p>
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Notificaciones">
                <Bell />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Notificaciones</TooltipContent>
          </Tooltip>
        </Seccion>

        <Seccion titulo="Toasts y notificaciones">
          <Button variant="outline" onClick={() => notify.success("Pedido guardado", { description: "El cliente recibirá el aviso." })}>
            Éxito
          </Button>
          <Button variant="outline" onClick={() => notify.error("No se pudo guardar", { description: "Revisa tu conexión e inténtalo de nuevo." })}>
            Error
          </Button>
          <Button variant="outline" onClick={() => notify.warning("Quedan 3 productos sin precio")}>
            Advertencia
          </Button>
          <Button variant="outline" onClick={() => notify.info("Sincronizando con la caja")}>
            Info
          </Button>
          <Button variant="outline" onClick={() => notify.success("Pedido eliminado", { deshacer: { onClick: () => notify.info("Restaurado") } })}>
            Con «Deshacer»
          </Button>
          <Button variant="outline" onClick={() => notify.info("Nuevo pedido recibido", { accion: { etiqueta: "Ver", onClick: () => {} } })}>
            Con «Ver»
          </Button>
          <Button variant="outline" onClick={() => void notify.promise(new Promise((r) => setTimeout(r, 1800)), { cargando: "Guardando…", exito: "Guardado", error: "Falló" })}>
            Cargando → éxito
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              for (const n of [1, 2, 3, 4, 5]) notify.info(`Aviso ${n}`);
            }}
          >
            Apilar 5 (muestra 3)
          </Button>
          <CentroNotificaciones href="/dev/catalogo" hayNoLeidas items={ITEMS} estado={centroListo} onAbrir={() => setCentroListo("listo")} onLeer={() => {}} onMarcarTodas={() => {}} />
          <Button variant="ghost" size="xs" onClick={() => setCentroListo("cargando")}>
            Centro: cargando
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setCentroListo("error")}>
            Centro: error
          </Button>
        </Seccion>

        <Seccion titulo="Paneles y estados">
          <Panel className="w-64">
            <p className="text-sm font-medium">Panel (tarjeta de sección)</p>
            <p className="text-ui text-muted-foreground">Una sola receta de borde, radio y relleno.</p>
          </Panel>
          <Card className="w-64">
            <CardHeader>
              <CardTitle>Card</CardTitle>
            </CardHeader>
            <CardContent className="text-ui text-muted-foreground">Misma receta, relleno por pieza.</CardContent>
          </Card>
          <div className="w-72">
            <EstadoVacio variante="centrado" icon={Inbox} titulo="Sin pedidos" mensaje="Cuando llegue uno nuevo lo verás aquí." />
          </div>
          <div className="w-72">
            <EstadoVacio variante="fila" icon={FileX} mensaje="Sin datos en este periodo." />
          </div>
          <div className="w-72">
            <EstadoCargando lineas={3} etiqueta="Cargando pedidos" />
          </div>
          <div className="grid w-72 gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          <div className="w-72">
            <EstadoError mensaje="No se pudo cargar." onReintentar={() => {}} />
          </div>
        </Seccion>
      </main>
    </TooltipProvider>
  );
}
