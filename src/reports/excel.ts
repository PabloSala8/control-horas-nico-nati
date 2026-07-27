/**
 * Generación del Excel de tracking (secciones 13 y 13.1) con `exceljs`.
 * Devuelve un Buffer listo para enviar como documento por Telegram.
 * No toca la DB ni Telegram: recibe todo por parámetro.
 *
 * Estructura (§13.1, legibilidad por empleada — pedido de Nati):
 *  - "Resumen": combinada (vista comparativa de ambas).
 *  - "Turnos — <alias>": una por empleada, con columna de Actividad, resaltado
 *    de horas/valor extra y fila de total de horas extra.
 *  - "Movimientos — <alias>": una por empleada (préstamos y bonos).
 * Cambio de PRESENTACIÓN únicamente — ningún valor calculado cambia.
 */
import ExcelJS from 'exceljs';
import type { Resumen, TurnoReporte, TurnosEmpleadaReporte } from '../bot/servicio.ts';
import type { MovimientoDetalle } from '../db/queries.ts';

export interface DatosReporte {
  resumen: Resumen;
  definitivo: boolean;
  generadoEn: string;
  turnos: TurnoReporte[]; // lo usa el PDF (detalle combinado)
  turnosPorEmpleada: TurnosEmpleadaReporte[]; // §13.1: ya separado por empleada
  movimientos: MovimientoDetalle[];
}

// ---- Paleta y estilos (neutros, sobrios) ----
const MONEDA = '"$"#,##0';
const HORAS = '0.##';
const FILL_HEADER: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4858' } };
const FILL_EXTRA: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBEED2' } };
const FILL_TOTAL: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEFEE' } };
const FONT_HEADER: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' } };
const BORDE: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFD5DBD7' } };
const BORDES: Partial<ExcelJS.Borders> = { top: BORDE, left: BORDE, bottom: BORDE, right: BORDE };

