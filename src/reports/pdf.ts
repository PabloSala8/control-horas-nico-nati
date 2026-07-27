/**
 * Generación del PDF resumen (secciones 12.4 / 13) con `pdfkit`.
 * Devuelve un Buffer. No toca DB ni Telegram.
 */
import PDFDocument from 'pdfkit';
import type { DatosReporte } from './excel.ts';
import { formatoFechaDMYDesde } from '../core/tiempo.ts';

const pesos = (n: number) => '$' + Math.round(n).toLocaleString('es-CO');
const horas = (h: number) => {
  const m = Math.round(h * 60);
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export function generarPdf(d: DatosReporte): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#111').text('Control de Horas — Nico y Nati');
    doc.moveDown(0.2);
    doc.fontSize(14).fillColor('#333').text(`Resumen de quincena · ${d.resumen.periodo}`);
    doc.moveDown(0.2);
    doc
      .fontSize(10)
      .fillColor(d.definitivo ? '#157347' : '#B8860B')
      .text(d.definitivo ? `DEFINITIVO — cerrada ${d.generadoEn}` : `PARCIAL — al ${d.generadoEn}`);
    doc.moveDown(0.8);

    let total = 0;
    for (const e of d.resumen.empleadas) {
      total += e.netoPreliminar;
      const horasExtra = e.desglose.extra_diurna + e.desglose.extra_nocturna + e.desglose.dominical;

      doc.fontSize(13).fillColor('#111').text(e.alias, { underline: true });
      doc.moveDown(0.2);
      doc.fontSize(10).fillColor('#333');
      const fila = (etiqueta: string, valor: string) =>
        doc.text(`${etiqueta}:`, { continued: true }).fillColor('#111').text(`  ${valor}`).fillColor('#333');

      fila('Horas trabajadas', `${horas(e.horas)}  (extras: ${horas(horasExtra)})`);
      fila('Valor extras', pesos(e.valorExtras));
      fila('Actividades', `${e.actividades.cantidad}  (${pesos(e.actividades.valor)})`);
      fila('Salario base (quincena)', pesos(e.salarioBaseQuincena));
      fila('Bonos', pesos(e.bonos));
      fila('Préstamos', `- ${pesos(e.prestamos)}`);
      if (e.pendientes > 0) {
        doc.fillColor('#B00020').text(`(!) ${e.pendientes} marcación(es) pendiente(s)`).fillColor('#333');
      }
      doc.moveDown(0.2);
      doc.fontSize(12).fillColor('#111').text(`NETO: ${pesos(e.netoPreliminar)}`);
      doc.moveDown(0.7);
    }

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(0.4);
    doc.fontSize(13).fillColor('#111').text(`TOTAL NETO: ${pesos(total)}`, { align: 'right' });

    // ---- Detalle de turnos con rangos por tramo (sección 13) ----
    // Recalculados al generar el reporte a partir de la entrada/salida real.
    if (d.turnos.length) {
      doc.moveDown(1);
      doc.fontSize(13).fillColor('#111').text('Detalle de turnos');
      doc.moveDown(0.3);
      for (const t of d.turnos) {
        doc
          .fontSize(10)
          .fillColor('#111')
          .text(`${formatoFechaDMYDesde(t.fecha)} · ${t.alias} · ${t.rangoTurno} (${horas(Number(t.horas_totales))})`);
        doc.fontSize(9).fillColor('#555');
        for (const linea of t.rangosPorTramo.split('\n')) {
          if (linea.trim()) doc.text(`    ${linea}`);
        }
        doc.moveDown(0.3);
      }
    }

    if (!d.definitivo) {
      doc.moveDown(1);
      doc
        .fontSize(8)
        .fillColor('#888')
        .text(
          'Documento PARCIAL: es una foto del momento indicado; no se actualiza solo. ' +
            'Neto preliminar = base/2 + extras + actividades + bonos - prestamos.',
        );
    }

    doc.end();
  });
}
