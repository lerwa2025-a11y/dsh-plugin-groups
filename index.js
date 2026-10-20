/**
 * Host half of the plugin-group view.
 *
 * Serves the group layout over a small same-origin HTTP route so the group
 * data lives in a real file next to the profile instead of browser storage:
 *
 *   GET  /plugin-groups/layout  -> the saved layout (or an empty one)
 *   PUT  /plugin-groups/layout  -> replace the layout
 *
 * The route is mounted only when the Web server service is present, so a
 * headless composition stays unaffected.
 */
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROUTE_PATH = '/plugin-groups/layout';
const FILE_NAME = 'plugin-groups.json';

/** Own data folder under DSH_HOME, the convention every other plugin follows. */
const DATA_DIR_NAME = 'dsh-plugin-groups';

const EMPTY = { version: 1, groups: [], order: [], notes: {}, tags: {}, presets: {} };

/** Fixed preset slots; the ids never change, the labels are the user's. */
const PRESET_SLOTS = ['p1', 'p2'];

/** DSH home: the same resolution the official plugins use ($DSH_HOME, else ~/.dsh). */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * Directory holding the layout: this plugin's own folder under DSH_HOME.
 *
 * Deliberately NOT inside the package directory. The package lives in
 * node_modules and pnpm replaces it wholesale on every update, so data kept
 * there would be destroyed by an upgrade. DSH_HOME is data, node_modules is
 * code: keeping them apart is what makes updating safe.
 *
 * Removing the plugin leaves this folder behind (DSH never deletes plugin
 * data), so uninstalling truly means "delete this one folder" when the data
 * should go too.
 */
function dataDir() {
  return join(dshHome(), DATA_DIR_NAME);
}

function statePath() {
  return join(dataDir(), FILE_NAME);
}

