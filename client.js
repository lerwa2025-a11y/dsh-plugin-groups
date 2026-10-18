/**
 * Plugin group view — the tab beside the official Installed plugins page.
 *
 * Two data sources, both authoritative:
 *   - Plugin inventory and real enablement come from the official
 *     `pluginManager` Remote, so this view can never disagree with the page.
 *   - Group layout lives in a file served by this bundle's own Host half at
 *     `/plugin-groups/layout`, so it survives restarts and browser storage
 *     clearing.
 *
 * Only `slots` is a hard dependency: every other service is resolved at call
 * time, so a profile missing one degrades the view instead of blanking the tab.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-groups',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;

    const LAYOUT_URL = '/plugin-groups/layout';
    const LAYOUT_STORE = 'dsh-plugin-groups.layout.v1';

    /**
     * Build stamp shown in the toolbar. Bump this whenever the Client half
     * changes so a stale page can be recognised immediately.
     */
    const BUILD = '2026-10-19.16';

    /**
     * This bundle's own package name. A hard rule, not a heuristic: a plugin must
     * never be able to switch itself off from its own page, because that would
     * remove the very UI the click came from and leave the tab pointing at a
     * stopped plugin. The Host would also refuse it or require a restart.
     */
    const SELF_PACKAGE = 'dsh-plugin-groups';

    /** The live Client context, set once by `apply`. */
    let liveCtx = null;

    /** Group accent colours; decorative only, surfaces stay host-themed. */
    const ACCENTS = ['#4f86d6', '#3fa88a', '#c98a3f', '#9a6bd1', '#4aa3c7', '#c2607a', '#7d9a3f', '#b06a4a'];

    /**
     * Colours a tag can use. The name is storage; the value is what renders.
     * A tag is free text chosen by the user — the colour only groups tags that
     * mean the same kind of thing to that user.
     */
    const TAG_COLORS = [
      { key: 'red', label: '红', color: '#d9534f' },
      { key: 'orange', label: '橙', color: '#d9822b' },
      { key: 'yellow', label: '黄', color: '#c9a227' },
      { key: 'green', label: '绿', color: '#3fa88a' },
      { key: 'cyan', label: '青', color: '#3fa3b8' },
      { key: 'blue', label: '蓝', color: '#4f86d6' },
      { key: 'purple', label: '紫', color: '#9a6bd1' },
      { key: 'pink', label: '粉', color: '#c2607a' },
      { key: 'gray', label: '灰', color: '#8a8a8a' },
    ];

    const TAG_COLOR_KEYS = TAG_COLORS.map((entry) => entry.key);

    /** The colour for a stored key, falling back to gray for unknown keys. */
    function tagColorOf(key) {
      return (TAG_COLORS.find((entry) => entry.key === key) ?? TAG_COLORS[TAG_COLORS.length - 1]).color;
    }

    const EMPTY = { version: 1, groups: [], order: [], notes: {}, tags: {} };

    // ------------------------------------------------------------ remote/data

    function pluginManagerRemote() {
      try {
        return liveCtx?.remote?.pluginManager ?? null;
      } catch {
        return null;
      }
    }

    /**
     * Persistence strategy, decided once at first read.
     *   'file'  — the Host half's route answered, so the layout lives beside the
     *             profile and survives browser storage clearing.
     *   'local' — the route is not mounted yet (the Host half needs a restart),
     *             so fall back to browser storage and keep working now.
     */
    let storageMode = null;

    function readLocal() {
      try {
        const raw = window.localStorage.getItem(LAYOUT_STORE);
        if (!raw) return null;
        return normalizeLayout(JSON.parse(raw));
      } catch {
        return null;
      }
    }

    function writeLocal(layout) {
      try {
        window.localStorage.setItem(LAYOUT_STORE, JSON.stringify(layout));
        return true;
      } catch {
        return false;
      }
    }

    /**
     * The persisted layout holds the group structure plus one flat `notes` map
     * keyed by package name. Notes are deliberately not nested under a group:
     * a plugin keeps its note when it moves between groups, and deleting a group
     * never takes a note with it.
     *
     * Open/closed state is NOT saved: every visit starts fully collapsed and
     * expanding lasts only while the tab stays mounted.
     */
    function normalizeLayout(value) {
      const source = value && typeof value === 'object' ? value : {};
      const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
      const rawNotes = source.notes && typeof source.notes === 'object' && !Array.isArray(source.notes)
        ? source.notes
        : {};
      const notes = {};
      for (const [name, text] of Object.entries(rawNotes)) {
        if (typeof text === 'string' && text.trim()) notes[name] = text;
      }
      /*
       * Tags: one flat map from package name to a list of { text, color }.
       * A tag is free text with a colour, so it can name a plugin's kind —
       * "工具型", "界面型", "桥接型", "服务型" — and an agent can set tags by
       * editing the same file. Kept keyed by package, not by group, so a tag
       * survives the plugin moving between groups or the group being deleted.
       */
      const rawTags = source.tags && typeof source.tags === 'object' && !Array.isArray(source.tags)
        ? source.tags
        : {};
      const tags = {};
      for (const [name, list] of Object.entries(rawTags)) {
        if (!Array.isArray(list)) continue;
        const clean = list
          .filter((tag) => tag && typeof tag === 'object' && typeof tag.text === 'string' && tag.text.trim())
          .map((tag) => ({
            text: tag.text.trim().slice(0, 40),
            color: TAG_COLOR_KEYS.includes(tag.color) ? tag.color : 'gray',
          }));
        if (clean.length) tags[name] = clean;
      }
      return {
        version: 1,
        groups: Array.isArray(source.groups)
          ? source.groups
            .filter((group) => group && typeof group.id === 'string')
            .map((group) => ({
              ...group,
              locked: Boolean(group.locked),
            }))
          : [],
        order: ids(source.order),
        notes,
        tags,
      };
    }

    /**
     * Read the layout, merging the file with the browser copy.
     *
     * The file is authoritative for the group structure, but an older Host drops
     * fields it does not know (tags were lost that way before the Host code was
     * updated). So notes and tags are unioned with the local copy: the file wins
     * when it has a value, and the local copy fills anything the file dropped.
     * That keeps the user's typing alive across a page change even before a DSH
     * restart loads the new Host half.
     */
    async function fetchLayout() {
      const local = readLocal();
      try {
        const response = await fetch(LAYOUT_URL, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(String(response.status));
        const stored = normalizeLayout(await response.json());
        storageMode = 'file';

        const merged = {
          ...stored,
          notes: { ...(local?.notes ?? {}), ...stored.notes },
          tags: { ...(local?.tags ?? {}), ...stored.tags },
        };
        // Persist the merge back so the browser copy tracks the file.
        writeLocal(merged);
        return merged;
      } catch {
        storageMode = 'local';
        return local ?? EMPTY;
      }
    }

    async function persistLayout(layout) {
      const safe = normalizeLayout(layout);
      /*
       * Always mirror into browser storage. The Host half runs old code until DSH
       * restarts, and an old Host drops fields it does not know (tags were being
       * lost that way). The local copy is the durable one until the restart, and
       * `fetchLayout` merges the two, so nothing the user typed is discarded.
       */
      writeLocal(safe);
      if (storageMode === 'file') {
        const response = await fetch(LAYOUT_URL, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(safe),
        });
        if (!response.ok) {
          let detail = `HTTP ${response.status}`;
          try {
            const parsed = await response.json();
            if (parsed?.error) detail = parsed.error;
          } catch { /* keep the status text */ }
          throw new Error(`保存到文件失败：${detail}`);
        }
        return;
      }
    }

    // --------------------------------------------------------------- utilities

    function moveItem(list, from, to) {
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
      const next = list.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    }

    function pickLocalized(value) {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        return value.zh || value['zh-CN'] || value.en || '';
      }
      return '';
    }

    function labelOf(bundle, fallbackName) {
      const title = pickLocalized(bundle?.meta?.title);
      return title || bundle?.name || fallbackName || '未命名插件';
    }

    function describeOf(bundle) {
      return pickLocalized(bundle?.meta?.description) || bundle?.description || '';
    }

    // -------------------------------------------------------------------- view

    function GroupsView(props) {
      const openPackage = typeof props?.openPackage === 'function' ? props.openPackage : null;

      const [phase, setPhase] = useState('loading');
      const [bundles, setBundles] = useState([]);
      const [notice, setNotice] = useState(null);
      const [layout, setLayout] = useState(EMPTY);
      const [busy, setBusy] = useState({});
      const [picker, setPicker] = useState(null);
      const [drag, setDrag] = useState(null);
      const [editing, setEditing] = useState(null);
      const [mode, setMode] = useState('');

      /** Package name whose note is being edited, with the draft text. */
      const [noting, setNoting] = useState(null);

      /** Package name whose colour mark is being chosen. */
      const [marking, setMarking] = useState(null);

      /** The tag being typed for one package: { name, text, color }. */
      const [tagDraft, setTagDraft] = useState(null);

      // Open/closed state lives only in this component: nothing is persisted,
      // so reopening the tab always starts fully collapsed.
      const [openGroups, setOpenGroups] = useState({});

      const layoutRef = useRef(EMPTY);
      const saveTimer = useRef(null);

      /** Save after a short pause so dragging does not spam the route. */
      const scheduleSave = useCallback((next) => {
        layoutRef.current = next;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          persistLayout(next).catch((error) => {
            setNotice({ kind: 'error', text: String(error?.message ?? error) });
          });
        }, 350);
      }, []);

      const applyLayout = useCallback((updater) => {
        setLayout((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater;
          scheduleSave(next);
          return next;
        });
      }, [scheduleSave]);

      /** Read the real plugin inventory and enablement. */
      const readInventory = useCallback(async () => {
        const remote = pluginManagerRemote();
        if (!remote) {
          setPhase('no-remote');
          return;
        }
        try {
          const [bundleRes, pluginRes] = await Promise.all([
            remote.listBundles(),
            remote.listPlugins(),
          ]);
          if (!bundleRes?.ok || !pluginRes?.ok) {
            setPhase('error');
            setNotice({ kind: 'error', text: '官方插件清单读取失败。' });
            return;
          }
          setBundles(Array.isArray(bundleRes.value) ? bundleRes.value : []);
          setPhase('ready');
        } catch (error) {
          setPhase('error');
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        }
      }, []);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const stored = await fetchLayout();
            if (!alive) return;
            setLayout(stored);
            layoutRef.current = stored;
            setMode(storageMode ?? '');
          } catch (error) {
            if (!alive) return;
            setNotice({ kind: 'error', text: String(error?.message ?? error) });
          }
          await readInventory();
        })();
        return () => {
          alive = false;
          if (saveTimer.current) clearTimeout(saveTimer.current);
        };
      }, [readInventory]);

      // ---------------------------------------------------------- derived data

      const groups = useMemo(() => {
        const list = Array.isArray(layout.groups) ? layout.groups : [];
        const order = Array.isArray(layout.order) ? layout.order : [];
        const byId = new Map(list.map((group) => [group.id, group]));
        const ordered = [];
        for (const id of order) {
          const group = byId.get(id);
          if (group) { ordered.push(group); byId.delete(id); }
        }
        for (const group of byId.values()) ordered.push(group);
        return ordered;
      }, [layout.groups, layout.order]);

      const bundleByName = useMemo(() => {
        const map = new Map();
        for (const bundle of bundles) {
          if (bundle?.name) map.set(bundle.name, bundle);
        }
        return map;
      }, [bundles]);

      /**
       * Why a bundle cannot be switched from this view, or null when it can.
       *
       * Order matters: the first rule is a hard-coded safety rule, the rest come
       * from official inventory fields.
       *
       *   SELF — this plugin's own package. A page must never switch itself off:
       *     the click would stop the plugin drawing the page, the tab would keep
       *     pointing at a stopped plugin, and the Host would need a restart.
       *   availability 'missing' — the entry names a package that is not installed,
       *     so there is nothing to enable; the official page offers install instead.
       *   readOnlyReason 'management-required' — the Host owns this row; a plain
       *     on/off is refused.
       *   readOnlyReason 'unaddressable' — no Loader entry to address.
       *
       * An installation bundle marked `optional` stays switchable: the official
       * page enables and disables exactly those.
       */
      const lockReasonOf = useCallback((bundle) => {
        if (!bundle) return null;
        if (bundle.name === SELF_PACKAGE) {
          return {
            code: 'self',
            label: '本体',
            text: '这是插件分组视图自己。它不能在自己的界面里关掉自己，请到官方插件页操作',
          };
        }
        if (bundle.availability === 'missing') {
          return {
            code: 'missing',
            label: '未安装',
            text: '这个插件还没有安装，装好之后才能开关',
          };
        }
        if (bundle.readOnlyReason === 'management-required') {
          return {
            code: 'management-required',
            label: '内核',
            text: '这是 DSH 内核自带的插件，由官方管理，不能在这里单独开关',
          };
        }
        if (bundle.readOnlyReason === 'unaddressable') {
          return {
            code: 'unaddressable',
            label: '受保护',
            text: '这个插件没有可切换的入口，无法在这里开关',
          };
        }
        return null;
      }, []);

      /**
       * Descriptive tags shown beside a plugin's name. A badge only says where a
       * plugin comes from or that it cannot be switched; `lockReasonOf` alone
       * decides the switching rule, so "official" never implies "locked".
       */
      const badgesOf = useCallback((bundle) => {
        if (!bundle) return [];
        const badges = [];
        const guard = lockReasonOf(bundle);
        if (guard) {
          badges.push({
            key: guard.code,
            label: guard.label,
            text: guard.text,
            kind: guard.code === 'missing' ? 'muted' : 'locked',
          });
        }
        if (bundle.official === true) {
          badges.push({
            key: 'official',
            label: '官方',
            text: 'DSH 官方提供的插件',
            kind: 'official',
          });
        }
        if (bundle.availability === 'installation' && bundle.optional === true) {
          badges.push({
            key: 'experimental',
            label: '实验',
            text: '随 DSH 安装提供的可选实验插件，可以在这里开关',
            kind: 'muted',
          });
        }
        return badges;
      }, [lockReasonOf]);

      /**
       * The bundles this view lists.
       *
       * Excluded on purpose:
       *   - kernel bundles (readOnlyReason 'management-required'): DSH's own core.
       *     They cannot be switched, so grouping them achieves nothing, and there
       *     are ~90 of them behind dsh-base alone.
       *   - unaddressable rows: nothing to switch.
       *   - OTHER RUN SHAPES of DSH: acp-app, headless, sdk-app, sdk-minimal ship
       *     as alternative hosts (CLI, SDK, automation). This desktop profile does
       *     not run them, so they are not plugins of this profile at all. They are
       *     not marked `official`, so they are matched by name below.
       *
       * Everything else is listed, with a badge saying what it is.
       */
      const OTHER_RUN_SHAPES = new Set([
        '@deepseek-ai/dsh-acp-app',
        '@deepseek-ai/dsh-headless',
        '@deepseek-ai/dsh-sdk-app',
        '@deepseek-ai/dsh-sdk-minimal',
        '@deepseek-ai/dsh-sdk-minimal-sdk',
      ]);

      const listed = useMemo(() => bundles.filter((bundle) => {
        if (!bundle?.name) return false;
        if (bundle.readOnlyReason === 'management-required') return false;
        if (bundle.readOnlyReason === 'unaddressable') return false;
        if (OTHER_RUN_SHAPES.has(bundle.name)) return false;
        return true;
      }), [bundles]);

      /** Bundles that are installed and switchable; the rest get a 未安装 badge. */
      const assignable = listed;

      const groupedNames = useMemo(() => {
        const set = new Set();
        for (const group of groups) {
          for (const member of group.members ?? []) set.add(member);
        }
        return set;
      }, [groups]);

      const ungrouped = useMemo(
        () => assignable.filter((bundle) => !groupedNames.has(bundle.name)),
        [assignable, groupedNames],
      );

      /** Which groups are currently open, from in-memory state only. */
      const isOpen = useCallback((id) => Boolean(openGroups[id]), [openGroups]);

      // -------------------------------------------------------------- mutations

      const toggleBundle = useCallback(async (name, enabled) => {
        const remote = pluginManagerRemote();
        if (!remote) {
          setNotice({ kind: 'error', text: '读不到官方插件管理接口，无法切换。' });
          return;
        }
        setBusy((prev) => ({ ...prev, [name]: true }));
        setNotice(null);
        try {
          const result = await remote.setBundleEnabled(name, enabled);
          if (!result?.ok) {
            setNotice({ kind: 'error', text: `切换失败：${result?.error?.message ?? '官方接口拒绝'}` });
            return;
          }
          const application = result.value?.application;
          if (application === 'applied' || application === 'restart-required') {
            setBundles((prev) => prev.map((bundle) => (
              bundle.name === name ? { ...bundle, enabled } : bundle
            )));
            if (application === 'restart-required') {
              setNotice({ kind: 'warn', text: '已保存，但需要重启 DSH 才完全生效。' });
            }
          } else if (application === 'failed') {
            setNotice({ kind: 'error', text: `切换失败：${result.value?.error?.code ?? '未知原因'}` });
          } else if (application === 'overridden') {
            setNotice({ kind: 'warn', text: '已保存，但被更高优先级的配置层覆盖。' });
          }
        } catch (error) {
          setNotice({ kind: 'error', text: String(error?.message ?? error) });
        } finally {
          setBusy((prev) => { const next = { ...prev }; delete next[name]; return next; });
        }
      }, []);

      const addGroup = useCallback(() => {
        const id = `g${Date.now().toString(36)}`;
        applyLayout((prev) => {
          const list = Array.isArray(prev.groups) ? prev.groups : [];
          const order = Array.isArray(prev.order) ? prev.order : [];
          const group = {
            id,
            name: `新分组 ${list.length + 1}`,
            accent: ACCENTS[list.length % ACCENTS.length],
            members: [],
          };
          return { ...prev, groups: [...list, group], order: [...order, id] };
        });
        setEditing({ id, value: `新分组 ${(layout.groups?.length ?? 0) + 1}` });
      }, [applyLayout, layout.groups]);

      const renameGroup = useCallback((id, name) => {
        const clean = name.trim();
        if (!clean) return;
        applyLayout((prev) => ({
          ...prev,
          groups: (prev.groups ?? []).map((group) => (group.id === id ? { ...group, name: clean } : group)),
        }));
      }, [applyLayout]);

      const removeGroup = useCallback((id) => {
        applyLayout((prev) => ({
          ...prev,
          groups: (prev.groups ?? []).filter((group) => group.id !== id),
          order: (prev.order ?? []).filter((x) => x !== id),
        }));
        setOpenGroups((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, [applyLayout]);

      /** Open or close one group; memory only, nothing to save. */
      const toggleOpen = useCallback((id) => {
        setOpenGroups((prev) => {
          const next = { ...prev };
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
      }, []);

      /** Open every group at once. */
      const expandAll = useCallback(() => {
        const all = {};
        for (const group of groups) all[group.id] = true;
        setOpenGroups(all);
      }, [groups]);

      /** Close every group at once. */
      const collapseAll = useCallback(() => {
        setOpenGroups({});
      }, []);

      /**
       * Lock or unlock one group. A locked group keeps its position and its
       * members in place, and its plugins cannot be started or stopped.
       */
      const toggleLock = useCallback((id) => {
        applyLayout((prev) => ({
          ...prev,
          groups: (prev.groups ?? []).map((group) => (
            group.id === id ? { ...group, locked: !group.locked } : group
          )),
        }));
      }, [applyLayout]);

      /**
       * Save or clear one plugin's note. An empty or whitespace-only note is
       * removed from the map, so the plugin falls back to its own description.
       */
      const setNote = useCallback((bundleName, text) => {
        applyLayout((prev) => {
          const notes = { ...(prev.notes ?? {}) };
          const clean = typeof text === 'string' ? text.trim() : '';
          if (clean) notes[bundleName] = clean;
          else delete notes[bundleName];
          return { ...prev, notes };
        });
      }, [applyLayout]);

      /**
       * Replace one plugin's tag list.
       *
       * This is the whole interface for tags: no Host method and no separate
       * store. The list lands in `plugin-groups.json` under `tags` as
       * `{ "pkg": [{ "text": "…", "color": "…" }] }`, so an agent can tag many
       * plugins by editing that one file — no UI automation, no new API.
       */
      const setTags = useCallback((bundleName, list) => {
        applyLayout((prev) => {
          const tags = { ...(prev.tags ?? {}) };
          const clean = (Array.isArray(list) ? list : [])
            .filter((tag) => tag && typeof tag.text === 'string' && tag.text.trim())
            .map((tag) => ({
              text: tag.text.trim().slice(0, 40),
              color: TAG_COLOR_KEYS.includes(tag.color) ? tag.color : 'gray',
            }));
          if (clean.length) tags[bundleName] = clean;
          else delete tags[bundleName];
          return { ...prev, tags };
        });
      }, [applyLayout]);

      /** Add one tag to a plugin, replacing a tag with the same text. */
      const addTag = useCallback((bundleName, text, color) => {
        const current = (layout.tags ?? {})[bundleName] ?? [];
        const next = current.filter((tag) => tag.text !== text.trim());
        next.push({ text: text.trim(), color });
        setTags(bundleName, next);
      }, [layout.tags, setTags]);

      /** Remove one tag by its exact text. */
      const removeTag = useCallback((bundleName, text) => {
        const current = (layout.tags ?? {})[bundleName] ?? [];
        setTags(bundleName, current.filter((tag) => tag.text !== text));
      }, [layout.tags, setTags]);

      /** The tag list for one package. */
      const tagsOf = useCallback((bundleName) => (layout.tags ?? {})[bundleName] ?? [], [layout.tags]);

      const describeRow = useCallback((bundle, fallbackName) => {
        const note = (layout.notes ?? {})[bundle?.name ?? fallbackName];
        if (note) return note;
        return describeOf(bundle) || fallbackName || '';
      }, [layout.notes]);

      const assignTo = useCallback((groupId, bundleName) => {
        applyLayout((prev) => {
          const target = (prev.groups ?? []).find((group) => group.id === groupId);
          // A locked group refuses new members, like any other structural change.
          if (!target || target.locked) return prev;
          return {
            ...prev,
            groups: (prev.groups ?? []).map((group) => {
              const members = (group.members ?? []).filter((member) => member !== bundleName);
              return group.id === groupId
                ? { ...group, members: [...members, bundleName] }
                : { ...group, members };
            }),
          };
        });
        setPicker(null);
      }, [applyLayout]);

      const removeFrom = useCallback((groupId, bundleName) => {
        applyLayout((prev) => ({
          ...prev,
          groups: (prev.groups ?? []).map((group) => (
            group.id === groupId
              ? { ...group, members: (group.members ?? []).filter((member) => member !== bundleName) }
              : group
          )),
        }));
      }, [applyLayout]);

      /** Drop a dragged member onto another member: reorder, or move across groups. */
      const dropMemberOn = useCallback((targetGroupId, targetName) => {
        if (!drag || drag.kind !== 'member') return;
        applyLayout((prev) => {
          const groupsNext = (prev.groups ?? []).map((group) => ({
            ...group,
            members: (group.members ?? []).filter((member) => member !== drag.name),
          }));
          const target = groupsNext.find((group) => group.id === targetGroupId);
          if (!target) return prev;
          const at = target.members.indexOf(targetName);
          target.members.splice(at < 0 ? target.members.length : at, 0, drag.name);
          return { ...prev, groups: groupsNext };
        });
      }, [applyLayout, drag]);

      const dropOnGroup = useCallback((groupId) => {
        if (!drag) return;
        const target = groups.find((group) => group.id === groupId);
        if (!target || target.locked) return;
        if (drag.kind === 'group') {
          const source = groups.find((group) => group.id === drag.id);
          if (!source || source.locked) return;
          const ids = groups.map((group) => group.id);
          const from = ids.indexOf(drag.id);
          const to = ids.indexOf(groupId);
          if (from < 0 || to < 0 || from === to) return;
          applyLayout((prev) => ({ ...prev, order: moveItem(ids, from, to) }));
        } else if (drag.kind === 'member' || drag.kind === 'ungrouped') {
          assignTo(groupId, drag.name);
        }
      }, [applyLayout, assignTo, drag, groups]);

      // ---------------------------------------------------------------- render

      const statusDot = (name, enabled) => h('span', {
        className: 'pgv-dot' + (busy[name] ? ' is-busy' : enabled ? ' is-on' : ' is-off'),
        title: enabled ? '已启用' : '已禁用',
      });

      /**
       * The enable switch carries its own state as text, so the control reads as
       * "已启用 / 已禁用" instead of an unexplained slider.
       *
       * `guard` is the official read-only verdict for this row, when it has one:
       * a guarded switch renders locked and refuses clicks, so a plugin the
       * manager owns can no longer look switchable and then do nothing.
       */
      const switchFor = (name, enabled, disabled, pending, guard = null) => h('button', {
        type: 'button',
        className: 'pgv-toggle' + (guard ? ' is-protected' : ''),
        role: 'switch',
        'aria-checked': Boolean(enabled),
        'aria-label': guard
          ? `${guard.text}（${enabled ? '当前已启用' : '当前已禁用'}）`
          : enabled ? '已启用，点击禁用' : '已禁用，点击启用',
        'data-on': String(Boolean(enabled)),
        'data-protected': guard ? 'true' : undefined,
        disabled: Boolean(disabled) || Boolean(guard),
        title: guard
          ? `${guard.text}\n当前状态：${enabled ? '已启用' : '已禁用'}`
          : enabled ? '点击禁用这个插件' : '点击启用这个插件',
        onClick: () => { if (!guard) toggleBundle(name, !enabled); },
      }, [
        h('span', { key: 'track', className: 'pgv-track' }, h('span', { className: 'pgv-knob' })),
        h('span', { key: 'text', className: 'pgv-toggle-text' },
          guard ? '🔒 受保护' : pending ? '处理中…' : enabled ? '已启用' : '已禁用'),
      ]);

      /**
       * Inline SVG icons replace emoji glyphs on the two icon-only buttons.
       *
       * Emoji are coloured by the font, so `color: var(--…)` has no effect on
       * them; an emoji "tag" button therefore could not take the tag colour.
       * These SVGs use `currentColor` on every stroke/fill, so the normal CSS
       * `tone` / `is-on` rules colour them exactly like the text.
       */
      const ICONS = {
        tag: (size) => h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, [
          h('path', { key: 'p', d: 'M3 3.5h4.2l1.6 1.9h4v6.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z' }),
          h('circle', { key: 'c', cx: 6.6, cy: 9.1, r: 1.15 }),
          h('path', { key: 's', d: 'M7.5 9.9l4.1 3' }),
        ]),
        note: (size) => h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
          fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, [
          h('path', { key: 'b', d: 'M2.5 3.5h11v9h-11z' }),
          h('path', { key: 'l1', d: 'M5 6.5h6' }),
          h('path', { key: 'l2', d: 'M5 9h4' }),
        ]),
      };

      /**
       * A label-capable action button.
       *
       * `on` marks the control as currently engaged (its panel is open) and is
       * styled distinctly. `iconOnly` renders only the glyph — for notes and
       * tags, `glyph` is an SVG element so the current-colour rules can tint it.
       */
      const iconButton = (key, glyph, label, options = {}) => h('button', {
        key,
        type: 'button',
        className: 'pgv-act'
          + (options.danger ? ' is-danger' : '')
          + (options.active ? ' is-active' : '')
          + (options.tone ? ` is-${options.tone}` : '')
          + (options.iconOnly ? ' is-icon-only' : ''),
        title: options.title ?? label,
        'aria-label': label,
        disabled: Boolean(options.disabled),
        onClick: options.onClick,
      }, options.iconOnly
        ? [h('span', { key: 'g', className: 'pgv-act-glyph' }, glyph)]
        : [
          h('span', { key: 'g', className: 'pgv-act-glyph' }, glyph),
          h('span', { key: 'l', className: 'pgv-act-label' }, label),
        ]);

      function renderMember(group, bundleName) {
        const bundle = bundleByName.get(bundleName);
        const enabled = Boolean(bundle?.enabled);
        const missing = !bundle;
        const locked = Boolean(group.locked);
        const guard = lockReasonOf(bundle);
        const tags = tagsOf(bundleName);
        const isMarking = marking === bundleName;
        const row = h('div', {
          key: 'row',
          className: 'pgv-row'
            + (drag?.kind === 'member' && drag.name === bundleName ? ' is-dragging' : '')
            + (locked ? ' is-locked' : ''),
          draggable: !missing && !locked,
          onDragStart: () => { if (!locked) setDrag({ kind: 'member', name: bundleName, groupId: group.id }); },
          onDragEnd: () => setDrag(null),
          onDragOver: (event) => {
            if (locked) return;
            event.preventDefault();
            event.stopPropagation();
          },
          onDrop: (event) => {
            if (locked) return;
            event.preventDefault();
            event.stopPropagation();
            dropMemberOn(group.id, bundleName);
            setDrag(null);
          },
        }, [
          h('span', {
            key: 'grip',
            className: 'pgv-grip' + (locked ? ' is-disabled' : ''),
            title: locked ? '这个分组已锁定，不能拖动' : '按住拖动可排序',
          }, locked ? '🔒' : '⠿'),
          h('span', {
            key: 'dot',
            className: 'pgv-dot' + (busy[bundleName] ? ' is-busy' : enabled ? ' is-on' : ' is-off'),
            title: enabled ? '已启用' : '已禁用',
          }),
          h('span', { key: 'name', className: 'pgv-name', title: bundleName },
            h('span', { className: 'pgv-titlerow' }, [
              h('span', { key: 't', className: 'pgv-title' },
                missing ? `${bundleName}（未安装）` : labelOf(bundle, bundleName)),
              ...badgesOf(bundle).map((badge) => h('span', {
                key: badge.key,
                className: `pgv-badge is-${badge.kind}`,
                title: badge.text,
              }, badge.label)),
              // User tags sit right after the name. Clicking one removes it, but a
              // locked group is inert: its tags stay readable and refuse removal,
              // like every other structural change in that group.
              h('span', { key: 'tags', className: 'pgv-tags' }, tags.map((tag) => h('span', {
                key: tag.text,
                className: 'pgv-tag' + (locked ? ' is-locked' : ''),
                style: {
                  '--tag-color': tagColorOf(tag.color),
                },
                title: locked ? `标签「${tag.text}」（已锁定，不能删除）` : `点击删除标签「${tag.text}」`,
                onClick: (event) => {
                  event.stopPropagation();
                  if (locked) return;
                  removeTag(bundleName, tag.text);
                },
              }, [
                h('span', { key: 'dot', className: 'pgv-tag-dot' }),
                h('span', { key: 'text' }, tag.text),
              ]))),
            ]),
            noting?.name === bundleName
              ? h('span', { key: 'noteedit', className: 'pgv-noteedit' }, [
                h('input', {
                  key: 'input',
                  className: 'pgv-note-input',
                  value: noting.text,
                  autoFocus: true,
                  placeholder: '写一条中文备注，留空则恢复原始简介',
                  onChange: (event) => setNoting({ name: bundleName, text: event.target.value }),
                  onBlur: () => { setNote(bundleName, noting.text); setNoting(null); },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { setNote(bundleName, noting.text); setNoting(null); }
                    if (event.key === 'Escape') setNoting(null);
                  },
                }),
              ])
              : h('span', { key: 'desc', className: 'pgv-id' + ((layout.notes ?? {})[bundleName] ? ' is-note' : '') },
                describeRow(bundle, bundleName))),
          // A locked group hides every mutating action, but "详情" is read-only
          // navigation to the official page, so it stays available.
          h('span', { key: 'actions', className: 'pgv-actions' }, [
            openPackage && !missing
              ? iconButton('open', '↗', '详情', {
                title: '跳到官方「已安装」页并打开这个插件的详情页',
                onClick: () => openPackage(bundleName),
              })
              : null,
            ...(locked
              ? []
              : [
                iconButton('mark', ICONS.tag(13), tags.length ? '改标签' : '标签', {
                  title: tags.length
                    ? `当前标签：${tags.map((tag) => tag.text).join('、')}（点击修改）`
                    : '给这个插件加一个带颜色的文字标签（存在 plugin-groups.json，agent 也能改）',
                  tone: 'tag',
                  onClick: () => {
                    setMarking(marking === bundleName ? null : bundleName);
                    setTagDraft({ name: bundleName, text: '', color: 'blue' });
                  },
                }),
                iconButton('note', ICONS.note(13), (layout.notes ?? {})[bundleName] ? '改备注' : '备注', {
                  title: (layout.notes ?? {})[bundleName]
                    ? '修改这条备注（会覆盖插件原始简介）'
                    : '给这个插件写一条备注，覆盖原始简介',
                  tone: 'note',
                  onClick: () => setNoting({ name: bundleName, text: (layout.notes ?? {})[bundleName] ?? '' }),
                }),
                iconButton('out', '↩', '移出分组', {
                  title: '把这个插件移出当前分组（不会禁用它）',
                  tone: 'remove',
                  danger: true,
                  onClick: () => removeFrom(group.id, bundleName),
                }),
              ]),
          ]),
          switchFor(bundleName, enabled, locked || missing || busy[bundleName], busy[bundleName], guard),
        ]);

        // The row and its optional swatch strip share one wrapper, so the strip
        // can sit on its own line under the row without breaking the row's flex
        // layout or its drag handlers.
        return h('div', { key: `${group.id}:${bundleName}`, className: 'pgv-item' }, [
          row,
          isMarking
            ? h('div', { key: 'tagslot', className: 'pgv-tagslot' }, renderTagEditor(bundleName, tags))
            : null,
        ]);
      }

      /**
       * The tag editor: a text field, a colour picker, and the plugin's current
       * tags with a remove control each. The text is whatever the user types —
       * the colours only group tags that mean the same kind of thing.
       */
      function renderTagEditor(bundleName, tags) {
        const draft = tagDraft?.name === bundleName ? tagDraft : { text: '', color: 'blue' };
        const setDraft = (patch) => setTagDraft({ name: bundleName, ...draft, ...patch });
        const commit = () => {
          const text = draft.text.trim();
          if (!text) return;
          addTag(bundleName, text, draft.color);
          setTagDraft(null);
          // Adding a tag finishes the job, so the editor closes itself instead of
          // waiting for a second click.
          setMarking(null);
        };
        return h('div', { key: 'tageditor', className: 'pgv-tageditor' }, [
          h('div', { key: 'current', className: 'pgv-tag-current' }, (
            tags.length === 0
              ? [h('span', { key: 'none', className: 'pgv-hint' }, '还没有标签')]
              : tags.map((tag) => h('span', {
                key: tag.text,
                className: 'pgv-tag',
                style: { '--tag-color': tagColorOf(tag.color) },
              }, [
                h('span', { key: 'dot', className: 'pgv-tag-dot' }),
                h('span', { key: 'text' }, tag.text),
                h('button', {
                  key: 'x',
                  type: 'button',
                  className: 'pgv-tag-x',
                  title: `删除标签「${tag.text}」`,
                  onClick: () => removeTag(bundleName, tag.text),
                }, '✕'),
              ]))
          )),
          h('div', { key: 'compose', className: 'pgv-tag-compose' }, [
            h('input', {
              key: 'input',
              className: 'pgv-tag-input',
              value: draft.text,
              autoFocus: tags.length === 0,
              maxLength: 40,
              placeholder: '输入标签文字，例如：工具型 / 界面型 / 桥接型 / 服务型',
              onChange: (event) => setDraft({ text: event.target.value }),
              onKeyDown: (event) => {
                if (event.key === 'Enter') commit();
                if (event.key === 'Escape') setMarking(null);
              },
            }),
            h('div', { key: 'colors', className: 'pgv-tag-colors' }, TAG_COLORS.map((entry) => h('button',
              {
                key: entry.key,
                type: 'button',
                className: 'pgv-swatch' + (draft.color === entry.key ? ' is-selected' : ''),
                style: { '--swatch': entry.color },
                title: entry.label,
                onClick: () => setDraft({ color: entry.key }),
              },
              h('span', { className: 'pgv-swatch-dot' })))),
            h('button', {
              key: 'add',
              type: 'button',
              className: 'pgv-tag-add',
              disabled: !draft.text.trim(),
              onClick: commit,
            }, '添加标签'),
          ]),
        ]);
      }

      function renderGroup(group) {
        const isCollapsed = !isOpen(group.id);
        const members = (group.members ?? []).filter((name) => groupedNames.has(name));
        const onCount = members.filter((name) => bundleByName.get(name)?.enabled).length;
        const isEditing = editing?.id === group.id;
        const locked = Boolean(group.locked);

        return h('section', {
          key: group.id,
          className: 'pgv-group' + (locked ? ' is-locked' : ''),
          onDragOver: (event) => {
            if (locked) return;
            event.preventDefault();
          },
          onDrop: (event) => {
            if (locked) return;
            event.preventDefault();
            dropOnGroup(group.id);
            setDrag(null);
          },
        }, [
          h('header', {
            key: 'head',
            className: 'pgv-head',
            draggable: !isEditing && !locked,
            onDragStart: (event) => {
              if (isEditing || locked) { event.preventDefault(); return; }
              setDrag({ kind: 'group', id: group.id });
            },
            onDragEnd: () => setDrag(null),
          }, [
            h('span', { key: 'accent', className: 'pgv-accent', style: { background: group.accent || ACCENTS[0] } }),
            h('span', {
              key: 'grip',
              className: 'pgv-grip' + (locked ? ' is-disabled' : ''),
              title: locked ? '这个分组已锁定，不能拖动' : '按住拖动可调整分组顺序',
            }, locked ? '🔒' : '⠿'),
            h('button', {
              key: 'chev',
              type: 'button',
              className: 'pgv-chev',
              title: isCollapsed ? '展开这组' : '收起这组',
              'aria-expanded': !isCollapsed,
              onClick: () => toggleOpen(group.id),
            }, [
              h('span', { key: 'g', className: 'pgv-chev-glyph' }, isCollapsed ? '▸' : '▾'),
              h('span', { key: 'l', className: 'pgv-chev-label' }, isCollapsed ? '展开' : '收起'),
            ]),
            isEditing
              ? h('input', {
                key: 'input',
                className: 'pgv-input',
                value: editing.value,
                autoFocus: true,
                onChange: (event) => setEditing({ id: group.id, value: event.target.value }),
                onBlur: () => { renameGroup(group.id, editing.value); setEditing(null); },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') { renameGroup(group.id, editing.value); setEditing(null); }
                  if (event.key === 'Escape') setEditing(null);
                },
              })
              : h('button', {
                key: 'name', type: 'button', className: 'pgv-grouptitle',
                title: locked ? group.name : '点击改名',
                disabled: locked,
                onClick: () => { if (!locked) setEditing({ id: group.id, value: group.name }); },
              }, group.name),
            locked ? h('span', { key: 'lockbadge', className: 'pgv-lockbadge', title: '已锁定' }, '已锁定') : null,
            h('span', { key: 'count', className: 'pgv-count', title: '已启用数 / 组内插件数' },
              `${onCount}/${members.length}`),
            h('span', { key: 'grow', className: 'pgv-grow' }),
            iconButton('add', '＋', '添加插件', {
              title: locked ? '已锁定的分组不能添加插件' : '从这个组里挑选要加入的插件',
              disabled: locked,
              tone: 'add',
              onClick: () => setPicker(picker === group.id ? null : group.id),
            }),
            iconButton('lock', locked ? '🔒' : '🔓', locked ? '解锁' : '锁定', {
              title: locked
                ? '解锁这个分组：恢复拖动、排序与启停'
                : '锁定这个分组：组和组内插件都固定，不能删除、改名、拖动或启停',
              iconOnly: true,
              active: locked,
              onClick: () => toggleLock(group.id),
            }),
            /*
             * Deleting is a structural change, so a locked group refuses it just
             * like rename, drag, add and toggle. The button stays visible but is
             * disabled, so the rule is visible instead of the control vanishing.
             */
            iconButton('del', '🗑', '删除', {
              title: locked ? '已锁定的分组不能删除，请先解锁' : '删除这个分组（组内插件不会被卸载）',
              danger: true,
              disabled: locked,
              onClick: () => {
                if (locked) return;
                if (window.confirm(`删除分组「${group.name}」？\n组内插件不会被卸载，只会回到「未分组」。`)) {
                  removeGroup(group.id);
                }
              },
            }),
          ]),

          picker === group.id
            ? h('div', { key: 'picker', className: 'pgv-picker' }, (() => {
              const candidates = assignable.filter((bundle) => !(group.members ?? []).includes(bundle.name));
              if (candidates.length === 0) {
                return [h('span', { key: 'none', className: 'pgv-hint' }, '没有可添加的插件了')];
              }
              return candidates.map((bundle) => h('button', {
                key: bundle.name, type: 'button', className: 'pgv-chip', title: bundle.name,
                onClick: () => assignTo(group.id, bundle.name),
              }, labelOf(bundle, bundle.name)));
            })())
            : null,

          isCollapsed
            ? null
            : h('div', { key: 'body', className: 'pgv-body' }, [
              // The group's colour runs down the body as a spine, so a row is
              // visibly inside this group rather than merely below its header.
              h('span', {
                key: 'spine',
                className: 'pgv-spine',
                style: { background: group.accent || ACCENTS[0] },
              }),
              h('div', { key: 'rows', className: 'pgv-rows' }, (
                members.length === 0
                  ? [h('p', { key: 'empty', className: 'pgv-empty' },
                    '这个分组还是空的 —— 点「+」添加，或把下面的插件拖进来。')]
                  : members.map((name, memberIndex) => renderMember(group, name, memberIndex, members.length))
              )),
            ]),
        ]);
      }

      // ------------------------------------------------------------------ shell

      const header = h('div', { key: 'bar', className: 'pgv-bar' }, [
        h('button', {
          key: 'add', type: 'button', className: 'pgv-btn pgv-btn-primary', onClick: addGroup,
        }, '＋ 新建分组'),
        h('button', {
          key: 'reload', type: 'button', className: 'pgv-btn',
          onClick: () => { readInventory(); },
        }, '↻ 刷新'),
        h('span', { key: 'sep', className: 'pgv-sep' }),
        h('button', {
          key: 'expandAll', type: 'button', className: 'pgv-btn',
          title: '把所有分组都展开',
          disabled: groups.length === 0 || groups.every((group) => isOpen(group.id)),
          onClick: expandAll,
        }, '▾ 全部展开'),
        h('button', {
          key: 'collapseAll', type: 'button', className: 'pgv-btn',
          title: '把所有分组都收起，只看组名',
          disabled: groups.length === 0 || groups.every((group) => !isOpen(group.id)),
          onClick: collapseAll,
        }, '▸ 全部收起'),
        h('span', { key: 'grow', className: 'pgv-grow' }),
        /*
         * Build stamp. It makes "is the page running the new code?" answerable at
         * a glance instead of by guessing: this string changes with every build,
         * so a stale page is immediately visible as an old stamp.
         */
        h('span', {
          key: 'build',
          className: 'pgv-hint pgv-build',
          title: '页面当前运行的客户端代码版本',
        }, 'v' + BUILD),
        h('span', {
          key: 'mode',
          className: 'pgv-hint',
          title: mode === 'file'
            ? '分组存在 profile 目录的 plugin-groups.json，重启和清浏览器缓存都不会丢'
            : '后端存档接口要重启 DSH 才生效，现在暂存在浏览器里',
        }, mode === 'file' ? '存档：文件' : mode === 'local' ? '存档：浏览器' : ''),
        h('span', { key: 'sum', className: 'pgv-hint' },
          phase === 'loading'
            ? '正在读取插件状态…'
            : `插件 ${assignable.length} · 分组 ${groups.length} · 未分组 ${ungrouped.length}`),
      ]);

      const noticeEl = notice
        ? h('div', {
          key: 'notice',
          className: 'pgv-notice' + (notice.kind === 'error' ? ' is-error' : ' is-warn'),
        }, [
          h('span', { key: 'text' }, notice.text),
          iconButton('x', '✕', '知道了', {
            title: '关闭这条提示',
            onClick: () => setNotice(null),
          }),
        ])
        : null;

      const blocked = phase === 'no-remote' || phase === 'error'
        ? h('div', { key: 'blocked', className: 'pgv-notice is-error' },
          phase === 'no-remote'
            ? '读不到官方插件管理接口（remote.pluginManager）。分组仍可编辑，但看不到真实开关状态。'
            : '插件清单读取失败。分组仍可编辑，但看不到真实开关状态。')
        : null;

      return h('div', { className: 'pgv-root' }, [
        h('style', { key: 'css' }, CSS),
        header,
        noticeEl,
        blocked,
        groups.length === 0
          ? h('p', { key: 'nogroups', className: 'pgv-empty' },
            '还没有分组。点「＋ 新建分组」开始，然后把下面的插件拖进去。')
          : groups.map((group) => renderGroup(group)),
        ungrouped.length > 0
          ? h('section', { key: 'ungrouped', className: 'pgv-group is-ungrouped' }, [
            h('header', { key: 'head', className: 'pgv-head' }, [
              h('span', { key: 'accent', className: 'pgv-accent', style: { background: 'var(--dsw-alias-border-l2)' } }),
              h('span', { key: 'title', className: 'pgv-grouptitle is-static' }, '未分组'),
              h('span', { key: 'count', className: 'pgv-count' }, String(ungrouped.length)),
              h('span', { key: 'grow', className: 'pgv-grow' }),
              h('span', { key: 'hint', className: 'pgv-hint' },
                groups.length === 0
                  ? '先新建一个分组，才能把插件分配进去'
                  : '用「分配到」选组，或直接把插件拖进上面的分组'),
            ]),
            ungrouped.map((bundle) => {
              const tags = tagsOf(bundle.name);
              const row = h('div', {
                key: 'row',
                className: 'pgv-row',
                draggable: true,
                onDragStart: () => setDrag({ kind: 'ungrouped', name: bundle.name }),
                onDragEnd: () => setDrag(null),
              }, [
                statusDot(bundle.name, Boolean(bundle.enabled)),
                h('span', { key: 'grip', className: 'pgv-grip', title: '按住拖动可直接拖进分组' }, '⠿'),
                h('span', { key: 'name', className: 'pgv-name', title: bundle.name },
                  h('span', { className: 'pgv-titlerow' }, [
                    h('span', { key: 't', className: 'pgv-title' }, labelOf(bundle, bundle.name)),
                    ...badgesOf(bundle).map((badge) => h('span', {
                      key: badge.key,
                      className: `pgv-badge is-${badge.kind}`,
                      title: badge.text,
                    }, badge.label)),
                    h('span', { key: 'tags', className: 'pgv-tags' }, tags.map((tag) => h('span', {
                      key: tag.text,
                      className: 'pgv-tag',
                      style: { '--tag-color': tagColorOf(tag.color) },
                      title: `点击删除标签「${tag.text}」`,
                      onClick: (event) => {
                        event.stopPropagation();
                        removeTag(bundle.name, tag.text);
                      },
                    }, [
                      h('span', { key: 'dot', className: 'pgv-tag-dot' }),
                      h('span', { key: 'text' }, tag.text),
                    ]))),
                  ]),
                  noting?.name === bundle.name
                    ? h('span', { key: 'noteedit', className: 'pgv-noteedit' }, [
                      h('input', {
                        key: 'input',
                        className: 'pgv-note-input',
                        value: noting.text,
                        autoFocus: true,
                        placeholder: '写一条中文备注，留空则恢复原始简介',
                        onChange: (event) => setNoting({ name: bundle.name, text: event.target.value }),
                        onBlur: () => { setNote(bundle.name, noting.text); setNoting(null); },
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') { setNote(bundle.name, noting.text); setNoting(null); }
                          if (event.key === 'Escape') setNoting(null);
                        },
                      }),
                    ])
                    : h('span', { key: 'desc', className: 'pgv-id' + ((layout.notes ?? {})[bundle.name] ? ' is-note' : '') },
                      describeRow(bundle, bundle.name))),
                h('span', { key: 'assign', className: 'pgv-assign' }, [
                  h('span', { key: 'label', className: 'pgv-assign-label' }, '分配到'),
                  h('select', {
                    key: 'select',
                    className: 'pgv-select',
                    value: '',
                    disabled: groups.filter((group) => !group.locked).length === 0,
                    title: groups.length === 0
                      ? '还没有分组，先在顶部新建一个'
                      : groups.filter((group) => !group.locked).length === 0
                        ? '现有分组都已锁定，解锁后才能加入插件'
                        : '选择要把这个插件放进哪个分组',
                    onChange: (event) => {
                      const groupId = event.target.value;
                      if (groupId) assignTo(groupId, bundle.name);
                      event.target.value = '';
                    },
                  }, [
                    h('option', { key: '', value: '', disabled: true },
                      groups.length === 0
                        ? '暂无分组'
                        : groups.filter((group) => !group.locked).length === 0
                          ? '分组都已锁定'
                          : '选择分组…'),
                    ...groups.map((group) => h('option', {
                      key: group.id,
                      value: group.id,
                      disabled: Boolean(group.locked),
                    }, group.locked ? `${group.name}（已锁定）` : group.name)),
                  ]),
                ]),
                openPackage
                  ? iconButton('open', '↗', '详情', {
                    title: '跳到官方「已安装」页并打开这个插件的详情页',
                    onClick: () => openPackage(bundle.name),
                  })
                  : null,
                iconButton('mark', ICONS.tag(13), tags.length ? '改标签' : '标签', {
                  title: tags.length
                    ? `当前标签：${tags.map((tag) => tag.text).join('、')}（点击修改）`
                    : '给这个插件加一个带颜色的文字标签',
                  tone: 'tag',
                  onClick: () => {
                    setMarking(marking === bundle.name ? null : bundle.name);
                    setTagDraft({ name: bundle.name, text: '', color: 'blue' });
                  },
                }),
                iconButton('note', ICONS.note(13), (layout.notes ?? {})[bundle.name] ? '改备注' : '备注', {
                  title: (layout.notes ?? {})[bundle.name]
                    ? '修改这条备注（会覆盖插件原始简介）'
                    : '给这个插件写一条备注，覆盖原始简介',
                  tone: 'note',
                  onClick: () => setNoting({ name: bundle.name, text: (layout.notes ?? {})[bundle.name] ?? '' }),
                }),
                switchFor(bundle.name, Boolean(bundle.enabled), busy[bundle.name], busy[bundle.name], lockReasonOf(bundle)),
              ]);

              // Same wrapper shape as a grouped member, so the tag editor can
              // open under an ungrouped row too.
              return h('div', { key: bundle.name, className: 'pgv-item' }, [
                row,
                marking === bundle.name
                  ? h('div', { key: 'tagslot', className: 'pgv-tagslot' }, renderTagEditor(bundle.name, tags))
                  : null,
              ]);
            }),
          ])
          : null,
      ]);
    }

    // --------------------------------------------------------------------- css

    const CSS = `
.pgv-root { display: flex; flex-direction: column; gap: 12px; padding: 6px 0 28px; }
.pgv-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pgv-grow { flex: 1 1 auto; }
.pgv-sep {
  width: 1px; height: 18px; flex: 0 0 auto;
  background: var(--dsw-alias-border-l1);
  margin: 0 2px;
}
.pgv-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }

.pgv-btn {
  font: inherit; font-size: 13px; line-height: 1;
  padding: 8px 13px; border-radius: 9px; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  transition: background .12s ease, border-color .12s ease;
}
.pgv-btn:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l2); }
.pgv-btn-primary { border-color: var(--dsw-alias-brand-primary); }

.pgv-group {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.pgv-group.is-ungrouped { border-style: dashed; }
/*
 * The header is the louder surface: raised background, a heavier title, and a
 * bottom rule. Rows below sit on the quieter group background inside a body that
 * carries the group's colour as a spine, so header and members never read as the
 * same kind of row.
 */
.pgv-head {
  display: flex; align-items: center; gap: 9px;
  padding: 12px 14px;
  min-height: 48px;
  background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  cursor: grab;
}
.pgv-head:active { cursor: grabbing; }
.pgv-head:hover { background: var(--dsw-alias-bg-overlay); }
.pgv-accent { width: 4px; height: 20px; border-radius: 3px; flex: 0 0 auto; }
/* Member body: coloured spine on the left, rows on a recessed background. */
.pgv-body {
  display: flex;
  align-items: stretch;
  background: var(--dsw-alias-bg-base);
}
.pgv-spine {
  flex: 0 0 auto;
  width: 3px;
  opacity: .85;
}
.pgv-rows { flex: 1 1 auto; min-width: 0; }
.pgv-grip { opacity: .45; font-size: 13px; line-height: 1; user-select: none; }
.pgv-grouptitle {
  font: inherit; font-size: 13.5px; font-weight: 600;
  background: none; border: none; padding: 2px 4px; border-radius: 6px;
  color: var(--dsw-alias-label-primary); cursor: text;
}
.pgv-grouptitle:hover { background: var(--dsw-alias-bg-base); }
.pgv-grouptitle.is-static { cursor: default; }
.pgv-grouptitle.is-static:hover { background: none; }
.pgv-input {
  font: inherit; font-size: 13.5px; font-weight: 600;
  padding: 3px 7px; border-radius: 6px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-brand-primary);
  min-width: 140px;
}
.pgv-count {
  font-size: 11.5px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 1px 7px;
}
.pgv-chev {
  display: inline-flex; align-items: center; gap: 4px;
  font: inherit; font-size: 12px; line-height: 1;
  padding: 4px 8px; border-radius: 7px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
}
.pgv-chev:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.pgv-chev-glyph { font-size: 11px; }
.pgv-chev-label { font-size: 12px; }

/* Labelled action buttons: every control states what it does in words. */
.pgv-act {
  display: inline-flex; align-items: center; gap: 4px;
  font: inherit; font-size: 12px; line-height: 1;
  padding: 5px 9px; border-radius: 7px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.pgv-act:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l2);
}
/* A disabled control reads as unavailable, not merely unresponsive. */
.pgv-act:disabled {
  opacity: .28;
  cursor: not-allowed;
  border-style: dashed;
}
.pgv-act:disabled:hover { color: inherit; border-color: var(--dsw-alias-border-l1); }
.pgv-act.is-danger:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
/* A glyph-only control, sized to sit beside labelled ones without crowding. */
.pgv-act.is-icon-only { padding: 6px 8px; font-size: 13px; }
.pgv-act.is-active {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
}
/*
 * Each action keeps its own tint so the row of buttons is scannable by colour
 * rather than by reading every label: detail=neutral, tag=accent, note=warm,
 * remove=danger. Clicking a button deliberately changes nothing about its own
 * look: the panel opening below the row is the feedback.
 */
.pgv-act.is-tag {
  color: #4f86d6;
  border-color: #4f86d6;
}
.pgv-act.is-tag:hover:not(:disabled) {
  color: #6aa0e8;
  border-color: #6aa0e8;
}
.pgv-act.is-add {
  color: #3fa88a;
  border-color: #3fa88a;
}
.pgv-act.is-add:hover:not(:disabled) {
  color: #55c1a2;
  border-color: #55c1a2;
}
.pgv-act.is-note {
  color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
}
.pgv-act.is-remove {
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l2);
}
.pgv-act.is-remove:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.pgv-act-glyph { font-size: 12px; }
.pgv-act-label { font-size: 12px; }

/*
 * A member row is a quieter, flatter thing than the group header: no raised
 * background of its own, separated only by hairlines, with a hover tint that
 * makes the row under the pointer obvious.
 */
.pgv-item + .pgv-item > .pgv-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.pgv-row {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 14px; font-size: 13.5px;
  min-height: 56px;
  transition: background .12s ease;
}
.pgv-row:hover { background: var(--dsw-alias-bg-layer-1); }
.pgv-row.is-dragging { opacity: .35; }

/* Inline SVG icons use currentColor, so tone and is-on rules tint them. */
.pgv-act-glyph svg { display: block; }
.pgv-act.is-icon-only .pgv-act-glyph svg { width: 13px; height: 13px; }

/* User tag: free text plus a colour, shown beside the plugin name. */
.pgv-tags { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.pgv-tag {
  display: inline-flex; align-items: center; gap: 4px;
  flex: 0 0 auto;
  font-size: 10.5px; line-height: 1;
  padding: 3px 7px; border-radius: 999px;
  white-space: nowrap;
  cursor: pointer;
  color: var(--tag-color);
  border: 1px solid var(--tag-color);
  /* Plain tint through a low-opacity overlay: no color-mix, so older Chromium
     engines that do not parse it still render a readable pill. */
  background: var(--dsw-alias-bg-base);
  box-shadow: inset 0 0 0 999px rgba(128, 128, 128, .10);
}
.pgv-tag:hover { box-shadow: inset 0 0 0 999px rgba(128, 128, 128, .20); }
.pgv-tag-dot {
  width: 5px; height: 5px; border-radius: 999px;
  background: var(--tag-color);
  flex: 0 0 auto;
}
.pgv-tag-x {
  font: inherit; font-size: 9px; line-height: 1;
  background: none; border: none; padding: 0 0 0 2px;
  color: inherit; cursor: pointer; opacity: .7;
}
.pgv-tag-x:hover { opacity: 1; }

/* Tag editor, opened under a row. */
.pgv-tagslot {
  padding: 10px 14px 12px 31px;
  background: var(--dsw-alias-bg-layer-2);
  border-top: 1px dashed var(--dsw-alias-border-l1);
}
.pgv-tageditor { display: flex; flex-direction: column; gap: 9px; }
.pgv-tag-current { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 20px; }
.pgv-tag-compose { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pgv-tag-input {
  font: inherit; font-size: 12.5px; line-height: 1.4;
  flex: 1 1 240px; min-width: 180px;
  padding: 6px 10px; border-radius: 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
}
.pgv-tag-input:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.pgv-tag-input::placeholder { color: var(--dsw-alias-label-secondary); }
.pgv-tag-colors { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.pgv-tag-add {
  font: inherit; font-size: 12px; line-height: 1;
  padding: 6px 12px; border-radius: 8px; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-brand-primary);
}
.pgv-tag-add:disabled { opacity: .35; cursor: not-allowed; border-color: var(--dsw-alias-border-l1); }

.pgv-swatch {
  width: 20px; height: 20px; padding: 0;
  border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  display: inline-flex; align-items: center; justify-content: center;
}
.pgv-swatch:hover { border-color: var(--dsw-alias-label-primary); }
.pgv-swatch.is-selected { box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary); }
.pgv-swatch-dot {
  width: 13px; height: 13px; border-radius: 3px;
  background: var(--swatch);
  display: block;
}
.pgv-name { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pgv-titlerow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pgv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Provenance and switchability tags beside a plugin name. */
.pgv-badge {
  flex: 0 0 auto;
  font-size: 10.5px; line-height: 1;
  padding: 2px 6px; border-radius: 999px;
  white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
/* Locked: cannot be switched from here. */
.pgv-badge.is-locked {
  border-style: dashed;
  color: var(--dsw-alias-label-secondary);
}
/* Official: shipped by DeepSeek; still switchable when optional. */
.pgv-badge.is-official {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  background: transparent;
}
.pgv-badge.is-muted { opacity: .7; }
/* Second line: a user note wins, otherwise the plugin's own description.
   One line only, ellipsised: the description must never push the buttons out
   of the row or make rows different heights. */
.pgv-id {
  font-size: 11.5px; line-height: 1.35;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
/* A note is the user's own words, so it is tinted to read as authored text. */
.pgv-id.is-note { color: var(--dsw-alias-brand-primary); }
.pgv-noteedit { display: block; }
.pgv-note-input {
  font: inherit; font-size: 12px; line-height: 1.4;
  width: 100%;
  padding: 4px 8px; border-radius: 7px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-brand-primary);
}
.pgv-note-input::placeholder { color: var(--dsw-alias-label-secondary); }
/*
 * Actions stay visible instead of appearing on hover. Hiding them saved space but
 * made the row's controls undiscoverable, and the colours only help when they are
 * on screen. A fixed flex basis also stops a long description from squeezing them.
 */
.pgv-actions {
  display: flex; gap: 4px;
  flex: 0 0 auto;
  flex-wrap: nowrap;
}

/* A locked group: visibly inert, and its rows refuse drag and toggling. */
.pgv-group.is-locked {
  border-color: var(--dsw-alias-border-l2);
  border-style: solid;
}
.pgv-group.is-locked .pgv-head {
  cursor: default;
  /* The header keeps its raised background but loses the active accent. */
  background: var(--dsw-alias-bg-layer-1);
}
.pgv-group.is-locked .pgv-accent { opacity: .5; }
.pgv-row.is-locked { cursor: default; }
.pgv-row.is-locked .pgv-toggle { opacity: .4; cursor: not-allowed; }
.pgv-lockbadge {
  font-size: 11px; line-height: 1;
  padding: 3px 7px; border-radius: 999px;
  color: var(--dsw-alias-brand-primary);
  border: 1px solid var(--dsw-alias-brand-primary);
  white-space: nowrap;
}
.pgv-grip.is-disabled { cursor: default; opacity: .7; }

.pgv-dot { width: 7px; height: 7px; border-radius: 999px; flex: 0 0 auto; }
.pgv-dot.is-on { background: var(--dsw-alias-state-success-primary); }
.pgv-dot.is-off { background: var(--dsw-alias-state-idle-primary); }
.pgv-dot.is-busy { background: var(--dsw-alias-state-warn-primary); }

/* Enable switch with a text state, so it never reads as an unknown slider. */
.pgv-toggle {
  display: inline-flex; align-items: center; gap: 7px;
  font: inherit; font-size: 12px; line-height: 1;
  padding: 5px 10px 5px 6px; border-radius: 999px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.pgv-toggle:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
/* Guarded switch: visibly inert, keeps the plugin's real state readable. */
.pgv-toggle.is-protected,
.pgv-toggle.is-protected:hover {
  opacity: .8;
  cursor: not-allowed;
  color: var(--dsw-alias-label-secondary);
  border-color: var(--dsw-alias-border-l2);
  border-style: dashed;
  background: transparent;
}
.pgv-toggle.is-protected[data-on="true"] .pgv-track {
  background: var(--dsw-alias-state-idle-primary);
}
.pgv-toggle.is-protected .pgv-toggle-text { font-size: 11.5px; }
.pgv-toggle[data-on="true"] {
  color: var(--dsw-alias-state-success-primary);
  border-color: var(--dsw-alias-state-success-primary);
}
.pgv-toggle:disabled { opacity: .45; cursor: default; }
.pgv-track {
  position: relative; width: 30px; height: 17px; border-radius: 999px;
  background: var(--dsw-alias-state-idle-primary);
  transition: background .15s ease; flex: 0 0 auto;
}
.pgv-toggle[data-on="true"] .pgv-track { background: var(--dsw-alias-state-success-primary); }
.pgv-knob {
  position: absolute; top: 2px; left: 2px;
  width: 13px; height: 13px; border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  transition: transform .15s ease;
}
.pgv-toggle[data-on="true"] .pgv-knob { transform: translateX(13px); }
.pgv-toggle-text { white-space: nowrap; }

/* Inline "分配到 <分组>" picker on an ungrouped row. */
.pgv-assign { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.pgv-assign-label { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.pgv-select {
  font: inherit; font-size: 12px; line-height: 1;
  padding: 5px 8px; border-radius: 7px; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  max-width: 168px;
  transition: border-color .12s ease;
}
.pgv-select:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.pgv-select:disabled { opacity: .45; cursor: default; }
.pgv-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.pgv-empty {
  margin: 0; padding: 12px; font-size: 12.5px;
  color: var(--dsw-alias-label-secondary);
}
.pgv-picker {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  max-height: 220px; overflow-y: auto;
}
.pgv-chip {
  font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
}
.pgv-chip:hover { border-color: var(--dsw-alias-brand-primary); }

.pgv-notice {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-radius: 9px; font-size: 12.5px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
.pgv-notice.is-error { border-color: var(--dsw-alias-state-error-primary); }
.pgv-notice.is-warn { border-color: var(--dsw-alias-state-warn-primary); }
/* Incident notice shown when the view itself fails to render. */
.pgv-crash {
  padding: 16px; border-radius: 10px; font-size: 13px; line-height: 1.7;
  border: 1px solid var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.pgv-crash-title { font-weight: 600; margin-bottom: 8px; }
.pgv-crash-body {
  font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
  white-space: pre-wrap; word-break: break-word;
  color: var(--dsw-alias-label-secondary);
  max-height: 220px; overflow: auto;
}
.pgv-crash-actions { margin-top: 12px; display: flex; gap: 8px; }
`;

    /**
     * Defensive wrapper around the view.
     *
     * The host module table guarantees `createElement` and the hooks; it does not
     * guarantee the class-component surface, so this deliberately avoids
     * `React.Component`. Instead it renders the view inside a try/catch on the
     * first paint and falls back to an error notice with the real message. A
     * thrown render previously blanked the whole tab, which made every defect
     * look identical; this keeps the page alive and reports what broke.
     */
    function GuardedGroupsView(props) {
      const [failure, setFailure] = useState(null);
      if (failure) {
        const message = String(failure.stack ?? failure.message ?? failure);
        return h('div', { className: 'pgv-crash' }, [
          h('div', { key: 't', className: 'pgv-crash-title' }, '这个标签页渲染出错了'),
          h('div', { key: 'b', className: 'pgv-crash-body' }, message),
          h('div', { key: 'a', className: 'pgv-crash-actions' }, [
            h('button', {
              key: 'retry',
              type: 'button',
              className: 'pgv-btn',
              onClick: () => setFailure(null),
            }, '重试渲染'),
            h('button', {
              key: 'reload',
              type: 'button',
              className: 'pgv-btn',
              onClick: () => window.location.reload(),
            }, '刷新页面'),
          ]),
        ]);
      }
      try {
        return h(GroupsView, props);
      } catch (error) {
        // Defer the state write out of this render pass.
        setTimeout(() => setFailure(error), 0);
        return h('div', { className: 'pgv-crash' }, '正在收集错误信息…');
      }
    }

    return {
      // The generated Remote namespaces are separate services: `remote` alone
      // does not create `ctx.remote.pluginManager`. The official plugin manager
      // page declares these names explicitly, so this view declares them too.
      inject: ['slots', 'remote', 'remote.pluginManager'],
      apply(ctx) {
        liveCtx = ctx;
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'dsh-plugin-groups',
          order: 10,
          label: '我的分组',
        }, GuardedGroupsView));
      },
    };
  },
});
