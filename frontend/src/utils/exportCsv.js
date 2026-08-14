// Shared CSV-export mechanics — escaping, blob creation, download trigger.
// Column definitions (what goes in each row) stay local to each caller;
// this only centralizes the "turn rows into a downloaded .csv file" part
// that used to be reimplemented per-page.
function csvSafeValue(val) {
  let str = String(val ?? '').replace(/"/g, '""')
  if (/^[=+\-@\t\r]/.test(str)) str = "'" + str
  return `"${str}"`
}

export function downloadCSV(filename, headers, rows) {
  const csvContent = [headers, ...rows].map((row) => row.map(csvSafeValue).join(',')).join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * @param {Array<object>} rows
 * @param {Array<{ header: string, value: (row: object) => string|number }>} columns
 * @param {string} filename
 */
export function exportRowsToCSV(rows, columns, filename) {
  if (!rows || rows.length === 0) return
  const headers = columns.map((c) => c.header)
  const dataRows = rows.map((row) => columns.map((c) => c.value(row)))
  downloadCSV(filename, headers, dataRows)
}
