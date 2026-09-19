/* =====================================================================
   Supabase sync for the RF mapping tool.

   Loaded after the main inline script, so it can read and replace the
   app's top-level state (buildings, floorPlans, heatmapDatasets,
   activeFloorId) and call its render functions.

   What goes where:
     Postgres  - buildings, floors with their GPS corners, dataset
                 metadata, contour settings. Small, queryable.
     Storage   - plan images and the parsed scan rows. Large, opaque.

   Saving upserts on (project_id, local_id), so pressing Save twice does
   not duplicate anything and the ids the browser is holding stay valid.
   ===================================================================== */
"use strict";

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const BUCKET = window.SUPABASE_BUCKET || 'mapping-files';
const LOGIN_PAGE = window.LOGIN_PAGE || '/login';

let currentProjectId = null;
let currentUserId = null;

/* ---------------------------------------------------------------- UI */

const cloudEls = {
    user: document.getElementById('cloudUser'),
    select: document.getElementById('cloudProjectSelect'),
    name: document.getElementById('cloudProjectName'),
    save: document.getElementById('cloudSaveBtn'),
    load: document.getElementById('cloudLoadBtn'),
    fresh: document.getElementById('cloudNewBtn'),
    remove: document.getElementById('cloudDeleteBtn'),
    signOut: document.getElementById('cloudSignOutBtn'),
    status: document.getElementById('cloudStatus'),
    current: document.getElementById('cloudCurrent'),
    saveAs: document.getElementById('cloudSaveAsBtn')
};

// Name of the site currently open, and whether anything changed since the
// last save. Both only drive the little header line in the panel.
let currentProjectName = '';
let dirty = false;
let suppressDirty = false;

function renderCloudHeader() {
    if (!cloudEls.current) return;
    if (!currentProjectId) {
        cloudEls.current.textContent = 'No site open - Save creates a new one';
        cloudEls.current.style.color = '#777';
        return;
    }
    cloudEls.current.textContent = 'Editing: ' + currentProjectName + (dirty ? ' (unsaved changes)' : ' (saved)');
    cloudEls.current.style.color = dirty ? '#c0392b' : '#0a7';
}

function markDirty() {
    if (suppressDirty) return;
    if (dirty) return;
    dirty = true;
    renderCloudHeader();
}

// The app redraws through these two functions on every edit, so wrapping them
// is enough to notice that the workspace moved away from what is stored.
['updateAllLayers', 'refreshAll'].forEach(fnName => {
    const original = window[fnName];
    if (typeof original !== 'function') return;
    window[fnName] = function () {
        const result = original.apply(this, arguments);
        markDirty();
        return result;
    };
});

// Which site to reopen next time, remembered per account in this browser.
function lastSiteKey() { return 'rfmap:lastProject:' + (currentUserId || 'anon'); }
function rememberLastSite(id) {
    try { id ? localStorage.setItem(lastSiteKey(), id) : localStorage.removeItem(lastSiteKey()); }
    catch (e) { /* private mode: not worth failing over */ }
}
function recallLastSite() {
    try { return localStorage.getItem(lastSiteKey()); } catch (e) { return null; }
}

function cloudStatus(text, isError) {
    if (!cloudEls.status) return;
    cloudEls.status.textContent = text || '';
    cloudEls.status.style.color = isError ? '#c0392b' : '#777';
}

function cloudBusy(busy) {
    [cloudEls.save, cloudEls.saveAs, cloudEls.load, cloudEls.fresh, cloudEls.remove]
        .forEach(b => { if (b) b.disabled = busy; });
}

/* ------------------------------------------------------------- Auth */

// The Flask routes read this flag to decide which page to serve. Keeping it
// in step with the real session is what stops a redirect loop between the two.
function setSessionCookie(exists) {
    document.cookie = 'sb-session=' + (exists ? '1' : '') +
        '; path=/; max-age=' + (exists ? 60 * 60 * 24 * 7 : 0) + '; SameSite=Lax';
}

async function requireSession() {
    const { data } = await sb.auth.getSession();
    if (!data.session) {
        setSessionCookie(false);
        window.location.replace(LOGIN_PAGE);
        return null;
    }
    setSessionCookie(true);
    currentUserId = data.session.user.id;
    if (cloudEls.user) cloudEls.user.textContent = 'Signed in as ' + data.session.user.email;
    return data.session;
}

sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
        setSessionCookie(false);
        window.location.replace(LOGIN_PAGE);
    }
});

/* ------------------------------------------------------- Storage I/O */

