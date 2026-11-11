// The session's name in the terminal's window or tab title, so several sessions can be told apart without the sidebar
// (which hides below 100 columns or with /sidebar off). Written only when it changes; null clears it on exit.
export function createWindowTitle({stream = process.stdout, env = process.env} = {}) {
  let shown;
  return name => {
    if (!stream.isTTY || env.TERM === 'dumb' || name === shown) return false;
    shown = name;
    const text = name ? `bounce · ${String(name).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80)}` : '';
    stream.write(`\x1b]2;${text}\x07`);
    return true;
  };
}
