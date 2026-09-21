import { readFile } from 'node:fs/promises';

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function retry(label, operation, attempts = 120) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  throw new Error(`${label} did not become ready`, { cause: last });
}