/** The pre-0.2.1 location (profile root), used only for a one-time migration. */
function legacyStatePath() {
  const profile = process.env.DSH_PROFILE_DIR;
  return profile === undefined ? null : join(profile, FILE_NAME);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a layout saved by an older build into the new data folder.
 *
 * Only runs when the new file is absent and the old one is present, so it can
 * never overwrite user data, and it is a no-op on every later start.
 */
async function migrateLegacyLayout() {
  const target = statePath();
  const legacy = legacyStatePath();
  if (legacy === null || await exists(target) || !await exists(legacy)) return;
  await mkdir(dirname(target), { recursive: true });
  await rename(legacy, target);
}

/** Coerce an untrusted value into the layout shape. */
function normalize(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    version: 1,
    groups: Array.isArray(source.groups)
      ? source.groups
        .filter((group) => group && typeof group === 'object' && typeof group.id === 'string')
        .map((group) => ({
          id: group.id,
          name: typeof group.name === 'string' ? group.name : '未命名分组',
          accent: typeof group.accent === 'string' ? group.accent : '',
          members: Array.isArray(group.members)
            ? group.members.filter((member) => typeof member === 'string')
            : [],
          // A locked group keeps its position and refuses structural changes.
          locked: Boolean(group.locked),
        }))
      : [],
    order: Array.isArray(source.order)
      ? source.order.filter((id) => typeof id === 'string')
      : [],
    // One flat note per package name, independent of group membership, so a
    // note survives the plugin moving between groups or its group being deleted.
    notes: source.notes && typeof source.notes === 'object' && !Array.isArray(source.notes)
      ? Object.fromEntries(
        Object.entries(source.notes).filter(
          ([name, text]) => typeof name === 'string' && typeof text === 'string' && text.trim() !== '',
        ),
      )
      : {},
    // Tags: a flat package -> [{ text, color }] map. A tag is free text plus a
    // colour name. Kept independent of group structure so an agent can tag many
    // plugins by editing this one file.
    tags: source.tags && typeof source.tags === 'object' && !Array.isArray(source.tags)
      ? Object.fromEntries(
        Object.entries(source.tags)
          .filter(([name, list]) => typeof name === 'string' && Array.isArray(list))
          .map(([name, list]) => [
            name,
            list
              .filter((tag) => tag && typeof tag === 'object' && typeof tag.text === 'string' && tag.text.trim())
              .map((tag) => ({
                text: tag.text.trim().slice(0, 40),
                color: typeof tag.color === 'string' ? tag.color : 'gray',
              })),
          ])
          .filter(([, list]) => list.length > 0),
      )
      : {},
    /*
     * Presets: two fixed slots, each a full snapshot of the page as the user left
     * it — switches, component switches, grouping, notes and tags.
     *
     * The Host validates shapes but never interprets them: it has no idea which
     * packages exist or which components can be addressed, that knowledge lives
     * in the Client. What this code owes the feature is only that a saved field
     * survives a write-read round trip, the same protection notes and tags get.
     * Every field is optional on purpose, so a preset written by an older build
     * (states only) still loads instead of being discarded.
     */
    presets: PRESET_SLOTS.reduce((acc, slot) => {
      const raw = (source.presets ?? {})[slot];
      if (!raw || typeof raw !== 'object') return acc;

      const boolMap = (value) => Object.fromEntries(
        Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
          .filter(([key, on]) => typeof key === 'string' && typeof on === 'boolean'),
      );
      const states = boolMap(raw.states);
      const components = boolMap(raw.components);

      const groups = Array.isArray(raw.groups)
        ? raw.groups
          .filter((group) => group && typeof group === 'object' && typeof group.id === 'string')
          .map((group) => ({
            id: group.id,
            name: typeof group.name === 'string' ? group.name : '未命名分组',
            accent: typeof group.accent === 'string' ? group.accent : '',
            members: Array.isArray(group.members)
              ? group.members.filter((member) => typeof member === 'string')
              : [],
            locked: Boolean(group.locked),
          }))
        : null;

      const order = Array.isArray(raw.order)
        ? raw.order.filter((id) => typeof id === 'string')
        : null;

      const notes = raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes)
        ? Object.fromEntries(
          Object.entries(raw.notes)
            .filter(([name, text]) => typeof name === 'string' && typeof text === 'string' && text.trim() !== ''),
        )
        : {};

      const tags = raw.tags && typeof raw.tags === 'object' && !Array.isArray(raw.tags)
        ? Object.fromEntries(
          Object.entries(raw.tags)
            .filter(([name, list]) => typeof name === 'string' && Array.isArray(list))
            .map(([name, list]) => [
              name,
              list
                .filter((tag) => tag && typeof tag === 'object' && typeof tag.text === 'string' && tag.text.trim())
                .map((tag) => ({
                  text: tag.text.trim().slice(0, 40),
                  color: typeof tag.color === 'string' ? tag.color : 'gray',
                })),
            ])
            .filter(([, list]) => list.length > 0),
        )
        : {};

      // A slot with nothing usable in it is dropped rather than kept as a husk,
      // so the menu's "is this slot empty?" test stays a single truthy check.
      if (Object.keys(states).length === 0 && !groups && Object.keys(notes).length === 0) return acc;

      acc[slot] = {
        name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 20) : '',
        at: typeof raw.at === 'string' ? raw.at : '',
        states,
        components,
        groups,
        order,
        notes,
        tags,
      };
      return acc;
    }, {}),
  };
}

async function readLayout() {
  try {
    await migrateLegacyLayout();
    return normalize(JSON.parse(await readFile(statePath(), 'utf8')));
  } catch {
    return EMPTY;
  }
}

/** Write atomically so a crash never leaves a half-written layout. */
async function writeLayout(layout) {
  const file = statePath();
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(normalize(layout), null, 2), 'utf8');
  await rename(temp, file);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Reject cross-site callers: the layout is only meaningful same-origin. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return true;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('layout payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { error: 'cross-origin request refused' });
          return;
        }
        if (req.method === 'GET') {
          try {
            sendJson(res, 200, await readLayout());
          } catch (error) {
            sendJson(res, 500, { error: String(error?.message ?? error) });
          }
          return;
        }
        if (req.method === 'PUT' || req.method === 'POST') {
          try {
            const text = await readBody(req, 1024 * 1024);
            await writeLayout(JSON.parse(text));
            sendJson(res, 200, { saved: true });
          } catch (error) {
            sendJson(res, 400, { error: String(error?.message ?? error) });
          }
          return;
        }
        res.writeHead(405, { allow: 'GET, PUT' });
        res.end();
      },
    }), `plugin-groups: ${ROUTE_PATH}`);
  });
}
