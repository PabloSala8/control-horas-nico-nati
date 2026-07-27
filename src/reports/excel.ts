/**
 * Generación del Excel de tracking (sección 12.4 / 13) con `exceljs`.
 * Devuelve un Buffer listo para enviar como documento por Telegram.
 * No toca la DB ni Telegram: recibe todo por parámetro.
 */
import ExcelJS from 'exceljs';
import type { Resumen, TurnoReporte } from '../bot/servicio.ts';
import type { MovimientoDetalle } from '../db/queries.ts';

export interface DatosReporte {
  resumen: Resumen;
  definitivo: boolean;
  generadoEn: string;
  turnos: TurnoReporte[];
  movimientos: MovimientoDetalle[];
}

const MONEDA = '"$"#,##0';
const marca = (d: DatosReporte) =>
  d.definitivo ? `DEFINITIVO — cerrada ${d.generadoEn}` : `PARCIAL — al ${d.generadoEn}`;

export async function generarExcel(d: DatosReporte): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bot Control de Horas';
  wb.created = new Date();

  // ---- Hoja Resumen ----
  const rs = wb.addWorksheet('Resumen');
  rs.mergeCells('A1:J1');
  rs.getCell('A1').value = `Resumen de quincena — ${d.resumen.periodo}`;
  rs.getCell('A1').font = { size: 14, bold: true };
  rs.mergeCells('A2:J2');
  rs.getCell('A2').value = marca(d);
  rs.getCell('A2').font = { italic: true, color: { argb: d.definitivo ? 'FF157347' : 'FFB8860B' } };

  const encabezados = [
    'Empleada', 'Horas', 'Extras (h)', 'Extras ($)', 'Actividades', 'Act. ($)',
    'Préstamos', 'Bonos', 'Base/2', 'NETO',
  ];
  const headerRow = rs.addRow([]);
  rs.addRow(encabezados).font = { bold: true };
  headerRow.height = 4;

  for (const e of d.resumen.empleadas) {
    const horasExtra = e.desglose.extra_diurna + e.desglose.extra_nocturna + e.desglose.dominical;
    rs.addRow([
      e.alias, e.horas, horasExtra, e.valorExtras, e.actividades.cantidad,
      e.actividades.valor, e.prestamos, e.bonos, e.salarioBaseQuincena, e.netoPreliminar,
    ]);
  }
  const totalNeto = d.resumen.empleadas.reduce((s, e) => s + e.netoPreliminar, 0);
  rs.addRow([]);
  const totalRow = rs.addRow(['TOTAL', '', '', '', '', '', '', '', '', totalNeto]);
  totalRow.font = { bold: true };

  // Formato de moneda en las columnas de pesos (D, F, G, H, I, J).
  for (const col of ['D', 'F', 'G', 'H', 'I', 'J']) rs.getColumn(col).numFmt = MONEDA;
  rs.columns.forEach((c) => (c.width = 13));
  rs.getColumn('A').width = 16;

  // ---- Hoja Turnos ----
  // Incluye el rango de reloj del turno y de cada tramo (sección 13). Estos
  // rangos se RECALCULAN al generar (vienen ya calculados en TurnoReporte), no
  // se guardan duplicados en la base de datos. Notación 12h + AM/PM.
  const ts = wb.addWorksheet('Turnos');
  ts.addRow([
    'Fecha', 'Empleada', 'Entrada', 'Salida', 'Horas', 'Ordinaria', 'Extra diurna',
    'Extra nocturna', 'Dominical', 'Valor ($)', 'Rangos por tramo',
  ]).font = { bold: true };
  for (const t of d.turnos) {
    const g = t.desglose_tramos;
    const row = ts.addRow([
      t.fecha, t.alias, t.entrada, t.salida, Number(t.horas_totales), g.ordinaria ?? 0,
      g.extra_diurna ?? 0, g.extra_nocturna ?? 0, g.dominical ?? 0, t.valor_calculado,
      t.rangosPorTramo,
    ]);
    row.getCell('K').alignment = { wrapText: true, vertical: 'top' };
  }
  ts.getColumn('J').numFmt = MONEDA;
  ts.columns.forEach((c) => (c.width = 13));
  ts.getColumn('C').width = 11;
  ts.getColumn('D').width = 11;
  ts.getColumn('K').width = 40;

  // ---- Hoja Movimientos ----
  const ms = wb.addWorksheet('Movimientos');
  ms.addRow(['Fecha', 'Empleada', 'Tipo', 'Monto ($)', 'Nota']).font = { bold: true };
  for (const m of d.movimientos) {
    ms.addRow([m.fecha, m.alias, m.tipo === 'prestamo' ? 'Préstamo' : 'Bono', m.monto, m.nota ?? '']);
  }
  ms.getColumn('D').numFmt = MONEDA;
  ms.columns.forEach((c) => (c.width = 14));
  ms.getColumn('E').width = 30;

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
