// Lectura PURA de los atributos del participante SIP de LiveKit (sin cargar el SDK nativo): numero marcado (DNIS), origen y desvio.
export interface InfoParticipanteSip {
  readonly dnis: string | null;
  readonly sipFrom: string | null;
  readonly desviadaDesde: string | null;
}

/** Lee del participante SIP lo que la telefonia reporta de la llamada. */
export function infoDeParticipanteSip(atributos: Readonly<Record<string, string>>): InfoParticipanteSip {
  const limpio = (v: string | undefined): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= 256 ? v.trim() : null);
  const origen = limpio(atributos["sip.phoneNumber"]);
  // La URI sintetica permite reutilizar `extraerTelefonoSipFrom` (que ya trata "anonymous", "unavailable", etc. como llamante sin telefono).
  const sipFrom = origen === null ? null : `<sip:${origen.replace(/[<>;\s@]/g, "")}@sip.livekit.invalid;user=phone>`;
  let desviada: string | null = null;
  for (const [clave, valor] of Object.entries(atributos)) {
    const k = clave.toLowerCase();
    if (!k.startsWith("sip.h.")) continue;
    if (k.includes("diversion") || k.includes("history-info") || k.includes("forwarded") || k.includes("p-called-party")) {
      desviada = limpio(valor);
      if (desviada) break;
    }
  }
  return { dnis: limpio(atributos["sip.trunkPhoneNumber"]), sipFrom, desviadaDesde: desviada };
}