function dataUrlToBlob(dataUrl) {
    const [head, body] = dataUrl.split(',');
    const mime = (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

async function uploadBlob(path, blob, contentType) {
    const { error } = await sb.storage.from(BUCKET)
        .upload(path, blob, { upsert: true, contentType: contentType });
    if (error) throw error;
    return path;
}

async function signedUrl(path, seconds) {
    const { data, error } = await sb.storage.from(BUCKET)
        .createSignedUrl(path, seconds || 60 * 60 * 8);
    if (error) throw error;
    return data.signedUrl;
}

async function downloadJson(path) {
    const { data, error } = await sb.storage.from(BUCKET).download(path);
    if (error) throw error;
    return JSON.parse(await data.text());
}

/* --------------------------------------------------- Settings bundle */

const SETTING_IDS = [
    'ct3D', 'ctVWeight', 'ctInterval', 'ctGrid', 'ctRadius', 'ctPower',
    'ctFill', 'ctLines', 'ctLabels', 'ctPoints',
    'lockAspectChk', 'freeSkewChk', 'showAllFloorsChk', 'alwaysShowOutdoorChk'
];

function collectSettings() {
    const out = { renderMode: currentRenderMode };
    SETTING_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        out[id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
}

function applySettings(settings) {
    if (!settings) return;
    SETTING_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el || settings[id] === undefined) return;
        if (el.type === 'checkbox') el.checked = !!settings[id];
        else el.value = settings[id];
    });
    if (settings.renderMode) {
        const radio = document.querySelector('input[name="renderMode"][value="' + settings.renderMode + '"]');
        if (radio) { radio.checked = true; currentRenderMode = settings.renderMode; }
    }
}

/* ---------------------------------------------------------- Projects */

async function listProjects() {
    const { data, error } = await sb.from('projects')
        .select('id, name, updated_at')
        .order('updated_at', { ascending: false });
    if (error) throw error;

    cloudEls.select.innerHTML = data.length
        ? data.map(p => '<option value="' + p.id + '"' + (p.id === currentProjectId ? ' selected' : '') + '>' +
            p.name + ' - ' + new Date(p.updated_at).toLocaleDateString() + '</option>').join('')
        : '<option value="">(no saved site yet)</option>';
    return data;
}

async function saveProject() {
    const session = await requireSession();
    if (!session) return;

    cloudBusy(true);
    cloudStatus('Saving...');
    try {
        const name = (cloudEls.name.value || '').trim() || 'Untitled site';
        const centre = map.getCenter();
        const row = {
            name: name,
            map_center: { lat: centre.lat, lng: centre.lng },
            map_zoom: map.getZoom(),
            settings: collectSettings()
        };

        if (currentProjectId) {
            const { error } = await sb.from('projects').update(row).eq('id', currentProjectId);
            if (error) throw error;
        } else {
            const { data, error } = await sb.from('projects').insert(row).select('id').single();
            if (error) throw error;
            currentProjectId = data.id;
        }

        // --- buildings -------------------------------------------------
        const buildingRows = buildings.map((b, i) => ({
            project_id: currentProjectId,
            local_id: b.id,
            name: b.name,
            floor_height: b.floorHeight,
            visible: b.visible,
            sort_order: i
        }));
        let savedBuildings = [];
        if (buildingRows.length) {
            const { data, error } = await sb.from('buildings')
                .upsert(buildingRows, { onConflict: 'project_id,local_id' })
                .select('id, local_id');
            if (error) throw error;
            savedBuildings = data;
        }
        await pruneRows('buildings', buildings.map(b => b.id));
        const buildingIdOf = {};
        savedBuildings.forEach(r => { buildingIdOf[r.local_id] = r.id; });

        // --- floor plans (image to Storage, corners to Postgres) --------
        const floorRows = [];
        for (const f of floorPlans) {
            if (!f.imagePath || String(f.url).startsWith('data:')) {
                const path = currentUserId + '/' + currentProjectId + '/floors/' + f.id + '.png';
                await uploadBlob(path, dataUrlToBlob(f.url), 'image/png');
                f.imagePath = path;
            }
            floorRows.push({
                project_id: currentProjectId,
                building_id: buildingIdOf[f.buildingId],
                local_id: f.id,
                name: f.name,
                file_name: f.fileName,
                level: f.level,
                elevation: f.elevation,
                image_path: f.imagePath,
                img_w: f.imgW,
                img_h: f.imgH,
                tl_lat: f.tl.lat, tl_lng: f.tl.lng,
                tr_lat: f.tr.lat, tr_lng: f.tr.lng,
                bl_lat: f.bl.lat, bl_lng: f.bl.lng,
                opacity: f.opacity
            });
        }
        let savedFloors = [];
        if (floorRows.length) {
            const { data, error } = await sb.from('floor_plans')
                .upsert(floorRows, { onConflict: 'project_id,local_id' })
                .select('id, local_id');
            if (error) throw error;
            savedFloors = data;
        }
        await pruneRows('floor_plans', floorPlans.map(f => f.id));
        const floorIdOf = {};
        savedFloors.forEach(r => { floorIdOf[r.local_id] = r.id; });

        // --- datasets (rows to Storage, metadata to Postgres) -----------
        const dataRows = [];
        for (const d of heatmapDatasets) {
            if (!d.dataPath) {
                const path = currentUserId + '/' + currentProjectId + '/scans/' + d.id + '.json';
                const blob = new Blob([JSON.stringify(d.rawData)], { type: 'application/json' });
                await uploadBlob(path, blob, 'application/json');
                d.dataPath = path;
            }
            dataRows.push({
                project_id: currentProjectId,
                floor_id: d.floorId ? (floorIdOf[d.floorId] || null) : null,
                local_id: d.id,
                file_name: d.fileName,
                note: d.note,
                visible: d.visible,
                is_outdoor: d.isOutdoorGPS,
                lat_key: d.latKey || null,
                lng_key: d.lngKey || null,
                rsrp_key: d.rsrpKey || null,
                point_count: d.rawData ? d.rawData.length : 0,
                data_path: d.dataPath
            });
        }
        if (dataRows.length) {
            const { error } = await sb.from('datasets')
                .upsert(dataRows, { onConflict: 'project_id,local_id' });
            if (error) throw error;
        }
        await pruneRows('datasets', heatmapDatasets.map(d => d.id));

        currentProjectName = name;
        dirty = false;
        rememberLastSite(currentProjectId);
        renderCloudHeader();

        await listProjects();
        cloudStatus('Saved ' + buildings.length + ' buildings, ' + floorPlans.length +
                    ' floors, ' + heatmapDatasets.length + ' scans.');
    } catch (err) {
        console.error(err);
        cloudStatus('Save failed: ' + (err.message || err), true);
    } finally {
        cloudBusy(false);
    }
}

