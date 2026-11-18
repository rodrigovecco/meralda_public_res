/**
 * DevExtreme FileManager wrapper for Meralda static-files areas.
 *
 * Talks to mwmod_mw_staticfiles_ui_adminui over the framework `sxml` channel:
 *   POST  <sxmlUrl con __CMD__ reemplazado por el comando>
 *   comandos: list | read | write | mkdir | rename | delete | upload(multipart)
 *
 * Uso (el servidor emite esto en un bloque jQuery ready):
 *   new mw_staticfiles_fm({ containerId, sxmlUrl, rootUrl, editableRoot, ... });
 *
 * Las REGLAS vienen del servidor. El widget solo deshabilita lo que el payload
 * dice que no está permitido; el servidor rechaza cualquier cosa que se cuele.
 */
(function () {
    'use strict';

    /* ================================================================== */
    /* HTTP                                                               */
    /* ================================================================== */

    /**
     * Resolve the command URL.
     *
     * The framework encodes the command in the path
     * (`/get/uiadmin/sxml/ui/<ui>/<cmd>`), so the server hands over a template
     * with a __CMD__ placeholder.
     */
    function cmdUrl(cfg, name) {
        if (!cfg.sxmlUrl) { return ''; }
        if (cfg.sxmlUrl.indexOf('__CMD__') === -1) { return cfg.sxmlUrl + '/' + name; }
        return cfg.sxmlUrl.replace('__CMD__', encodeURIComponent(name));
    }

    function post(url, data) {
        var body = new URLSearchParams();
        Object.keys(data || {}).forEach(function (k) {
            if (data[k] !== undefined && data[k] !== null) { body.append(k, data[k]); }
        });
        return fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: body.toString()
        }).then(function (r) { return r.json(); });
    }

    function cmd(cfg, name, data) {
        return post(cmdUrl(cfg, name), data);
    }

    /* ================================================================== */
    /* Helpers                                                            */
    /* ================================================================== */

    function notify(msg, type) {
        if (window.DevExpress && DevExpress.ui && DevExpress.ui.notify) {
            DevExpress.ui.notify(msg, type || 'info', 2600);
        } else {
            console.log('[staticfiles]', type || 'info', msg);
        }
    }

    function joinPath(dir, name) {
        dir = (dir || '').replace(/^\/+|\/+$/g, '');
        return dir ? dir + '/' + name : name;
    }

    function parentOf(path) {
        path = (path || '').replace(/^\/+|\/+$/g, '');
        var i = path.lastIndexOf('/');
        return i === -1 ? '' : path.substring(0, i);
    }

    /**
     * Base class of the provider.
     *
     * DevExtreme 23.x exposes it as `DevExpress.fileManagement.CustomFileSystemProvider`
     * (lowercase "fileManagement"). Older/newer bundles may use
     * `DevExpress.FileManagement` or `DevExpress.data`, so all three are probed.
     */
    function providerCtor() {
        var dx = window.DevExpress || {};
        var bags = [dx.fileManagement, dx.FileManagement, dx.data];
        for (var i = 0; i < bags.length; i++) {
            if (bags[i] && bags[i].CustomFileSystemProvider) {
                return bags[i].CustomFileSystemProvider;
            }
        }
        return null;
    }

    /**
     * Directory the widget is asking for.
     *
     * DevExtreme passes a `pathInfo` object; depending on the build the current
     * directory arrives in `path`, in `key`, or only as `pathKeys`. Reading all
     * three is what keeps the tree from re-nesting the same folder.
     */
    function dirFromPathInfo(pathInfo) {
        if (!pathInfo) { return ''; }
        if (typeof pathInfo === 'string') { return pathInfo.replace(/^\/+|\/+$/g, ''); }
        if (typeof pathInfo.path === 'string' && pathInfo.path) {
            return pathInfo.path.replace(/^\/+|\/+$/g, '');
        }
        if (typeof pathInfo.key === 'string' && pathInfo.key) {
            return pathInfo.key.replace(/^\/+|\/+$/g, '');
        }
        if (pathInfo.pathKeys && pathInfo.pathKeys.length) {
            return pathInfo.pathKeys
                .map(function (k) {
                    if (k && typeof k === 'object') { return k.name || k.path || ''; }
                    return String(k || '');
                })
                .filter(function (k) { return k !== ''; })
                .join('/');
        }
        return '';
    }

    /** DevExtreme item → plain object used by our provider. */
    function toItem(it) {
        var path = (it.path || '').replace(/^\/+|\/+$/g, '');
        return {
            name: it.name,
            path: path,
            // pathKeys helps the widget rebuild the tree without guessing.
            pathKeys: path ? path.split('/') : [],
            isDirectory: !!it.isDirectory,
            size: it.size || 0,
            modifiedDate: it.modified ? new Date(it.modified) : new Date(),
            // Campos propios: viajan con el item para que la UI decida sin
            // otra llamada al servidor. `readable` y `editable` son distintos:
            // un área congelada se lee pero no se guarda.
            editable: !!it.editable,
            readable: !!it.readable,
            deletable: !!it.deletable,
            renamable: !!it.renamable,
            // Carpeta protegida: se ve y se recorre, pero no se toca. Vive en
            // `byPath` igual que las demás banderas, porque DevExtreme descarta
            // los campos que no conoce al normalizar los items.
            protected: !!it.protected,
            url: it.url || ''
        };
    }

    /* ================================================================== */
    /* Styles                                                             */
    /* ================================================================== */

    /**
     * Layout fixes for the DevExtreme file manager.
     *
     * 1. The progress/notification panel is parked off-screen with a negative
     *    margin. That shifts the whole widget left (the folder tree gets cut)
     *    and adds a phantom "Progress" column on the right, so it is removed:
     *    uploads are reported with our own notifications instead.
     * 2. The DataGrid "free space row" covers the real rows, so clicks on a
     *    file end up in an empty row. It is decorative: no pointer.
     */
    function injectStyles() {
        if (document.getElementById('mw-fm-styles')) { return; }
        var st = document.createElement('style');
        st.id = 'mw-fm-styles';
        st.textContent = [
            '.dx-filemanager-notification-drawer .dx-filemanager-progress-panel{display:none !important;}',
            '.dx-filemanager{overflow:hidden;width:100%;max-width:100%;}',
            '.dx-filemanager-toolbar{padding:4px 0;}',
            '.dx-filemanager .dx-freespace-row{pointer-events:none;}',
            '.dx-filemanager .dx-freespace-row td{pointer-events:none;}'
        ].join('\n');
        document.head.appendChild(st);
    }

    /* ================================================================== */
    /* File system provider (options object)                              */
    /* ================================================================== */

    /**
     * POST one file to the server.
     *
     * @param {object} cfg      widget config (sxmlUrl)
     * @param {object} widget   owning widget (used to refresh the grid)
     * @param {File}   fileData
     * @param {object} destDir  DevExtreme directory item (may be null for root)
     * @return {Promise}  resolves with the created item, as DevExtreme expects
     */
    function uploadOne(cfg, widget, fileData, destDir) {
        var dir = dirFromPathInfo(destDir);
        var fd = new FormData();
        fd.append('path', dir);
        fd.append('upload', fileData, fileData.name);
        return fetch(cmdUrl(cfg, 'upload'), {
            method: 'POST',
            credentials: 'same-origin',
            body: fd
        }).then(function (r) { return r.json(); }).then(function (r) {
            if (!r.ok) { throw new Error(r.msg || 'Cannot upload'); }
            // El servidor normaliza el nombre (sin espacios, sin mayúsculas).
            // Se avisa SIEMPRE que el nombre guardado no sea el original, si no
            // el usuario cree que el archivo se perdió.
            if (r.renamed) {
                notify(
                    (r.orig_name || '') + ' → ' + (r.saved_name || '') +
                    '  (' + (cfg.msgs.renamed || 'saved without spaces or capitals') + ')',
                    'warning'
                );
            }
            // La grilla se recarga: el item devuelto puede tener otro nombre.
            if (widget) {
                setTimeout(function () { widget.refresh(); }, 250);
            }
            return toItem(r.item);
        });
    }

    function buildProvider(cfg, widget) {
        var Ctor = providerCtor();
        if (!Ctor) { return null; }

        return new Ctor({
            getItems: function (pathInfo) {
                var dir = dirFromPathInfo(pathInfo);
                return cmd(cfg, 'list', { path: dir }).then(function (r) {
                    if (!r.ok) { throw new Error(r.msg || 'Cannot list'); }
                    var items = (r.items || []).map(toItem);
                    // DevExtreme normaliza los items y descarta los campos que no
                    // conoce, así que las banderas editable/deletable/renamable se
                    // guardan aquí y se consultan por path.
                    if (widget) {
                        items.forEach(function (it) { widget.byPath[it.path] = it; });
                    }
                    return items;
                });
            },

            createDirectory: function (parentDir, name) {
                var dir = dirFromPathInfo(parentDir);
                return cmd(cfg, 'mkdir', { path: joinPath(dir, name) }).then(function (r) {
                    if (!r.ok) { throw new Error(r.msg || 'Cannot create'); }
                    return toItem(r.item);
                });
            },

            renameItem: function (item, name) {
                var to = joinPath(parentOf(item.path), name);
                return cmd(cfg, 'rename', { from: item.path, to: to }).then(function (r) {
                    if (!r.ok) { throw new Error(r.msg || 'Cannot rename'); }
                    return toItem(r.item);
                });
            },

            deleteItem: function (item) {
                return cmd(cfg, 'delete', {
                    path: item.path,
                    recursive: item.isDirectory ? 1 : 0
                }).then(function (r) {
                    if (!r.ok) { throw new Error(r.msg || 'Cannot delete'); }
                    return r;
                });
            },

            /**
             * Upload one file.
             *
             * DevExtreme 23.x calls `uploadFileChunk(fileData, uploadInfo, dir)`,
             * NOT `uploadFile`. With `upload.chunkSize = 0` (set on the widget)
             * it is invoked once per file with the whole blob, so a single
             * multipart POST is enough.
             *
             * `uploadFile` is kept as well: older/newer bundles use it.
             */
            uploadFileChunk: function (fileData, uploadInfo, destinationDir) {
                return uploadOne(cfg, widget, fileData, destinationDir);
            },

            uploadFile: function (fileData, destinationDir) {
                return uploadOne(cfg, widget, fileData, destinationDir);
            }
        });
    }

    /* ================================================================== */
    /* Text editor panel                                                  */
    /* ================================================================== */

    var BTN = 'dx-button dx-button-mode-contained dx-button-normal dx-widget dx-button-has-text';

    function buildEditor(cfg) {
        var wrap = document.createElement('div');
        wrap.id = cfg.containerId + '_editor';
        wrap.style.cssText =
            'display:none;margin-top:14px;border:1px solid #d9d9d9;border-radius:6px;' +
            'box-shadow:0 1px 3px rgba(0,0,0,.06);overflow:hidden;background:#fff;';

        wrap.innerHTML =
            '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;' +
            'background:#f5f6f7;border-bottom:1px solid #e6e6e6;">' +
            '  <span style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.04em;">' +
                 (cfg.msgs.editing || 'Editing') + '</span>' +
            '  <b class="mw-fm-ed-path" style="flex:1;font-size:13px;font-weight:600;' +
                 'color:#333;word-break:break-all;font-family:ui-monospace,Consolas,monospace;"></b>' +
            '  <span class="mw-fm-ed-ro" style="display:none;color:#b00;font-size:12px;"></span>' +
            '  <span class="mw-fm-ed-dirty" style="display:none;color:#c47f00;font-size:12px;"></span>' +
            '  <button type="button" class="' + BTN + ' mw-fm-ed-close" ' +
                 'style="padding:5px 14px;border:1px solid #d9d9d9;border-radius:4px;' +
                 'background:#fff;cursor:pointer;font-size:13px;">' +
                 (cfg.msgs.cancel || 'Close') + '</button>' +
            '  <button type="button" class="' + BTN + ' mw-fm-ed-save" ' +
                 'style="display:none;padding:5px 16px;border:1px solid #337ab7;border-radius:4px;' +
                 'background:#337ab7;color:#fff;cursor:pointer;font-size:13px;">' +
                 (cfg.msgs.save || 'Save') + '</button>' +
            '</div>' +
            '<textarea class="mw-fm-ed-text" spellcheck="false" ' +
                'style="display:block;width:100%;height:300px;border:0;outline:none;padding:14px;' +
                'box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;font-size:13px;' +
                'line-height:1.5;resize:vertical;background:#fff;color:#2b2b2b;"></textarea>' +
            '<div class="mw-fm-ed-foot" style="padding:6px 12px;background:#fafafa;' +
                'border-top:1px solid #eee;font-size:11px;color:#999;' +
                'font-family:ui-monospace,Consolas,monospace;"></div>';

        return wrap;
    }

    /* ================================================================== */
    /* Main widget                                                        */
    /* ================================================================== */

    function MwStaticFilesFm(cfg) {
        this.cfg = cfg || {};
        this.cfg.msgs = this.cfg.msgs || {};
        this.el = document.getElementById(this.cfg.containerId);
        this.byPath = {};
        if (!this.el) { return; }

        injectStyles();

        if (!window.DevExpress || !DevExpress.ui || !DevExpress.ui.dxFileManager) {
            this.el.innerHTML = '<p style="padding:16px;color:#b00;">DevExtreme FileManager not loaded.</p>';
            return;
        }
        if (!providerCtor()) {
            this.el.innerHTML = '<p style="padding:16px;color:#b00;">DevExtreme file management API not available.</p>';
            return;
        }

        this.initEditor();
        this.initManager();
    }

    MwStaticFilesFm.prototype.initEditor = function () {
        var self = this;
        var ed = buildEditor(this.cfg);
        this.el.parentNode.insertBefore(ed, this.el.nextSibling);
        this.editor = ed;
        this.edText = ed.querySelector('.mw-fm-ed-text');
        this.edPath = ed.querySelector('.mw-fm-ed-path');
        this.edSave = ed.querySelector('.mw-fm-ed-save');
        this.edRo   = ed.querySelector('.mw-fm-ed-ro');
        this.edDirty = ed.querySelector('.mw-fm-ed-dirty');
        this.edFoot = ed.querySelector('.mw-fm-ed-foot');
        this.edOriginal = '';

        var close = function () {
            if (self.edDirty && self.edDirty.style.display !== 'none') {
                if (!window.confirm('Discard unsaved changes?')) { return; }
            }
            ed.style.display = 'none';
            self.currentEdit = null;
            self.updateFoot();
            self.updateEditButton();
        };
        ed.querySelector('.mw-fm-ed-close').addEventListener('click', close);

        // Marca el archivo como modificado y refresca el pie.
        this.edText.addEventListener('input', function () {
            var dirty = self.edText.value !== self.edOriginal;
            self.edDirty.textContent = dirty ? '● ' + (self.cfg.msgs.unsaved || 'unsaved') : '';
            self.edDirty.style.display = dirty ? '' : 'none';
            self.updateFoot();
        });

        this.edSave.addEventListener('click', function () {
            if (!self.currentEdit) { return; }
            self.edSave.disabled = true;
            self.edSave.style.opacity = '.6';
            cmd(self.cfg, 'write', { path: self.currentEdit, content: self.edText.value })
                .then(function (r) {
                    self.edSave.disabled = false;
                    self.edSave.style.opacity = '1';
                    if (!r.ok) { notify(r.msg || 'Error', 'error'); return; }
                    self.edOriginal = self.edText.value;
                    self.edDirty.textContent = '';
                    self.edDirty.style.display = 'none';
                    notify(r.msg || 'Saved', 'success');
                    self.refresh();
                })
                .catch(function () {
                    self.edSave.disabled = false;
                    self.edSave.style.opacity = '1';
                    notify('Network error', 'error');
                });
        });
    };

    /** Footer: size / lines / cursor position. */
    MwStaticFilesFm.prototype.updateFoot = function () {
        if (!this.edFoot || !this.edText) { return; }
        var v = this.edText.value;
        var lines = v === '' ? 0 : v.split('\n').length;
        var bytes = new Blob([v]).size;
        this.edFoot.textContent = bytes + ' bytes · ' + lines + ' lines';
    };

    /**
     * Open the text editor for one file.
     *
     * TWO INDEPENDENT ANSWERS, and they used to be one: `readable` decides
     * whether the content is fetched at all, `editable` decides whether it can be
     * saved. A frozen area is readable and not editable, and before this split
     * its files opened as an empty box — the panel looked broken rather than
     * read-only.
     *
     * @param {string}  path
     * @param {boolean} editable  false = open for reading only
     * @param {boolean} readable  false = do not even fetch (binary/blocked)
     */
    MwStaticFilesFm.prototype.openEditor = function (path, editable, readable) {
        var self = this;
        if (readable === undefined) { readable = true; }
        this.currentEdit = path;
        this.edPath.textContent = path;
        this.edText.value = '';
        this.edOriginal = '';
        this.edDirty.textContent = '';
        this.edDirty.style.display = 'none';
        this.editor.style.display = '';
        this.edSave.style.display = editable ? '' : 'none';
        this.edRo.style.display = editable ? 'none' : '';
        this.edRo.textContent = editable ? '' : (this.cfg.msgs.readonly || 'Read-only');
        this.edText.readOnly = !editable;
        this.edText.style.background = editable ? '#fff' : '#f7f7f7';
        this.updateFoot();

        // Llevar el editor a la vista sin saltar al tope de la página.
        if (this.editor.scrollIntoView) {
            this.editor.scrollIntoView({ block: 'nearest' });
        }

        if (!readable) {
            this.edText.value = '/* ' + (this.cfg.msgs.not_text || 'This file cannot be shown as text.') + ' */';
            return;
        }
        cmd(this.cfg, 'read', { path: path }).then(function (r) {
            self.edText.value = r.ok ? r.content : '/* ' + (r.msg || 'cannot read') + ' */';
            self.edOriginal = self.edText.value;
            self.updateFoot();
        });
    };

    /**
     * May this widget change anything?
     *
     * TWO FLAGS, AND BOTH HAVE TO AGREE: `allowWrite` is what the account is
     * allowed to do in this area, `readOnly` is whether the area is frozen for
     * everybody. Answered in one place because the toolbar, the bar and the
     * upload button all ask it, and three copies of `a && !b` is how one of them
     * ends up as `a`.
     *
     * @return {boolean}
     */
    MwStaticFilesFm.prototype.canWrite = function () {
        return !!this.cfg.allowWrite && !this.cfg.readOnly;
    };

    MwStaticFilesFm.prototype.initManager = function () {
        var self = this;
        var cfg = this.cfg;
        var root = this.el;
        root.innerHTML = '';

        // Barra propia fuera del contenedor del widget: el toolbar del
        // FileManager se reemplaza al seleccionar, y además DevExtreme
        // reescribe el contenido de su contenedor.
        var bar = document.createElement('div');
        bar.style.cssText =
            'display:flex;align-items:center;gap:10px;margin:0 0 10px;padding:8px 12px;' +
            'background:#f5f6f7;border:1px solid #e6e6e6;border-radius:6px;';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BTN;
        btn.textContent = cfg.msgs.edit || 'Edit';
        btn.style.cssText =
            'padding:5px 16px;border:1px solid #d9d9d9;border-radius:4px;background:#fff;' +
            'cursor:pointer;font-size:13px;';
        btn.addEventListener('click', function () { self.editSelected(); });
        bar.appendChild(btn);

        // "New folder" y "Upload" viven aquí y no en el toolbar de DevExtreme:
        // en el bundle 23.1 los items `createDirectory` y `upload` se generan
        // sin icono y sin onClick (el botón existe, es invisible y no hace
        // nada). Desde nuestra barra funcionan siempre.
        this.mkdirBtn = null;
        if (self.canWrite() && cfg.allowMkdir) {
            var mk = document.createElement('button');
            mk.type = 'button';
            mk.className = BTN;
            mk.textContent = cfg.msgs.create || 'New folder';
            mk.style.cssText =
                'padding:5px 16px;border:1px solid #d9d9d9;border-radius:4px;background:#fff;' +
                'cursor:pointer;font-size:13px;';
            mk.addEventListener('click', function () { self.promptNewFolder(); });
            bar.appendChild(mk);
            this.mkdirBtn = mk;
        }

        // Input oculto del alta de carpeta: aparece en la misma barra.
        this.mkdirWrap = document.createElement('span');
        this.mkdirWrap.style.cssText = 'display:none;align-items:center;gap:6px;';
        this.mkdirInput = document.createElement('input');
        this.mkdirInput.type = 'text';
        this.mkdirInput.placeholder = cfg.msgs.folder_name || 'Folder name';
        this.mkdirInput.style.cssText =
            'padding:5px 8px;border:1px solid #c9c9c9;border-radius:4px;font-size:13px;' +
            'font-family:ui-monospace,Consolas,monospace;width:200px;';
        this.mkdirInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { self.createFolder(this.value); }
            if (e.key === 'Escape') { self.hideNewFolder(); }
        });
        var ok = document.createElement('button');
        ok.type = 'button';
        ok.className = BTN;
        ok.textContent = cfg.msgs.create_ok || 'Create';
        ok.style.cssText =
            'padding:5px 12px;border:1px solid #337ab7;border-radius:4px;background:#337ab7;' +
            'color:#fff;cursor:pointer;font-size:13px;';
        ok.addEventListener('click', function () { self.createFolder(self.mkdirInput.value); });
        this.mkdirWrap.appendChild(this.mkdirInput);
        this.mkdirWrap.appendChild(ok);
        bar.appendChild(this.mkdirWrap);

        // Upload: input de archivos propio, invisible.
        this.uploadBtn = null;
        if (self.canWrite()) {
            var up = document.createElement('button');
            up.type = 'button';
            up.className = BTN;
            up.textContent = cfg.msgs.upload || 'Upload files';
            up.style.cssText =
                'padding:5px 16px;border:1px solid #d9d9d9;border-radius:4px;background:#fff;' +
                'cursor:pointer;font-size:13px;';
            up.addEventListener('click', function () { self.fileInput.click(); });
            bar.appendChild(up);
            this.uploadBtn = up;

            // Destino visible: la grilla puede estar mostrando una carpeta y el
            // "current directory" del widget ser otra.
            this.dirLabel = document.createElement('span');
            this.dirLabel.style.cssText =
                'font-size:12px;color:#666;font-family:ui-monospace,Consolas,monospace;' +
                'white-space:nowrap;';
            bar.appendChild(this.dirLabel);

            this.fileInput = document.createElement('input');
            this.fileInput.type = 'file';
            this.fileInput.multiple = true;
            this.fileInput.style.display = 'none';
            this.fileInput.addEventListener('change', function () {
                self.uploadFiles(this.files);
            });
            bar.appendChild(this.fileInput);
        }

        this.selLabel = document.createElement('span');
        this.selLabel.style.cssText =
            'font-size:12px;color:#666;font-family:ui-monospace,Consolas,monospace;' +
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            'margin-left:auto;';
        this.selLabel.textContent = '';
        bar.appendChild(this.selLabel);

        root.appendChild(bar);

        // Contenedor propio para el widget.
        var fmBox = document.createElement('div');
        fmBox.style.cssText =
            'height:calc(100% - 54px);min-height:280px;width:100%;max-width:100%;overflow:hidden;';
        root.appendChild(fmBox);

        // Doble clic para abrir.
        //
        // En esta versión DevExtreme NO dispara `onItemDblClick` desde la grilla
        // (el handler existe pero nunca se llama). El resultado es que un doble
        // clic sólo selecciona: la carpeta no se abre y el usuario cree estar
        // dentro de ella cuando en realidad sigue en la anterior. Se resuelve
        // con un listener propio sobre la grilla.
        fmBox.addEventListener('dblclick', function (ev) {
            var tr = ev.target && ev.target.closest ? ev.target.closest('.dx-data-row') : null;
            if (!tr) { return; }
            var cell = tr.querySelector('td[aria-colindex="3"]') || tr.children[2];
            if (!cell) { return; }
            var name = (cell.innerText || '').trim();
            if (!name) { return; }

            var cur = self.currentDir();
            if (name === '..') {
                self.navigateTo(parentOf(cur));
                return;
            }
            var path = joinPath(cur, name);
            var it = self.byPath[path] || null;
            if (it && it.isDirectory) {
                self.navigateTo(path);
                return;
            }
            // Archivo: abrirlo en el editor (la fila ya está cargada).
            if (it) {
                self.selectedItem = it;
                self.updateEditButton();
                self.openEditor(path, !!it.editable, !!it.readable);
            }
        });

        this.editBtn = btn;
        this.updateEditButton();

        var fm = new DevExpress.ui.dxFileManager(fmBox, {
            fileSystemProvider: buildProvider(cfg, this),
            itemView: { mode: 'details' },
            // Sin chunking: el provider recibe el archivo completo en una sola
            // llamada a uploadFileChunk y hace un único POST multipart.
            upload: { chunkSize: 0 },
            permissions: {
                create:  self.canWrite() && !!cfg.allowMkdir,
                upload:  self.canWrite(),
                move:    self.canWrite() && !!cfg.allowRename,
                copy:    false,
                rename:  self.canWrite() && !!cfg.allowRename,
                delete:  self.canWrite() && !!cfg.allowDelete,
                download: true
            },
            toolbar: {
                // createDirectory y upload quedan fuera: en este bundle se
                // generan sin icono y sin onClick. Los aporta nuestra barra.
                items: [
                    'rename',
                    'delete',
                    'separator',
                    'refresh'
                ]
            },
            onSelectionChanged: function (e) {
                var list = e.selectedItems || [];
                self.selectedItem = list.length ? list[0] : null;
                self.updateEditButton();
            },
            onSelectedItemChanged: function (e) {
                self.selectedItem = e.item || null;
                self.updateEditButton();
                self.updateDirLabel();
            },
            // DevExtreme no abre las carpetas con doble clic en esta versión:
            // sólo las selecciona. Se implementa acá para que el árbol y la
            // grilla se comporten como el Explorador de Windows.
            onItemDblClick: function (e) {
                var it = e.itemData || e.item || null;
                if (!it) { return; }
                if (it.isDirectory) {
                    self.navigateTo(it.path);
                    return;
                }
                var row = self.rowData(it);
                self.selectedItem = it;
                self.updateEditButton();
                self.openEditor(it.path, !!(row && row.editable));
            },
            onCurrentDirectoryChanged: function () {
                self.updateDirLabel();
            },
            onErrorOccurred: function (e) {
                var msg = (e.error && (e.error.message || e.error.errorText)) || 'Error';
                notify(msg, 'error');
                e.handled = true;
            }
        });

        this.fm = fm;
        this.updateDirLabel();
    };

    /** Row data from our index (DevExtreme drops unknown fields). */
    MwStaticFilesFm.prototype.rowData = function (it) {
        if (!it) { return null; }
        return this.byPath[it.path] || it;
    };

    /**
     * Is this path part of the application rather than of the site?
     *
     * The server answers the same question (`get_protected_paths()`), and the
     * flag travels with every item as `protected`. It is asked here as well
     * because a folder can be ENTERED — that is the point, it is listed and
     * browsable — and once inside it the bar's own buttons (New folder, Upload)
     * would otherwise look available and be refused afterwards. The ancestor
     * walk matters for the same reason: everything under the folder is protected
     * too, and the server says so per item, but the bar asks about the DIRECTORY.
     *
     * @param  {string} path
     * @return {boolean}
     */
    MwStaticFilesFm.prototype.isProtectedPath = function (path) {
        var p = (path || '').replace(/^\/+|\/+$/g, '');
        while (p) {
            var it = this.byPath[p];
            if (it && it.protected) { return true; }
            var cut = p.lastIndexOf('/');
            p = cut === -1 ? '' : p.substring(0, cut);
        }
        return false;
    };

    /** Show which file the Edit button will open. */
    MwStaticFilesFm.prototype.updateEditButton = function () {
        if (!this.editBtn || !this.selLabel) { return; }
        var it = this.selectedItem;
        var row = this.rowData(it);
        if (it && it.isDirectory) {
            // A folder can be selected but not edited; when it is application
            // code the label says so, because otherwise the greyed-out Edit
            // button reads as a defect.
            this.editBtn.disabled = true;
            this.editBtn.style.opacity = '.5';
            this.selLabel.textContent = this.isProtectedPath(it.path)
                ? it.path + '  (' + (this.cfg.msgs.app_folder || 'application folder, read-only') + ')'
                : '';
            return;
        }
        if (it) {
            // Enabled for READING, not for writing: a frozen area still has to be
            // consultable, and the editor itself says "read-only". Only a file
            // that cannot be shown as text (a JPEG) is out.
            var readable = !!(row && row.readable);
            this.editBtn.disabled = !readable;
            this.editBtn.style.opacity = readable ? '1' : '.5';
            var tag = '';
            if (row && !row.editable) {
                tag = '  (' + (this.cfg.msgs.readonly || 'Read-only') + ')';
            }
            this.selLabel.textContent = it.path + tag;
            return;
        }
        this.editBtn.disabled = true;
        this.editBtn.style.opacity = '.5';
        this.selLabel.textContent = '';
    };

    /** Open the selected file in the text editor. */
    MwStaticFilesFm.prototype.editSelected = function () {
        var it = this.selectedItem;
        if (!it) { notify('Select a file first', 'warning'); return; }
        if (it.isDirectory) { notify('Folders cannot be edited', 'warning'); return; }
        var row = this.rowData(it);
        if (row && !row.readable) {
            notify(this.cfg.msgs.not_text || 'This file cannot be shown as text.', 'warning');
            return;
        }
        this.openEditor(it.path, !!(row && row.editable), true);
    };

    MwStaticFilesFm.prototype.refresh = function () {
        if (this.fm) { this.fm.refresh(); }
    };

    /** Current directory, taken from the widget (never from our own state). */
    MwStaticFilesFm.prototype.currentDir = function () {
        try {
            var d = this.fm.getCurrentDirectory();
            if (d && typeof d.path === 'string') {
                return d.path.replace(/^\/+|\/+$/g, '');
            }
        } catch (e) { /* older bundle: fall through */ }
        try { return (this.fm.option('currentPath') || '').toString().replace(/^\/+|\/+$/g, ''); }
        catch (e) { return ''; }
    };

    /** Navigate to a folder (used by double-click). */
    MwStaticFilesFm.prototype.navigateTo = function (path) {
        try {
            this.fm.option('currentPath', (path || '').replace(/^\/+|\/+$/g, ''));
        } catch (e) {
            notify('Cannot open the folder', 'error');
        }
        this.updateDirLabel();
    };

    /**
     * Show where an upload is going.
     *
     * DevExtreme keeps the "current directory" separate from the selection, so
     * it is perfectly possible to look at one folder and upload into another.
     * Printing the target next to the button removes the guesswork.
     */
    MwStaticFilesFm.prototype.updateDirLabel = function () {
        if (!this.dirLabel) { return; }
        var dir = this.currentDir();
        var into = this.cfg.msgs.into || 'into';
        if (this.isProtectedPath(dir)) {
            // New folder and Upload are refused here by the server, so the bar
            // says it before the attempt instead of after the refusal.
            this.dirLabel.textContent = into + ' /' + dir + '/  '
                + '(' + (this.cfg.msgs.app_folder || 'application folder, read-only') + ')';
            this.dirLabel.title = this.cfg.msgs.app_folder_hint
                || 'This folder belongs to the application: it can be browsed but not changed.';
            return;
        }
        this.dirLabel.textContent = into + ' /' + (dir ? dir + '/' : '');
        this.dirLabel.title = dir
            ? (this.cfg.msgs.into_hint || 'Files are saved into this folder')
            : (this.cfg.msgs.into_root || 'The area root only accepts the files pinned as editable');
    };

    /* ---- new folder ------------------------------------------------- */

    MwStaticFilesFm.prototype.promptNewFolder = function () {
        if (!this.mkdirWrap) { return; }
        this.mkdirInput.value = '';
        this.mkdirWrap.style.display = 'inline-flex';
        this.mkdirInput.focus();
    };

    MwStaticFilesFm.prototype.hideNewFolder = function () {
        if (!this.mkdirWrap) { return; }
        this.mkdirWrap.style.display = 'none';
    };

    MwStaticFilesFm.prototype.createFolder = function (name) {
        var self = this;
        var cfg = this.cfg;
        name = (name || '').trim();
        if (!name) {
            notify(cfg.msgs.folder_name || 'Enter a folder name', 'warning');
            return;
        }
        // El servidor valida igual, pero un "/" aquí partiría la ruta.
        if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) {
            notify(cfg.msgs.folder_invalid || 'A folder name cannot contain slashes', 'warning');
            return;
        }
        var target = joinPath(this.currentDir(), name);
        cmd(cfg, 'mkdir', { path: target }).then(function (r) {
            if (!r.ok) {
                notify(r.msg || 'Cannot create the folder', 'error');
                return;
            }
            self.hideNewFolder();
            notify((cfg.msgs.created || 'Folder created') + ': ' + target, 'success');
            self.refresh();
        })['catch'](function (e) {
            notify(e.message || 'Cannot create the folder', 'error');
        });
    };

    /* ---- upload ----------------------------------------------------- */

    MwStaticFilesFm.prototype.uploadFiles = function (fileList) {
        var self = this;
        var cfg = this.cfg;
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) { return; }
        var dir = this.currentDir();
        var i = 0;
        var failed = 0;

        function next() {
            if (i >= files.length) {
                if (self.fileInput) { self.fileInput.value = ''; }
                self.refresh();
                return;
            }
            var f = files[i++];
            uploadOne(cfg, self, f, dir)['catch'](function (e) {
                failed++;
                notify(f.name + ': ' + (e.message || 'upload failed'), 'error');
            }).then(next);
        }
        next();
    };

    window.mw_staticfiles_fm = MwStaticFilesFm;
}());
