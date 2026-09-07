import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

// Decode terminal-dropped shell quoting only; never evaluate shell expressions.
export function imagePaths(text, cwd) {
  const paths = [];
  const tokens = text.match(/(?:[^\s'"\\]|\\.|'[^']*'|"(?:\\.|[^"\\])*")+/gu) || [];
  for (const token of tokens) {
    let value = token.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gs,
      (_, single, double, escaped) => single ?? double?.replace(/\\([\\"$`])/g, '$1') ?? escaped);
    if (!/\.(png|jpe?g|gif|webp)$/i.test(value) || /^https?:/i.test(value)) continue;
    if (value.startsWith('file:')) value = fileURLToPath(value);
    if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
    const resolved = path.resolve(cwd, value);
    // Bare names in prose are not attachments unless the file exists.
    if (!value.includes('/') && !fs.existsSync(resolved)) continue;
    if (!paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

export function saveImages(files, session) {
  if (files.length > 10) throw new Error('Attach at most 10 images per prompt.');
  const images = files.map(file => {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error(`Image must be a file of at most 5 MiB: ${file}`);
    const data = fs.readFileSync(file);
    const mime = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
      : /^GIF8[79]a/.test(data.subarray(0,6).toString()) ? 'image/gif'
      : data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : null;
    if (!mime) throw new Error(`Unsupported image: ${file}. Use PNG, JPEG, GIF or WebP.`);
    return {name: path.basename(file), mime, data};
  });
  const dir = path.join(session.dir, 'images');
  if (images.length) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const saved = [];
  try {
    for (const {name, mime, data} of images) {
      const file = path.join(dir, randomUUID() + '.' + mime.split('/')[1]);
      fs.writeFileSync(file, data, {mode: 0o600, flag: 'wx'});
      saved.push({name, mime, path: file});
    }
    return saved;
  } catch (error) { for (const image of saved) fs.unlinkSync(image.path); throw error; }
}

export function providerInput(provider, prompt, images) {
  if (provider !== 'claude' || !images.length) return prompt;
  return JSON.stringify({type: 'user', parent_tool_use_id: null, message: {role: 'user', content: [
    {type: 'text', text: prompt},
    ...images.map(image => ({type: 'image', source: {type: 'base64', media_type: image.mime,
      data: fs.readFileSync(image.path).toString('base64')}})),
  ]}}) + '\n';
}