// Remove rows of this project whose local_id is no longer in the browser,
// so deleting a floor here deletes it in the cloud on the next save.
async function pruneRows(table, keepLocalIds) {
    let q = sb.from(table).delete().eq('project_id', currentProjectId);
    if (keepLocalIds.length) {
        q = q.not('local_id', 'in', '(' + keepLocalIds.map(id => '"' + id + '"').join(',') + ')');
    }
    const { error } = await q;
    if (error) throw error;
}

async function loadProject(projectId) {
    const session = await requireSession();
    if (!session || !projectId) return;

    cloudBusy(true);
    cloudStatus('Loading...');
    try {
        const { data: project, error: pErr } = await sb.from('projects')
            .select('*').eq('id', projectId).single();
        if (pErr) throw pErr;

        const [bRes, fRes, dRes] = await Promise.all([
            sb.from('buildings').select('*').eq('project_id', projectId).order('sort_order'),
            sb.from('floor_plans').select('*').eq('project_id', projectId).order('level'),
            sb.from('datasets').select('*').eq('project_id', projectId)
        ]);
        if (bRes.error) throw bRes.error;
        if (fRes.error) throw fRes.error;
        if (dRes.error) throw dRes.error;

        // floor uuid -> local id, so datasets can point back at the client objects
        const floorLocalOf = {};
        fRes.data.forEach(r => { floorLocalOf[r.id] = r.local_id; });

        buildings = bRes.data.map(r => ({
            id: r.local_id,
            name: r.name,
            floorHeight: Number(r.floor_height),
            visible: r.visible,
            shownFloorId: null,
            collapsed: true
        }));

        floorPlans = [];
        for (const r of fRes.data) {
            floorPlans.push({
                id: r.local_id,
                buildingId: (bRes.data.find(b => b.id === r.building_id) || {}).local_id,
                level: r.level,
                elevation: r.elevation === null ? null : Number(r.elevation),
                name: r.name,
                fileName: r.file_name,
                url: await signedUrl(r.image_path),
                imagePath: r.image_path,
                imgW: r.img_w,
                imgH: r.img_h,
                tl: { lat: r.tl_lat, lng: r.tl_lng },
                tr: { lat: r.tr_lat, lng: r.tr_lng },
                bl: { lat: r.bl_lat, lng: r.bl_lng },
                opacity: Number(r.opacity)
            });
        }

        heatmapDatasets = [];
        for (const r of dRes.data) {
            heatmapDatasets.push({
                id: r.local_id,
                fileName: r.file_name,
                rawData: r.data_path ? await downloadJson(r.data_path) : [],
                dataPath: r.data_path,
                note: r.note || '',
                visible: r.visible,
                isOutdoorGPS: r.is_outdoor,
                latKey: r.lat_key,
                lngKey: r.lng_key,
                rsrpKey: r.rsrp_key,
                floorId: r.floor_id ? (floorLocalOf[r.floor_id] || null) : null
            });
        }

        // Each building shows its lowest floor; the first one gets the handles.
        buildings.forEach(b => {
            const first = floorPlans.filter(f => f.buildingId === b.id).sort((x, y) => x.level - y.level)[0];
            if (first) b.shownFloorId = first.id;
        });
        activeFloorId = floorPlans.length ? (buildings[0] && buildings[0].shownFloorId) || floorPlans[0].id : null;

        applySettings(project.settings);
        currentProjectId = project.id;
        currentProjectName = project.name;
        cloudEls.name.value = project.name;

        // Rebuilding the workspace calls the redraw functions, which would
        // otherwise flag the freshly loaded site as edited.
        suppressDirty = true;
        refreshAll();
        checkExportStatus();
        suppressDirty = false;
        dirty = false;
        rememberLastSite(currentProjectId);
        renderCloudHeader();
        if (project.map_center) map.setView([project.map_center.lat, project.map_center.lng], project.map_zoom || 18);
        else fitMapToAllData();

        cloudStatus('Loaded "' + project.name + '".');
    } catch (err) {
        console.error(err);
        cloudStatus('Load failed: ' + (err.message || err), true);
    } finally {
        cloudBusy(false);
    }
}

