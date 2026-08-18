/**
 * Genera los íconos PNG de la aplicación instalable.
 *
 *   npx tsx scripts/generar-iconos.ts
 *
 * Se rasterizan acá en lugar de versionar binarios: el ícono queda
 * reproducible y cambiarlo es editar números, no abrir un editor de
 * imágenes. Un SVG alcanzaría para Chrome, pero varios navegadores todavía
 * exigen PNG para ofrecer la instalación.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../src/ui");

type Color = [number, number, number];

const VERDE_CLARO: Color = [0x14, 0x79, 0x6a];
const VERDE_OSCURO: Color = [0x0a, 0x2b, 0x26];

/** Trazo del pulso, en coordenadas de un lienzo de 512. */
const PULSO: [number, number][] = [
  [158, 300], [212, 300], [242, 228], [282, 344], [312, 264], [354, 264],
];

function mezclar(a: Color, b: Color, t: number): Color {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Distancia de un punto al segmento AB. Define el grosor del trazo. */
function distanciaASegmento(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const largo = dx * dx + dy * dy;
  const t = largo === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / largo));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Cobertura de un píxel, muestreada en una grilla de 3×3.
 *
 * Sin esto los bordes curvos quedan dentados: el ícono se ve casero
 * justamente en el tamaño chico, que es donde más se mira.
 */
function cobertura(x: number, y: number, dentro: (px: number, py: number) => boolean): number {
  let cuenta = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      if (dentro(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) cuenta++;
    }
  }
  return cuenta / 9;
}

function dibujar(lado: number, margen: number): Buffer {
  const escala = lado / 512;
  const pixeles = Buffer.alloc(lado * lado * 4);

  const borde = margen * lado;
  const util = lado - borde * 2;
  const radio = util * 0.22;

  const enRedondeado = (px: number, py: number) => {
    const x = px - borde;
    const y = py - borde;
    if (x < 0 || y < 0 || x > util || y > util) return false;
    const cx = Math.min(Math.max(x, radio), util - radio);
    const cy = Math.min(Math.max(y, radio), util - radio);
    return Math.hypot(x - cx, y - cy) <= radio;
  };

  const grosor = 26 * escala * (util / lado);
  const enPulso = (px: number, py: number) => {
    for (let i = 0; i < PULSO.length - 1; i++) {
      const a = PULSO[i]!;
      const b = PULSO[i + 1]!;
      const d = distanciaASegmento(
        px, py,
        borde + a[0] * (util / 512), borde + a[1] * (util / 512),
        borde + b[0] * (util / 512), borde + b[1] * (util / 512)
      );
      if (d <= grosor / 2) return true;
    }
    return false;
  };

  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      const i = (y * lado + x) * 4;
      const fondo = cobertura(x, y, enRedondeado);
      if (fondo === 0) continue;

      const t = (x / lado + y / lado) / 2;
      const base = mezclar(VERDE_CLARO, VERDE_OSCURO, t);
      const trazo = cobertura(x, y, enPulso);
      const color = mezclar(base, [255, 255, 255], trazo);

      pixeles[i] = color[0];
      pixeles[i + 1] = color[1];
      pixeles[i + 2] = color[2];
      pixeles[i + 3] = Math.round(fondo * 255);
    }
  }

  return codificarPng(pixeles, lado, lado);
}

/* ------------------------------------------------------------ PNG ---- */

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(datos: Buffer): number {
  let c = 0xffffffff;
  for (const byte of datos) c = TABLA_CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function trozo(tipo: string, datos: Buffer): Buffer {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo));
  return Buffer.concat([largo, cuerpo, crc]);
}

function codificarPng(pixeles: Buffer, ancho: number, alto: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Cada línea va precedida por su byte de filtro; 0 significa «sin filtro».
  const lineas = Buffer.alloc(alto * (ancho * 4 + 1));
  for (let y = 0; y < alto; y++) {
    const desde = y * ancho * 4;
    lineas[y * (ancho * 4 + 1)] = 0;
    pixeles.copy(lineas, y * (ancho * 4 + 1) + 1, desde, desde + ancho * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo("IHDR", ihdr),
    trozo("IDAT", deflateSync(lineas, { level: 9 })),
    trozo("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ salida -- */

const SALIDAS = [
  { archivo: "icono-192.png", lado: 192, margen: 0 },
  { archivo: "icono-512.png", lado: 512, margen: 0 },
  // El recorte seguro de Android come hasta un 20% del borde: la variante
  // «maskable» se dibuja con margen para que no le corte el pulso.
  { archivo: "icono-maskable-512.png", lado: 512, margen: 0.14 },
];

for (const { archivo, lado, margen } of SALIDAS) {
  const png = dibujar(lado, margen);
  writeFileSync(join(UI, archivo), png);
  console.log(`  ${archivo.padEnd(26)} ${lado}×${lado}  ${(png.length / 1024).toFixed(1)} kB`);
}
