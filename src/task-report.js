// How a task view reads on a terminal. The view itself (src/task-view.js) is the shared, bounded answer;
// this is only its text skin — the MCP transport renders the same view as structuredContent instead.
const line = (label, value) => value === null || value === undefined || value === '' ? null : `${label}: ${value}`;

export function formatTaskView(view) {
  const rows = [
    `${view.task} · ${view.state}${view.profile ? ` · ${view.profile}` : ''}${view.ai ? ` (${view.ai})` : ''}${view.elapsed ? ` · ${view.elapsed}` : ''}`,
    line('orders', view.orders),
    view.lease ? `lease: ${view.lease.minutes} min${view.lease.renewals ? ` · renewed ${view.lease.renewals}×` : ''}` : null,
    view.reviewer ? `review: ${view.reviewer}${view.verdict ? ` · ${view.verdict.verdict}` : ' · running'}` : null,
    line('blocked', view.blocker),
    line('reason', view.reason),
  ].filter(Boolean);
  if (view.milestones.length) rows.push('milestones:', ...view.milestones.map(m => `  ${m.phase}: ${m.text}${m.next ? ` → ${m.next}` : ''}`));
  if (view.findings.total) {
    rows.push(`findings (${view.findings.total}):`);
    rows.push(...view.findings.shown.map(f => `  ${[f.severity, f.file && `${f.file}${f.line ? `:${f.line}` : ''}`, f.title].filter(Boolean).join(' ')}`));
    if (view.findings.more) rows.push(`  … ${view.findings.more} more`);
  }
  if (view.summary) rows.push('summary:', `  ${view.summary}`);
  if (view.journal) rows.push(`journal: ${view.journal.path} · rows ${view.journal.fromSeq}–${view.journal.toSeq} of this task`);
  return rows.join('\n');
}

export const formatTaskList = rows => rows.length
  ? rows.map(row => `${row.task.slice(0, 8)} · ${row.state.padEnd(9)} · ${(row.profile ?? '').padEnd(12)} · ${(row.elapsed ?? '').padStart(7)}${row.findings ? ` · ${row.findings} findings` : ''}${row.doing ? ` · ${row.doing}` : ''}`).join('\n')
  : 'No tasks.';
