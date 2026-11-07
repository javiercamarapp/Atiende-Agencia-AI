// Los Taquitos de PM expresado como DATOS de la plantilla (Fase A). El prompt que sale de aqui debe ser IDENTICO byte a byte al de
// `buildPmSystemPrompt` con sus valores historicos (lo prueba tests/plantilla-pm-dorado.spec.ts contra huellas congeladas).
// `salsasTexto`, `promosTexto` y `pedidoGrandeTexto` van en `null` A PROPOSITO: con `null` el prompt toma las constantes `PM_*_POR_OMISION`
// de perfil-pm.ts (otra redaccion que si se pasara el texto explicito). El menu completo de PM vive en su seed
// (scripts/seed-pm-demo/data/pm-seed-data.json) y no se duplica aqui: esta config se valida con `soloPerfil`.
import type { RestauranteConfig } from "./tipos.ts";
import { ESQUEMA_RESTAURANTE_VERSION } from "./tipos.ts";

const TODOS_LOS_DIAS = [0, 1, 2, 3, 4, 5, 6] as const;
const GENERAL = [{ dias: TODOS_LOS_DIAS, abre: "12:00", cierra: "01:00" }] as const;

export const PM_RESTAURANTE_CONFIG: RestauranteConfig = {
  schemaVersion: ESQUEMA_RESTAURANTE_VERSION,
  slug: "los-taquitos-de-pm",
  marca: {
    nombre: "Los Taquitos de PM",
    agente: null,
    saludo: null,
    tiempoEntrega: "a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)",
  },
  negocio: { giro: "taquería", articuloGiro: "la", ciudad: "Mérida, Yucatán", zonaHoraria: "America/Merida" },
  sucursales: [
    { slug: "prol-montejo", nombre: "Prolongación Montejo", direccion: null, telefono: null, activa: true, reparte: true, horario: GENERAL },
    { slug: "fco-montejo", nombre: "Francisco de Montejo", direccion: null, telefono: null, activa: false, reparte: true, horario: GENERAL },
    { slug: "pensiones", nombre: "Pensiones", direccion: null, telefono: null, activa: true, reparte: true, horario: GENERAL },
    { slug: "galerias", nombre: "Galerías", direccion: null, telefono: null, activa: false, reparte: true, horario: GENERAL },
    { slug: "playa", nombre: "Playa (Chicxulub)", direccion: null, telefono: null, activa: false, reparte: true, horario: GENERAL },
    { slug: "garcia-lavin", nombre: "García Lavín (Victory Platz)", direccion: null, telefono: null, activa: true, reparte: true, horario: GENERAL },
    { slug: "altabrisa", nombre: "Victory Altabrisa", direccion: null, telefono: null, activa: false, reparte: true, horario: GENERAL },
  ],
  menu: { categorias: [], productos: [] },
  politicas: {
    pedidoMinimoDomicilio: 200,
    costoEnvio: 0,
    propina: "nunca",
    transferencia: "no",
    promosTexto: null,
    salsasTexto: null,
    pedidoGrandeTexto: null,
    urlFacturacion: null,
    motivosDesactivados: [],
  },
  promociones: [],
  conocimiento: [],
  voz: { habilitada: false },
};