const pesos = (n: number) => '$' + Math.round(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const fechaDMY = (iso: string) => {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
};
const marca = (d: DatosReporte) =>
  d.definitivo ? `DEFINITIVO — cerrada ${d.generadoEn}` : `PARCIAL — al ${d.generadoEn}`;

function tituloHoja(ws: ExcelJS.Worksheet, ancho: number, titulo: string, sub: string, subColor: string) {
  const last = ws.getColumn(ancho).letter;
  ws.mergeCells(`A1:${last}1`);
  ws.getCell('A1').value = titulo;
  ws.getCell('A1').font = { size: 14, bold: true };
  ws.mergeCells(`A2:${last}2`);
  ws.getCell('A2').value = sub;
  ws.getCell('A2').font = { italic: true, color: { argb: subColor } };
}

function encabezado(ws: ExcelJS.Worksheet, labels: string[]): ExcelJS.Row {
  const row = ws.addRow(labels);
  row.height = 24;
  row.eachCell((c) => {
    c.font = FONT_HEADER;
    c.fill = FILL_HEADER;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = BORDES;
  });
  return row;
}

function bordear(row: ExcelJS.Row, nCols: number) {
  for (let i = 1; i <= nCols; i++) row.getCell(i).border = BORDES;
}

export async function generarExcel(d: DatosReporte): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bot Control de Horas';
  wb.created = new Date();
  const subColor = d.definitivo ? 'FF157347' : 'FFB8860B';

  // ======================= Hoja Resumen (combinada) =======================
  const rs = wb.addWorksheet('Resumen');
  tituloHoja(rs, 10, `Resumen de quincena — ${d.resumen.periodo}`, marca(d), subColor);
  const rsCols = ['Empleada', 'Horas', 'Extras (h)', 'Extras ($)', 'Actividades', 'Act. ($)', 'Préstamos', 'Bonos', 'Base/2', 'NETO'];
  encabezado(rs, rsCols);
  for (const e of d.resumen.empleadas) {
    const horasExtra = e.desglose.extra_diurna + e.desglose.extra_nocturna + e.desglose.dominical;
    const row = rs.addRow([
      e.alias, e.horas, horasExtra, e.valorExtras, e.actividades.cantidad,
      e.actividades.valor, e.prestamos, e.bonos, e.salarioBaseQuincena, e.netoPreliminar,
    ]);
    bordear(row, rsCols.length);
  }
  const totalNeto = d.resumen.empleadas.reduce((s, e) => s + e.netoPreliminar, 0);
  const rsTotal = rs.addRow(['TOTAL', '', '', '', '', '', '', '', '', totalNeto]);
  rsTotal.font = { bold: true };
  rsTotal.eachCell((c) => (c.fill = FILL_TOTAL));
  bordear(rsTotal, rsCols.length);
  for (const col of [4, 6, 7, 8, 9, 10]) rs.getColumn(col).numFmt = MONEDA;
  for (const col of [2, 3]) rs.getColumn(col).numFmt = HORAS;
  rs.columns.forEach((c) => (c.width = 13));
  rs.getColumn(1).width = 16;
  rs.getColumn(10).width = 15;

  // ==================== Hojas "Turnos — <alias>" ====================
  // Rango de reloj por tramo recalculado (§13); resaltado de extras y total (§13.1).
  const tCols = [
    'Fecha', 'Entrada', 'Salida', 'Horas', 'Ordinaria (h)', 'Extra diurna (h)', 'Extra diurna ($)',
    'Extra nocturna (h)', 'Extra nocturna ($)', 'Dominical (h)', 'Dominical ($)', 'Actividad',
    'Valor turno ($)', 'Rangos por tramo',
  ];
  const COLS_HORAS = [4, 5, 6, 8, 10];
  const COLS_PESOS = [7, 9, 11, 13];

  for (const emp of d.turnosPorEmpleada) {
    const ts = wb.addWorksheet(`Turnos — ${emp.alias}`);
    tituloHoja(ts, tCols.length, `Turnos — ${emp.alias} · ${d.resumen.periodo}`, marca(d), subColor);
    encabezado(ts, tCols);

    for (const f of emp.filas) {
      const row = ts.addRow([
        fechaDMY(f.fecha), f.entrada, f.salida, f.horas, f.ordinariaH,
        f.extraDiurnaH, f.extraDiurnaV, f.extraNocturnaH, f.extraNocturnaV,
        f.dominicalH, f.dominicalV, f.actividad, f.valorTurno, f.rangosPorTramo,
      ]);
      bordear(row, tCols.length);
      row.getCell(14).alignment = { wrapText: true, vertical: 'top' };
      if (f.soloActividad) {
        // Día con actividad pero sin turno: se distingue en gris cursiva.
        row.eachCell((c) => (c.font = { italic: true, color: { argb: 'FF7C8A81' } }));
      } else {
        // Resalta horas y valor de cada tramo extra QUE TIENE horas (salta a la vista).
        const tramos: [number, number, number | null][] = [
          [6, 7, f.extraDiurnaH], [8, 9, f.extraNocturnaH], [10, 11, f.dominicalH],
        ];
        for (const [hc, vc, h] of tramos) {
          if ((h ?? 0) > 0) {
            ts.getCell(row.number, hc).fill = FILL_EXTRA;
            ts.getCell(row.number, vc).fill = FILL_EXTRA;
          }
        }
      }
    }

    // Fila de total de horas extra (horas y valor en pesos) — §13.1.
    ts.addRow([]);
    const totRow = ts.addRow([
      `TOTAL HORAS EXTRA: ${(+emp.totalExtraHoras.toFixed(2))} h    ·    VALOR EXTRAS: ${pesos(emp.totalExtraValor)}`,
    ]);
    ts.mergeCells(`A${totRow.number}:N${totRow.number}`);
    totRow.font = { bold: true };
    totRow.getCell(1).fill = FILL_TOTAL;
    totRow.getCell(1).alignment = { horizontal: 'left' };
    totRow.height = 18;

    for (const col of COLS_PESOS) ts.getColumn(col).numFmt = MONEDA;
    for (const col of COLS_HORAS) ts.getColumn(col).numFmt = HORAS;
    const anchos: Record<number, number> = { 1: 12, 2: 10, 3: 10, 4: 8, 5: 12, 6: 13, 7: 14, 8: 14, 9: 15, 10: 12, 11: 13, 12: 16, 13: 14, 14: 34 };
    ts.columns.forEach((c, i) => (c.width = anchos[i + 1] ?? 12));
  }

  // ================= Hojas "Movimientos — <alias>" =================
  const mCols = ['Fecha', 'Tipo', 'Monto ($)', 'Nota'];
  for (const emp of d.turnosPorEmpleada) {
    const ms = wb.addWorksheet(`Movimientos — ${emp.alias}`);
    tituloHoja(ms, mCols.length, `Movimientos — ${emp.alias} · ${d.resumen.periodo}`, marca(d), subColor);
    encabezado(ms, mCols);
    const suyos = d.movimientos.filter((m) => m.alias === emp.alias);
    for (const m of suyos) {
      const row = ms.addRow([fechaDMY(m.fecha), m.tipo === 'prestamo' ? 'Préstamo' : 'Bono', m.monto, m.nota ?? '']);
      bordear(row, mCols.length);
    }
    ms.getColumn(3).numFmt = MONEDA;
    [14, 20, 14, 32].forEach((w, i) => (ms.getColumn(i + 1).width = w));
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