async function deleteProject(projectId) {
    if (!projectId) return;
    if (!window.confirm('Delete this site and everything saved in it?')) return;

    cloudBusy(true);
    cloudStatus('Deleting...');
    try {
        // Storage has no cascade, so clear the project folder first.
        for (const folder of ['floors', 'scans']) {
            const prefix = currentUserId + '/' + projectId + '/' + folder;
            const { data } = await sb.storage.from(BUCKET).list(prefix);
            if (data && data.length) {
                await sb.storage.from(BUCKET).remove(data.map(o => prefix + '/' + o.name));
            }
        }
        const { error } = await sb.from('projects').delete().eq('id', projectId);
        if (error) throw error;

        if (projectId === currentProjectId) newProject();
        await listProjects();
        cloudStatus('Deleted.');
    } catch (err) {
        console.error(err);
        cloudStatus('Delete failed: ' + (err.message || err), true);
    } finally {
        cloudBusy(false);
    }
}

// Fork the open site: a new project row, and fresh copies of the images and
// scan rows, so editing the copy never touches the original's files.
async function saveProjectAsCopy() {
    if (!currentProjectId) { await saveProject(); return; }
    const base = (cloudEls.name.value || currentProjectName || 'Untitled site').trim();
    currentProjectId = null;
    currentProjectName = '';
    cloudEls.name.value = base + ' (copy)';
    floorPlans.forEach(f => { delete f.imagePath; });
    heatmapDatasets.forEach(d => { delete d.dataPath; });
    await saveProject();
}

function newProject() {
    currentProjectId = null;
    currentProjectName = '';
    buildings = [];
    floorPlans = [];
    heatmapDatasets = [];
    activeFloorId = null;
    cloudEls.name.value = '';
    suppressDirty = true;
    refreshAll();
    checkExportStatus();
    suppressDirty = false;
    dirty = false;
    rememberLastSite(null);
    renderCloudHeader();
    cloudStatus('Empty site. Import plans, then press Save.');
}

/* ------------------------------------------------------------- Wiring */

if (cloudEls.save) cloudEls.save.addEventListener('click', saveProject);
if (cloudEls.saveAs) cloudEls.saveAs.addEventListener('click', saveProjectAsCopy);
if (cloudEls.load) cloudEls.load.addEventListener('click', () => loadProject(cloudEls.select.value));
if (cloudEls.fresh) cloudEls.fresh.addEventListener('click', newProject);
if (cloudEls.remove) cloudEls.remove.addEventListener('click', () => deleteProject(cloudEls.select.value));
if (cloudEls.signOut) cloudEls.signOut.addEventListener('click', async () => {
    await sb.auth.signOut();
    setSessionCookie(false);
    window.location.replace(LOGIN_PAGE);
});

// Warn before losing unsaved work
window.addEventListener('beforeunload', (e) => {
    if (dirty && (floorPlans.length || heatmapDatasets.length)) {
        e.preventDefault();
        e.returnValue = '';
    }
});

(async () => {
    const session = await requireSession();
    if (!session) return;
    try {
        const projects = await listProjects();
        renderCloudHeader();

        // Carry on where this account left off, if that site still exists.
        const last = recallLastSite();
        if (last && projects.some(p => p.id === last)) {
            await loadProject(last);
            return;
        }
        cloudStatus(projects.length ? 'Pick a site and press Load.' : 'No saved site yet.');
    } catch (err) {
        cloudStatus('Could not reach the database: ' + (err.message || err), true);
    }
})();