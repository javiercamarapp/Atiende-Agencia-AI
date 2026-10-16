import { useEffect, useRef } from "react";
import { mountParticleGlobe } from "./particle-globe.ts";

type Shape = "sphere" | "torus" | "octahedron" | "cube" | "helix" | "double-ring";

export const LOGIN_STORIES: Record<string, {
  title: string;
  description: string;
  steps: readonly string[];
  shape: Shape;
}> = {
  restaurantes: {
    title: "Cada pedido. Toda tu operación.",
    description: "Conversaciones, pedidos y clientes en un mismo lugar. Tu equipo tiene el contexto para llevar cada servicio hasta el final.",
    steps: ["Atención", "Operación", "Clientes"],
    shape: "sphere",
  },
  hoteles: {
    title: "Una estancia bien coordinada, de principio a fin.",
    description: "Reservas, recepción y servicio conectados. Cada solicitud llega al equipo indicado y cada huésped conserva su historia.",
    steps: ["Reservas", "Estancias", "Servicio"],
    shape: "torus",
  },
  rentas: {
    title: "Tus propiedades. Una operación conectada.",
    description: "Calendarios, huéspedes y mantenimiento con un mismo contexto. Sigue cada estancia y conserva la visibilidad de tu portafolio.",
    steps: ["Propiedades", "Estancias", "Coordinación"],
    shape: "double-ring",
  },
  despachos: {
    title: "Menos pendientes. Más claridad para tu despacho.",
    description: "Documentos, conciliaciones y cierres en un solo flujo. Tu equipo revisa las excepciones y conserva el control de cada cliente.",
    steps: ["Documentos", "Conciliación", "Cierre"],
    shape: "cube",
  },
  licitaciones: {
    title: "De la oportunidad al siguiente paso.",
    description: "Requisitos, documentos y fechas con responsables claros. Acompaña cada licitación con la información que tu equipo necesita para decidir.",
    steps: ["Oportunidades", "Expedientes", "Seguimiento"],
    shape: "octahedron",
  },
  citas: {
    title: "Tu agenda en orden. Tus clientes, bien atendidos.",
    description: "Disponibilidad, citas y seguimiento conectados. Coordina a tu equipo y mantén el contexto de cada visita.",
    steps: ["Disponibilidad", "Reservas", "Seguimiento"],
    shape: "helix",
  },
};

export function LoginArtwork({ vertical }: { readonly vertical: string }) {
  const story = LOGIN_STORIES[vertical] ?? LOGIN_STORIES.restaurantes!;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof matchMedia !== "function") return;
    return mountParticleGlobe(canvas, "sphere", true);
  }, [story.shape]);
  return <div className="login-artwork" data-shape="sphere" aria-hidden="true">
    <canvas ref={canvasRef} className="login-particles" />
    <div className="login-artwork-floor" />
  </div>;
}
