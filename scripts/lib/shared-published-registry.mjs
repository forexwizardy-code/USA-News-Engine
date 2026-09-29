import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..', '..');
const REGISTRY_FILE = join(PROJECT_DIR, 'data', 'published-stories.json');

async function loadRegistry() {
  const raw = await readFile(REGISTRY_FILE, 'utf8');
  const doc = JSON.parse(raw);

  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.stories)) {
    throw new Error('Shared published registry is invalid: stories must be an array.');
  }

  return doc;
}

export async function upsertSharedPublishedStory(entry) {
  if (!entry?.storyKey) throw new Error('shared registry entry requires storyKey');
  if (!entry?.slug) throw new Error('shared registry entry requires slug');

  const registry = await loadRegistry();

  const index = registry.stories.findIndex(
    (story) => story.storyKey === entry.storyKey || story.slug === entry.slug,
  );

  if (index >= 0) {
    registry.stories[index] = {
      ...registry.stories[index],
      ...entry,
    };
  } else {
    registry.stories.push(entry);
  }

  registry.generatedAt = new Date().toISOString();
  registry.storyCount = registry.stories.length;

  await mkdir(dirname(REGISTRY_FILE), { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  return registry;
}

export async function refreshSharedRegistryMetadata() {
  const registry = await loadRegistry();
  registry.generatedAt = new Date().toISOString();
  registry.storyCount = registry.stories.length;

  await mkdir(dirname(REGISTRY_FILE), { recursive: true });
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  return registry;
}