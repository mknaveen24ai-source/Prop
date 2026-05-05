export function normalizeAdminListResponse(data) {
  if (Array.isArray(data)) {
    return {
      summary: {},
      rows: data,
      pagination: { current: 1, total: 1, total_items: data.length, page_size: data.length || 1 },
      facets: {},
      default_sort: { key: 'created_at', direction: 'desc' },
      saved_view_capabilities: null
    };
  }

  return {
    summary: data?.summary || {},
    rows: Array.isArray(data?.rows) ? data.rows : [],
    pagination: data?.pagination || { current: 1, total: 1, total_items: 0, page_size: 25 },
    facets: data?.facets || {},
    default_sort: data?.default_sort || { key: 'created_at', direction: 'desc' },
    saved_view_capabilities: data?.saved_view_capabilities || null
  };
}

export async function exportAdminResource(adminAxios, resource, query) {
  const response = await adminAxios.post(
    '/api/admin/export',
    {
      resource,
      search: query.search || '',
      sort: query.sort,
      order: query.order,
      filters: query.filters || {}
    },
    {
      responseType: 'blob'
    }
  );

  const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  const disposition = response.headers?.['content-disposition'] || '';
  const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
  link.href = url;
  link.setAttribute('download', fileNameMatch?.[1] || `${resource}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}
