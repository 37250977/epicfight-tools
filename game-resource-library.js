(function (root) {
    'use strict';
    const english = {
        '游戏目录 / 同源共享资源库': 'Game directory / same-origin shared library',
        '只读扫描实例根或 .minecraft 中 mods/*.jar、resourcepacks/*.zip（不递归）。先勾选再解析；同 ID 资源按列表顺序合并覆盖，不修改编辑配置。': 'Read-only scan of mods/*.jar and resourcepacks/*.zip in the instance root or .minecraft (not recursive). Select archives before parsing; resources with the same ID are merged and overwritten in list order without changing editor settings.',
        '共享库仅保存所选归档 Blob，不保存目录权限或句柄。仅相同协议、域名、端口的页面共享；浏览器清理数据后需重新导入。': 'The shared library stores only selected archive Blobs, not directory permissions or handles. Only pages with the same protocol, host and port share data; import again after clearing browser data.',
        '选择游戏目录，或打开已有共享库。': 'Choose a game directory or open the existing shared library.',
        '选择游戏目录': 'Choose game directory',
        '刷新共享库': 'Refresh shared library',
        '全选': 'Select all',
        '全不选': 'Deselect all',
        '导入勾选项': 'Import selected',
        '删除勾选的共享副本': 'Delete selected shared copies',
        '关闭': 'Close',
        '完成': 'Done',
        '扫描失败（{path}）：{error}': 'Scan failed ({path}): {error}',
        '导入失败（{name}）：{error}': 'Import failed ({name}): {error}',
        '已取消目录选择，原导入方式仍可使用。': 'Directory selection cancelled. The original import options are still available.',
        '操作失败，原文件夹 / ZIP/JAR 导入仍可使用。': 'Operation failed. The original folder / ZIP/JAR import options are still available.',
        '列出 {count} 个归档，默认全部未勾选。': 'Listed {count} archives; none selected by default.',
        '扫描中：找到 {count} 个归档（尚未解析）': 'Scanning: found {count} archives (not parsed yet)',
        '未找到归档。请选择包含 mods/resourcepacks 的实例根目录或 .minecraft。': 'No archives found. Choose an instance root or .minecraft containing mods/resourcepacks.',
        '请先勾选归档。': 'Select archives first.',
        '解析 {done}/{total}：{name}': 'Parsing {done}/{total}: {name}',
        '完成：已解析并交给资源识别流程 {imported}/{total} 个归档；无匹配资源时编辑器会另行提示。': 'Done: parsed and passed {imported}/{total} archives to resource detection; the editor will notify you separately if no matching resources are found.',
        '请先打开共享库并勾选副本。': 'Open the shared library and select copies first.',
        '仅删除浏览器共享副本，不删除游戏文件，也不清空当前页面已载入资源。继续？': 'Delete only the shared browser copies? Game files and resources loaded on this page will not be removed. Continue?',
        '目录选择需要 HTTPS 或 localhost 上支持 showDirectoryPicker 的浏览器（如桌面 Chrome / Edge）。请继续使用原文件夹或 ZIP/JAR 导入。': 'Directory selection requires HTTPS or localhost and a browser supporting showDirectoryPicker (such as desktop Chrome / Edge). Please use the original folder or ZIP/JAR import options instead.',
        '浏览器不支持 IndexedDB，共享资源库不可用': 'This browser does not support IndexedDB; the shared library is unavailable',
        '资源库升级被其他标签页阻止，请关闭旧页面后重试': 'Library upgrade blocked by another tab; close older pages and try again',
        '资源库读写失败': 'Library read/write failed',
        '资源库操作已中止': 'Library operation aborted',
        '共享归档已删除，请刷新列表': 'The shared archive was deleted; refresh the list',
        '{name}：已导入当前页面，但共享保存失败（可能配额不足）：{error}': '{name}: imported into this page, but saving the shared copy failed (possibly insufficient quota): {error}'
    };
    function translate(lang, key, params = {}) {
        const text = lang === 'en' && Object.prototype.hasOwnProperty.call(english, key) ? english[key] : key;
        return text.replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
    }
    async function scanDirectory(directory, onProgress = () => {}, t = (key, params) => translate('zh', key, params)) {
        const items = [], errors = [];
        const scanError = (path, error) => t('扫描失败（{path}）：{error}', { path, error: error.message || String(error) });
        async function child(parent, name, prefix = '') {
            try { return await parent.getDirectoryHandle(name, { create: false }); }
            catch (error) {
                if (error.name !== 'NotFoundError') errors.push(scanError(prefix + name, error));
                return null;
            }
        }
        const roots = [{ handle: directory, prefix: '' }];
        const minecraft = await child(directory, '.minecraft');
        if (minecraft) roots.push({ handle: minecraft, prefix: '.minecraft/' });
        for (const entry of roots) {
            for (const [folder, extension] of [['mods', /\.jar$/i], ['resourcepacks', /\.zip$/i]]) {
                const handle = await child(entry.handle, folder, entry.prefix);
                if (!handle) continue;
                try {
                    for await (const item of handle.values()) {
                        if (item.kind !== 'file' || !extension.test(item.name)) continue;
                        items.push({ path: entry.prefix + folder + '/' + item.name, name: item.name, handle: item });
                        onProgress(items.length);
                    }
                } catch (error) { errors.push(scanError(entry.prefix + folder, error)); }
            }
        }
        items.sort((a, b) => a.path.localeCompare(b.path));
        return { items, errors };
    }
    async function openDatabase() {
        if (!root.indexedDB) throw new Error('浏览器不支持 IndexedDB，共享资源库不可用');
        return new Promise((resolve, reject) => {
            const request = root.indexedDB.open('epicfight-shared-game-resources', 1);
            let blocked = false;
            request.onupgradeneeded = () => {
                const db = request.result;
                db.createObjectStore('metadata', { keyPath: 'id' });
                db.createObjectStore('archives');
            };
            request.onsuccess = () => {
                if (blocked) request.result.close();
                else resolve(request.result);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => { blocked = true; reject(new Error('资源库升级被其他标签页阻止，请关闭旧页面后重试')); };
        });
    }
    async function databaseTask(mode, operation) {
        const db = await openDatabase();
        try {
            return await new Promise((resolve, reject) => {
                const transaction = db.transaction(['metadata', 'archives'], mode);
                let result;
                transaction.oncomplete = () => resolve(result && result.result);
                transaction.onerror = () => reject(transaction.error || new Error('资源库读写失败'));
                transaction.onabort = () => reject(transaction.error || new Error('资源库操作已中止'));
                result = operation(transaction);
            });
        } finally { db.close(); }
    }
    const store = {
        list: () => databaseTask('readonly', tx => tx.objectStore('metadata').getAll()),
        get: id => databaseTask('readonly', tx => tx.objectStore('archives').get(id)),
        save: (metadata, blob) => databaseTask('readwrite', tx => {
            tx.objectStore('archives').put(blob, metadata.id);
            tx.objectStore('metadata').put(metadata);
        }),
        remove: id => databaseTask('readwrite', tx => {
            tx.objectStore('archives').delete(id);
            tx.objectStore('metadata').delete(id);
        })
    };
    async function importSelected(items, importArchive, progress, storage = store, t = (key, params) => translate('zh', key, params)) {
        const errors = [];
        let imported = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            progress(i, items.length, item.name);
            try {
                const blob = item.handle ? await item.handle.getFile() : await storage.get(item.id);
                if (!blob) throw new Error('共享归档已删除，请刷新列表');
                const file = new File([blob], item.name, { lastModified: blob.lastModified || 0 });
                await importArchive(file);
                imported++;
                if (item.handle) {
                    try {
                        const id = JSON.stringify([item.path, file.size, file.lastModified]);
                        await storage.save({ id, name: item.name, path: item.path, size: file.size }, file);
                    } catch (error) { errors.push(t('{name}：已导入当前页面，但共享保存失败（可能配额不足）：{error}', { name: item.name, error: t(error.message || String(error)) })); }
                }
            } catch (error) { errors.push(t('导入失败（{name}）：{error}', { name: item.name, error: t(error.message || String(error)) })); }
        }
        progress(items.length, items.length, t('完成'));
        return { imported, errors };
    }
    let activeDialog = null;
    function open(editor, lang) {
        if (activeDialog) { activeDialog.focus(); return; }
        // showModal makes the page language controls inert; capture the current language on every open.
        const t = (key, params) => translate(lang, key, params);
        const dialog = document.createElement('dialog');
        activeDialog = dialog;
        dialog.style.cssText = 'width:min(760px,90vw);max-height:85vh;overflow:auto;padding:20px;background:#242830;color:#eee;border:1px solid #7a8497;border-radius:10px;z-index:99999';
        function element(tag, text, parent = dialog) {
            const node = document.createElement(tag);
            if (text) node.textContent = t(text);
            node.style.color = '#f1f5f9';
            parent.appendChild(node);
            return node;
        }
        element('h2', '游戏目录 / 同源共享资源库');
        element('p', '只读扫描实例根或 .minecraft 中 mods/*.jar、resourcepacks/*.zip（不递归）。先勾选再解析；同 ID 资源按列表顺序合并覆盖，不修改编辑配置。');
        element('p', '共享库仅保存所选归档 Blob，不保存目录权限或句柄。仅相同协议、域名、端口的页面共享；浏览器清理数据后需重新导入。');
        const toolbar = element('div');
        const controls = [];
        let busy = false, rows = [];
        const status = element('p', '选择游戏目录，或打开已有共享库。');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const progress = element('progress');
        progress.max = 1; progress.value = 0;
        const list = element('div');
        list.style.cssText = 'max-height:40vh;overflow:auto;margin:12px 0';
        const errors = element('pre');
        errors.style.cssText = 'white-space:pre-wrap;color:#ffb5ad';
        function button(text, action) {
            const button = element('button', text, toolbar);
            button.type = 'button';
            button.style.cssText = 'margin:4px;padding:6px 10px;background:#334155;color:#f8fafc;border:1px solid #94a3b8;border-radius:4px;font:inherit';
            button.onclick = action;
            controls.push(button);
            return button;
        }
        function setBusy(value) {
            busy = value;
            controls.forEach(control => { control.disabled = value; });
            rows.forEach(row => { row.checkbox.disabled = value; });
        }
        async function run(action) {
            if (busy) return;
            setBusy(true); errors.textContent = '';
            try { await action(); }
            catch (error) {
                status.textContent = t(error.name === 'AbortError' ? '已取消目录选择，原导入方式仍可使用。' : '操作失败，原文件夹 / ZIP/JAR 导入仍可使用。');
                errors.textContent = error.name === 'AbortError' ? '' : t(error.message || String(error));
            } finally { setBusy(false); }
        }
        function render(items) {
            list.replaceChildren();
            rows = items.map(item => {
                const label = element('label', '', list);
                label.style.cssText = 'display:block;overflow-wrap:anywhere;padding:5px;color:#f1f5f9';
                const checkbox = element('input', '', label);
                checkbox.type = 'checkbox'; checkbox.disabled = busy;
                element('span', ' ' + item.path + (item.size === undefined ? '' : ' (' + (item.size / 1048576).toFixed(1) + ' MiB)'), label);
                return { item, checkbox };
            });
            status.textContent = t('列出 {count} 个归档，默认全部未勾选。', { count: items.length });
        }
        button('选择游戏目录', () => run(async () => {
            if (!root.isSecureContext || typeof root.showDirectoryPicker !== 'function') {
                throw new Error('目录选择需要 HTTPS 或 localhost 上支持 showDirectoryPicker 的浏览器（如桌面 Chrome / Edge）。请继续使用原文件夹或 ZIP/JAR 导入。');
            }
            const directory = await root.showDirectoryPicker({ mode: 'read' });
            render([]);
            const result = await scanDirectory(directory, count => { status.textContent = t('扫描中：找到 {count} 个归档（尚未解析）', { count }); }, t);
            render(result.items);
            if (!result.items.length) status.textContent = t('未找到归档。请选择包含 mods/resourcepacks 的实例根目录或 .minecraft。');
            errors.textContent = result.errors.join('\n');
        }));
        button('刷新共享库', () => run(async () => { render(await store.list()); }));
        button('全选', () => rows.forEach(row => { row.checkbox.checked = true; }));
        button('全不选', () => rows.forEach(row => { row.checkbox.checked = false; }));
        button('导入勾选项', () => run(async () => {
            const selected = rows.filter(row => row.checkbox.checked).map(row => row.item);
            if (!selected.length) { status.textContent = t('请先勾选归档。'); return; }
            const result = await importSelected(selected,
                file => editor.importZipResources({ target: { files: [file], value: '' } }, { strict: true }),
                (done, total, name) => {
                    progress.max = total; progress.value = done;
                    status.textContent = t('解析 {done}/{total}：{name}', { done, total, name });
                }, store, t);
            status.textContent = t('完成：已解析并交给资源识别流程 {imported}/{total} 个归档；无匹配资源时编辑器会另行提示。', { imported: result.imported, total: selected.length });
            errors.textContent = result.errors.join('\n');
        }));
        button('删除勾选的共享副本', () => run(async () => {
            const selected = rows.filter(row => row.checkbox.checked && !row.item.handle);
            if (!selected.length) { status.textContent = t('请先打开共享库并勾选副本。'); return; }
            if (!root.confirm(t('仅删除浏览器共享副本，不删除游戏文件，也不清空当前页面已载入资源。继续？'))) return;
            for (const row of selected) await store.remove(row.item.id);
            render(await store.list());
        }));
        button('关闭', () => { if (!busy) dialog.close(); });
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        dialog.addEventListener('close', () => { dialog.remove(); activeDialog = null; rows = []; });
        document.body.appendChild(dialog);
        dialog.showModal();
    }
    const api = { scanDirectory, importSelected, open, translate };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.GameResourceLibrary = api;
})(globalThis);
