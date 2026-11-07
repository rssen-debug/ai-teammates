// Shared, deterministic catalog semantics. Missing prices never mean free.
export function normalizeCatalog(payload) {
  const rows = payload?.data || payload?.models || payload?.output?.models || [];
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const m = typeof row === 'string' ? { id: row } : row || {};
    const id = m.id || m.model || (m.name?.startsWith('models/') ? m.name.slice(7) : m.name);
    const p = m.pricing;
    const number = (v) => !['number', 'string'].includes(typeof v) || String(v).trim() === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v);
    const input = number(p?.prompt), output = number(p?.completion);
    const charges = p ? Object.values(p).map(number) : [];
    return { id, name: m.display_name || m.displayName || m.name || id, context: m.context_length || m.context_window || m.inputTokenLimit || m.model_info?.context_window || null,
      input: input == null ? null : input * 1e6, output: output == null ? null : output * 1e6,
      free: input === 0 && output === 0 && charges.every((v) => v === 0),
      tools: (Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools')) || (Array.isArray(m.features) && m.features.includes('function-calling')),
      vision: (Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.includes('image')) || (Array.isArray(m.inference_metadata?.request_modality) && m.inference_metadata.request_modality.includes('Image')) };
  }).filter((m) => typeof m.id === 'string' && m.id.length);
}

export function filterCatalog(models, { query = '', free = false, tools = false, vision = false, longContext = false, sort = 'name' } = {}) {
  const q = query.trim().toLowerCase();
  return models.filter((m) => (!free || m.free) && (!tools || m.tools) && (!vision || m.vision) && (!longContext || m.context >= 128000) && (!q || (m.id + ' ' + m.name).toLowerCase().includes(q)))
    .sort((a, b) => (sort === 'price' ? (a.input ?? Infinity) - (b.input ?? Infinity)
      : sort === 'context' ? (b.context || 0) - (a.context || 0) : 0) || a.name.localeCompare(b.name));
}
