// Shared helpers for the Analytics section — kept local to this folder
// since no equivalent exists yet anywhere else in the admin app.

export function pnlColor(value) {
  return value >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)';
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => c.header);
  const lines = rows.map((row) =>
    columns.map((c) => `"${String(c.value(row)).replace(/"/g, '""')}"`).join(',')
  );
  return [header.join(','), ...lines].join('\n');
}

export function downloadCsv(filename, rows, columns) {
  const blob = new Blob([toCsv(rows, columns)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export const DATE_PRESETS = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'all', label: 'All' },
];

export function presetToRange(presetKey) {
  const to = new Date();
  const from = new Date();
  if (presetKey === 'week') from.setDate(to.getDate() - 7);
  else if (presetKey === 'month') from.setMonth(to.getMonth() - 1);
  else if (presetKey === 'quarter') from.setMonth(to.getMonth() - 3);
  else return { from: '', to: '' };
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
