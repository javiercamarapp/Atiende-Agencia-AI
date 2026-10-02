// Rn-29 -- errores de dominio del cifrado de las instrucciones de acceso. Las rutas los traducen a
// 503 explicito ("no disponible: falta RENTAS_ACCESS_KEY"), nunca a un 500 ni a texto plano.

/** No se puede cifrar/descifrar en este entorno: llave ausente, invalida o de otra version. */
export class AccesoNoDisponibleError extends Error {
  constructor(readonly reason: "llave_no_configurada" | "llave_invalida" | "llave_version_no_disponible") {
    super(
      reason === "llave_no_configurada"
        ? "no disponible: falta RENTAS_ACCESS_KEY (llave de cifrado de las instrucciones de acceso)."
        : reason === "llave_invalida"
          ? "no disponible: RENTAS_ACCESS_KEY es invalida (se esperaba base64 de 32 bytes)."
          : "no disponible: la llave de la version guardada no esta configurada en este entorno.",
    );
    this.name = "AccesoNoDisponibleError";
  }
}

/** El sobre no se pudo autenticar: llave equivocada, sobre alterado o ligado a otra unidad/campo. */
export class AccesoDescifradoError extends Error {
  constructor() {
    super("No se pudieron descifrar las instrucciones de acceso: sobre alterado, llave incorrecta o ligado a otro registro.");
    this.name = "AccesoDescifradoError";
  }
}
