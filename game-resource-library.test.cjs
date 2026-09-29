const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const library = require('./game-resource-library.js');
function directory(name, children = []) {
    return { name, kind: 'directory', async getDirectoryHandle(key, options) {
        assert.equal(options.create, false);
        const child = children.find(item => item.name === key && item.kind === 'directory');
        if (!child) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        return child;
    }, async *values() { yield* children; } };
}
const file = name => ({ name, kind: 'file', getFile() { throw new Error('扫描阶段不能读取文件内容'); } });
test('只扫描实例根和 .minecraft 的 mods/JAR、resourcepacks/ZIP，不读取归档或递归 saves', async () => {
    const root = directory('instance', [directory('mods', [file('a.jar'), file('ignore.zip'), directory('nested', [file('hidden.jar')])]), directory('saves', [file('world.jar')]), directory('.minecraft', [directory('resourcepacks', [file('pack.ZIP'), file('ignore.txt')])])]);
    const result = await library.scanDirectory(root);
    assert.deepEqual(result.items.map(item => item.path), ['.minecraft/resourcepacks/pack.ZIP', 'mods/a.jar']);
    assert.deepEqual(result.errors, []);
});
test('可直接选择 .minecraft，权限错误反馈且不妨碍其他目录扫描', async () => {
    const root = directory('.minecraft', [directory('resourcepacks', [file('pack.zip')])]);
    const original = root.getDirectoryHandle;
    root.getDirectoryHandle = function (name, options) {
        if (name === 'mods') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        return original.call(this, name, options);
    };
    const result = await library.scanDirectory(root);
    assert.equal(result.items.length, 1);
    assert.match(result.errors[0], /denied/);
});
for (const lang of ['zh', 'en']) {
    test(lang + ' 扫描权限错误使用本地化说明并保留路径和原始详情', async () => {
        const root = directory('instance', [directory('.minecraft', [directory('resourcepacks', [file('ok.zip')])])]);
        const minecraft = await root.getDirectoryHandle('.minecraft', { create: false });
        const original = minecraft.getDirectoryHandle;
        minecraft.getDirectoryHandle = function (name, options) {
            if (name === 'mods') throw Object.assign(new Error('权限不足 {count}'), { name: 'NotAllowedError' });
            return original.call(this, name, options);
        };
        const result = await library.scanDirectory(root, () => {}, (key, params) => library.translate(lang, key, params));
        assert.equal(result.items.length, 1);
        assert.equal(result.errors[0], lang === 'en' ? 'Scan failed (.minecraft/mods): 权限不足 {count}' : '扫描失败（.minecraft/mods）：权限不足 {count}');
    });
}
test('只有显式传入的勾选项被读取、解析及保存；共享保存不包含权限句柄', async () => {
    const saved = [], parsed = [], progress = [];
    const selected = { path: 'mods/a.jar', name: 'a.jar', handle: { getFile: async () => new File(['archive'], 'a.jar', { lastModified: 12 }) } };
    const result = await library.importSelected([selected], async file => parsed.push(file.name), (...args) => progress.push(args), {
        async save(metadata, blob) { saved.push({ metadata, blob }); }
    });
    assert.equal(result.imported, 1);
    assert.deepEqual(parsed, ['a.jar']);
    assert.deepEqual(Object.keys(saved[0].metadata).sort(), ['id', 'name', 'path', 'size']);
    assert.equal(await saved[0].blob.text(), 'archive');
    assert.deepEqual(progress.at(-1), [1, 1, '完成']);
    const empty = await library.importSelected([], () => assert.fail('不应解析'), () => {}, {});
    assert.equal(empty.imported, 0);
});
test('坏归档不持久化、逐项继续；共享配额失败保留本页导入结果', async () => {
    const items = ['bad.jar', 'good.jar'].map(name => ({ name, path: 'mods/' + name, handle: { getFile: async () => new File(['x'], name) } }));
    let saves = 0;
    const result = await library.importSelected(items, async file => {
        if (file.name === 'bad.jar') throw new Error('corrupt');
    }, () => {}, { async save() { saves++; throw new Error('quota'); } });
    assert.equal(saves, 1);
    assert.equal(result.imported, 1);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /corrupt/);
    assert.match(result.errors[1], /quota/);
});
test('共享库读取 Blob 后复用解析，不索要目录权限；缺失归档报告错误', async () => {
    const parsed = [];
    const result = await library.importSelected([{ id: 'a', name: 'cached.jar' }, { id: 'missing', name: 'missing.jar' }],
        async file => parsed.push(await file.text()), () => {}, { get: async id => id === 'a' ? new Blob(['cached']) : undefined });
    assert.deepEqual(parsed, ['cached']);
    assert.equal(result.imported, 1);
    assert.match(result.errors[0], /已删除/);
});
test('共享文案支持页面既有中英文，参数插值不丢失错误原文', () => {
    assert.equal(library.translate('en', '选择游戏目录'), 'Choose game directory');
    assert.equal(library.translate('zh', '选择游戏目录'), '选择游戏目录');
    assert.equal(library.translate('en', '扫描中：找到 {count} 个归档（尚未解析）', { count: 3 }), 'Scanning: found 3 archives (not parsed yet)');
    assert.equal(library.translate('en', '原始中文错误：权限不足'), '原始中文错误：权限不足');
});
function dialogHarness() {
    class Node {
        constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.events = {}; this.history = []; this.textContent = ''; }
        set textContent(value) { this.text = value; this.history.push(value); }
        get textContent() { return this.text; }
        appendChild(node) { this.children.push(node); }
        replaceChildren() { this.children = []; }
        setAttribute(key, value) { this[key] = value; }
        addEventListener(key, fn) { this.events[key] = fn; }
        showModal() { this.modal = true; }
        close() { this.events.close(); }
        remove() { this.removed = true; }
        focus() {}
    }
    const body = new Node('body');
    const context = { document: { body, createElement: tag => new Node(tag) }, File, Blob, isSecureContext: true, confirm: text => { context.confirmation = text; return false; } };
    vm.runInNewContext(readFileSync(require('node:path').join(__dirname, 'game-resource-library.js'), 'utf8'), context);
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    return {
        context,
        open(lang) {
            context.GameResourceLibrary.open({ importZipResources: async () => {} }, lang);
            const dialog = body.children.at(-1);
            return {
                dialog,
                nodes: () => descendants(dialog),
                button: text => descendants(dialog).find(node => node.tag === 'button' && node.textContent === text),
                status: descendants(dialog).find(node => node.role === 'status'),
                errors: descendants(dialog).find(node => node.tag === 'pre')
            };
        }
    };
}
for (const lang of ['zh', 'en']) {
    test(lang + ' 弹窗实际渲染、能力错误、取消、扫描与导入动态状态均翻译，保留高对比度', async () => {
        const harness = dialogHarness();
        const t = (key, params) => library.translate(lang, key, params);
        const view = harness.open(lang);
        assert.equal(view.dialog.modal, true);
        assert.equal(view.nodes().find(node => node.tag === 'h2').textContent, t('游戏目录 / 同源共享资源库'));
        assert.equal(view.status.textContent, t('选择游戏目录，或打开已有共享库。'));
        assert.match(view.button(t('选择游戏目录')).style.cssText, /color:#f8fafc/);
        assert.equal(view.nodes().find(node => node.tag === 'h2').style.color, '#f1f5f9');
        if (lang === 'en') assert.ok(view.nodes().every(node => !/[\u3400-\u9fff]/.test(node.textContent)));
        await view.button(t('选择游戏目录')).onclick();
        assert.match(view.errors.textContent, lang === 'en' ? /requires HTTPS/ : /需要 HTTPS/);
        await view.button(t('刷新共享库')).onclick();
        assert.match(view.errors.textContent, lang === 'en' ? /does not support IndexedDB/ : /不支持 IndexedDB/);
        await view.button(t('导入勾选项')).onclick();
        assert.equal(view.status.textContent, t('请先勾选归档。'));
        await view.button(t('删除勾选的共享副本')).onclick();
        assert.equal(view.status.textContent, t('请先打开共享库并勾选副本。'));
        harness.context.showDirectoryPicker = async () => { throw Object.assign(new Error('取消'), { name: 'AbortError' }); };
        await view.button(t('选择游戏目录')).onclick();
        assert.equal(view.status.textContent, t('已取消目录选择，原导入方式仍可使用。'));
        assert.equal(view.errors.textContent, '');
        harness.context.showDirectoryPicker = async () => directory('empty');
        await view.button(t('选择游戏目录')).onclick();
        assert.equal(view.status.textContent, t('未找到归档。请选择包含 mods/resourcepacks 的实例根目录或 .minecraft。'));
        harness.context.showDirectoryPicker = async () => ({ getDirectoryHandle: async () => { throw Object.assign(new Error('权限不足 {count}'), { name: 'NotAllowedError' }); } });
        await view.button(t('选择游戏目录')).onclick();
        assert.ok(view.errors.textContent.includes(t('扫描失败（{path}）：{error}', { path: 'mods', error: '权限不足 {count}' })));
        harness.context.showDirectoryPicker = async () => directory('instance', [directory('mods', [{ name: '中文.jar', kind: 'file', getFile: async () => new File(['x'], '中文.jar') }])]);
        await view.button(t('选择游戏目录')).onclick();
        assert.ok(view.status.history.includes(t('扫描中：找到 {count} 个归档（尚未解析）', { count: 1 })));
        assert.equal(view.status.textContent, t('列出 {count} 个归档，默认全部未勾选。', { count: 1 }));
        view.button(t('全选')).onclick();
        assert.equal(view.nodes().find(node => node.tag === 'input').checked, true);
        view.button(t('全不选')).onclick();
        assert.equal(view.nodes().find(node => node.tag === 'input').checked, false);
        view.button(t('全选')).onclick();
        await view.button(t('导入勾选项')).onclick();
        assert.ok(view.status.history.includes(t('解析 {done}/{total}：{name}', { done: 0, total: 1, name: '中文.jar' })));
        assert.equal(view.status.textContent, t('完成：已解析并交给资源识别流程 {imported}/{total} 个归档；无匹配资源时编辑器会另行提示。', { imported: 1, total: 1 }));
        assert.match(view.errors.textContent, lang === 'en' ? /saving the shared copy failed/ : /共享保存失败/);
        view.button(t('关闭')).onclick();
        assert.equal(view.dialog.removed, true);
        const reopened = harness.open(lang === 'en' ? 'zh' : 'en');
        assert.equal(reopened.nodes().find(node => node.tag === 'h2').textContent, library.translate(lang === 'en' ? 'zh' : 'en', '游戏目录 / 同源共享资源库'));
    });
    test(lang + ' 导入失败、配额错误与缺失归档使用当前语言并保留中文底层错误', async () => {
        const t = (key, params) => library.translate(lang, key, params);
        const result = await library.importSelected([
            { name: 'bad.jar', handle: { getFile: async () => { throw new Error('原始中文错误：权限不足 {count}'); } } },
            { name: 'good.jar', path: 'mods/good.jar', handle: { getFile: async () => new File(['x'], 'good.jar') } },
            { name: 'missing.jar', id: 'missing' }
        ], async () => {}, () => {}, { save: async () => { throw new Error('原始中文错误：配额不足'); }, get: async () => undefined }, t);
        assert.equal(result.imported, 1);
        assert.equal(result.errors[0], lang === 'en' ? 'Import failed (bad.jar): 原始中文错误：权限不足 {count}' : '导入失败（bad.jar）：原始中文错误：权限不足 {count}');
        assert.match(result.errors[1], /原始中文错误：配额不足/);
        assert.match(result.errors[1], lang === 'en' ? /saving the shared copy failed/ : /共享保存失败/);
        assert.match(result.errors[2], lang === 'en' ? /archive was deleted/ : /共享归档已删除/);
    });
    test(lang + ' 共享库副本删除确认框使用当前语言', async () => {
        const harness = dialogHarness();
        harness.context.indexedDB = { open() {
            const request = {};
            queueMicrotask(() => {
                request.result = { close() {}, transaction() {
                    const tx = { objectStore: () => ({ getAll: () => ({ result: [{ id: 'cached', name: 'cached.jar', path: 'mods/cached.jar', size: 10 }] }) }) };
                    queueMicrotask(() => tx.oncomplete());
                    return tx;
                } };
                request.onsuccess();
            });
            return request;
        } };
        const t = key => library.translate(lang, key);
        const view = harness.open(lang);
        await view.button(t('刷新共享库')).onclick();
        view.button(t('全选')).onclick();
        await view.button(t('删除勾选的共享副本')).onclick();
        assert.equal(harness.context.confirmation, t('仅删除浏览器共享副本，不删除游戏文件，也不清空当前页面已载入资源。继续？'));
    });
}
const editors = ['Indestructible_VisualEditor.html', 'Invincible_VisualEditor.html', 'index.html'];
for (const editor of editors) {
    const html = readFileSync(require('node:path').join(__dirname, editor), 'utf8');
    test(editor + ' 共享入口沿用页面语言，未加载提示使用页面词典', () => {
        const messagesSource = html.match(/const messages\s*=\s*({[\s\S]*?\n\s*});/)[1];
        const messages = vm.runInNewContext('(' + messagesSource + ')');
        const method = html.match(/openGameDirectoryPicker\(\)\s*\{[\s\S]*?\n\s*\},/)[0].slice(0, -1);
        const alerts = [], calls = [];
        const window = {};
        const adapter = vm.runInNewContext('({' + method + '})', { window, alert: text => alerts.push(text) });
        adapter.t = function (key) { return messages[this.lang] && messages[this.lang][key] || key; };
        assert.ok(html.includes("{{ t('选择游戏目录 / 共享库') }}"));
        assert.match(html, /lang:\s*localStorage\.getItem\('ce_lang'\)/);
        for (const lang of ['zh', 'en', 'zh']) {
            adapter.lang = lang;
            assert.equal(adapter.t('选择游戏目录 / 共享库'), lang === 'en' ? 'Choose game directory / Shared library' : '选择游戏目录 / 共享库');
            delete window.GameResourceLibrary;
            adapter.openGameDirectoryPicker();
            assert.equal(alerts.at(-1), lang === 'en' ? 'The shared resource script did not load. Please use the original import options.' : '共享资源脚本未加载，请使用原导入方式。');
            window.GameResourceLibrary = { open: (...args) => calls.push(args) };
            adapter.openGameDirectoryPicker();
            assert.equal(calls.at(-1)[0], adapter);
            assert.equal(calls.at(-1)[1], lang);
        }
    });
    test(editor + ' 所有内联脚本可解析，保留原入口并接入共享库', () => {
        assert.match(html, /src="game-resource-library.js"/);
        for (const name of ['openGameDirectoryPicker', 'openAssetZipPicker', 'openAssetFolderPicker']) assert.ok(html.includes('@click="' + name + '"'));
        for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
            if (/src=|importmap/.test(match[1])) continue;
            const result = spawnSync(process.execPath, ['--check', '--input-type=' + (/type="module"/.test(match[1]) ? 'module' : 'commonjs')], { input: match[2], encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
        }
    });
    test(editor + ' 共享入口透传解析错误，成功后等待原资源识别完成', async () => {
        const start = html.indexOf('async importZipResources(');
        const end = html.indexOf("event.target.value", start);
        const close = html.indexOf('\n', end);
        const method = html.slice(start, close) + '\n}';
        let fail = true, terminated = 0, revoked = 0, processed = false;
        class Worker {
            postMessage() { queueMicrotask(() => this.onmessage({ data: fail ? { success: false, error: 'bad zip' } : { success: true, entries: [] } })); }
            terminate() { terminated++; }
        }
        const adapter = vm.runInNewContext('({' + method + '})', { Worker, Blob, File, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => revoked++ }, console, alert: () => assert.fail('strict 模式不应吞错弹窗') });
        adapter.processExtractedFiles = async () => { await new Promise(resolve => setTimeout(resolve, 5)); processed = true; };
        await assert.rejects(adapter.importZipResources({ target: { files: [new File(['x'], 'a.jar')] } }, { strict: true }), /bad zip/);
        fail = false;
        await adapter.importZipResources({ target: { files: [new File(['x'], 'a.jar')] } }, { strict: true });
        assert.equal(processed, true);
        assert.equal(terminated, 2);
        assert.equal(revoked, 2);
    });
}
