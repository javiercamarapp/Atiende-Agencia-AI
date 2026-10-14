export { cn } from "./lib/utils.js";
export { GRAFICA_TEMA, duracionEntradaGrafica } from "./lib/graficas-tema.js";
export { formatMoney } from "./lib/formatMoney.js";
export { contraste, luminancia, parseHsl, type Hsl } from "./lib/contraste.js";
export { useAmbitoVertical, ATRIBUTO_AMBITO } from "./lib/ambito.js";

// Ticket de cocina imprimible (restaurantes, PM PR-7).
export {
  construirTicketCocina,
  escaparHtml,
  folioTicket,
  imprimirTicketsCocina,
  limpiarTexto,
  renderDocumentoTicketsCocina,
  renderTicketCocinaHtml,
  separarNotas,
  TICKET_COCINA_CSS,
  TICKET_COCINA_CSS_DOCUMENTO,
  type OpcionesTicketCocina,
  type TicketCanal,
  type TicketCocina,
  type TicketCocinaLinea,
  type TicketPedidoFuente,
  type TicketPedidoItem,
} from "./lib/ticketCocina.js";
export { pedidosPorImprimir, type PedidoParaCola } from "./lib/colaImpresionCocina.js";
export { TicketCocinaDialog, TicketCocinaVista, type TicketCocinaDialogProps, type TicketCocinaVistaProps } from "./components/TicketCocinaDialog.js";

export { GoogleIcon } from "./components/GoogleIcon.js";
export { AtiendeMark, AtiendeWordmark } from "./components/AtiendeLogo.js";
export { ThemeSelector } from "./components/ThemeSelector.js";
export { StatCard, TrendStatCard, type StatCardVariante } from "./components/StatCard.js";
export { EstadoVacio, VarianteEstadoVacioProvider } from "./components/EstadoVacio.js";
export { EstadoError } from "./components/EstadoError.js";
export { EstadoCargando, type EstadoCargandoVariante } from "./components/EstadoCargando.js";
export { ConfirmDialog, validarCampoConfirm, type ConfirmCampo, type ConfirmDialogProps, type ConfirmTono } from "./components/ConfirmDialog.js";
export { useConfirm, type OpcionesConfirmar, type OpcionesPedirTexto, type UseConfirm } from "./components/useConfirm.js";
export { FormDialog, type FormDialogPaso, type FormDialogProps } from "./components/FormDialog.js";
export { FormDialogElegante, type FormDialogEleganteProps } from "./components/FormDialogElegante.js";
export {
  DataTable,
  ordenarFilas,
  type DataTableColumna,
  type DataTableDireccion,
  type DataTableEstado,
  type DataTableOrden,
  type DataTableProps,
  type DataTableValorOrden,
} from "./components/DataTable.js";
export { PageHeader, type PageHeaderAtras, type PageHeaderMiga, type PageHeaderProps } from "./components/PageHeader.js";
export { PageContainer, type PageContainerProps } from "./components/PageContainer.js";
export { Callout, CALLOUT_TONES, type CalloutProps, type CalloutTone } from "./components/Callout.js";
export { Sidebar, categoriaDeRuta, type SidebarItem, type SidebarSection, type SidebarProps, type SidebarPiePildora, type SidebarUser } from "./components/Sidebar.js";
export { MobileAccountMenu, type MobileAccountMenuProps } from "./components/MobileAccountMenu.js";
export { BottomNav, BOTTOM_NAV_MAX_DESTINOS, MobileHeader, type BottomNavItem, type BottomNavProps, type MobileHeaderTitulo } from "./components/BottomNav.js";
export {
  VerticalShell,
  VerticalShellEstado,
  useTituloBarra,
  useAccionesBarra,
  useMarcoShell,
  VerticalNoEncontrado,
  RutaBoundary,
  construirMigas,
  VERTICAL_SHELL_MAIN_ID,
  type VerticalMiga,
  type VerticalNoEncontradoProps,
  type VerticalShellEstadoProps,
  type VerticalShellProps,
} from "./components/VerticalShell.js";
export { BarraPagina, type BarraPaginaProps } from "./components/BarraPagina.js";
export {
  ChatDatosDialog,
  formatChatCell,
  type ChatDatosDialogProps,
  type ChatDatosMensaje,
  type ChatDatosBloque,
  type ChatDatosColumna,
  type ChatDatosFuente,
  type ChatDatosCell,
  type ChatDatosSinIa,
  type ChatDatosOpcionSinIa,
} from "./components/ChatDatosDialog.js";
export * from "./components/copiloto/index.js";
export { NotificationBell, type NotificationBellProps } from "./components/NotificationBell.js";
export { CentroNotificaciones, type CentroNotificacionesProps, type CentroNotificacionItem, type CentroSeveridad } from "./components/CentroNotificaciones.js";

export { Button, buttonVariants, TEXTO_GUARDANDO, type ButtonProps } from "./components/ui/button.js";
export { Panel, Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent } from "./components/ui/card.js";
export { Badge, badgeVariants, type BadgeProps } from "./components/ui/badge.js";
export { StatusBadge, STATUS_TONES, statusTone, type StatusBadgeProps, type StatusTone } from "./components/ui/status-badge.js";
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "./components/ui/table.js";
export { Input } from "./components/ui/input.js";
export { Textarea, type TextareaProps } from "./components/ui/textarea.js";
export { NativeSelect, nativeSelectVariants, type NativeSelectProps } from "./components/ui/native-select.js";
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
  Selector,
  valorComoTexto,
  type SelectorProps,
  type SelectTriggerProps,
} from "./components/ui/select.js";
export { TAMANOS_MODAL, CHIP_ICONO_MODAL, SUPERFICIE_FLOTANTE, type TamanoModal } from "./components/ui/superficies.js";
export { Checkbox, type CheckboxProps } from "./components/ui/checkbox.js";
export { Switch, type SwitchProps } from "./components/ui/switch.js";
export { FormField, type FormFieldControlProps, type FormFieldProps } from "./components/ui/form-field.js";
export { Label } from "./components/ui/label.js";
export { Separator } from "./components/ui/separator.js";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs.js";
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./components/ui/tooltip.js";
export { Skeleton } from "./components/ui/skeleton.js";
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog.js";
export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "./components/ui/alert-dialog.js";
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from "./components/ui/sheet.js";
export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent } from "./components/ui/popover.js";
export { Avatar, AvatarImage, AvatarFallback } from "./components/ui/avatar.js";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
} from "./components/ui/dropdown-menu.js";
export { Toaster, toast, notify, DURACION_NOTIFY_MS, TOASTS_VISIBLES, type NotifyDeshacer, type NotifyOpciones } from "./components/ui/sonner.js";

// Seguimiento de solicitudes de derechos ARCO (citas, C-02).
export {
  SolicitudesArcoPanel,
  SOLICITUD_ARCO_DERECHO_LABEL,
  SOLICITUD_ARCO_ESTADO_LABEL,
  accionesDisponibles,
  type SolicitudArcoAccion,
  type SolicitudArcoDerecho,
  type SolicitudArcoEstado,
  type SolicitudArcoPlazo,
  type SolicitudArcoVista,
  type SolicitudesArcoPanelProps,
} from "./components/privacidad/SolicitudesArcoPanel.js";

// Experiencia de voz (orbe, transcripción, vista previa de llamada) -- contrato
// neutro de proveedor en components/voz/tipos.ts.
export {
  ESTADO_SESION_INICIAL,
  MODOS_ORB,
  sesionActiva,
  type ErrorSesionVoz,
  type LineaTranscripcion,
  type ModoOrb,
  type OpcionesIniciarSesionVoz,
  type VoiceSessionController,
  type VoiceSessionState,
} from "./components/voz/tipos.js";
export {
  crearMedidorVolumen,
  limitar01,
  medirStream,
  nivelDesdeMuestras,
  suavizarConAtaque,
  suavizarVolumen,
  type AnalizadorMinimo,
  type MedidorDeStream,
  type MedidorVolumen,
} from "./components/voz/medidor-volumen.js";
export { CampoPixeles } from "./components/voz/CampoPixeles.js";
export { TextoEscribiendose } from "./components/voz/TextoEscribiendose.js";
export { ETIQUETA_MODO_ORB, OrbeAgente, volumenObjetivo, type OrbeAgenteProps } from "./components/voz/OrbeAgente.js";
export { TranscripcionEnVivo, type TranscripcionEnVivoProps } from "./components/voz/TranscripcionEnVivo.js";
export { VistaPreviaLlamada, type VistaPreviaLlamadaProps } from "./components/voz/VistaPreviaLlamada.js";
export * from "./components/resumen-piezas.js";
export * from "./components/consola-kit.js";
export * from "./components/graficas-cfo.js";
