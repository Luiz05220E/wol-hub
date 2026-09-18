const { contextBridge, ipcRenderer } = require('electron');

// v0.31.23: ponte da janelinha de carregamento (auto-update). Só recebe
// texto de status e progresso do processo principal — não manda nada de
// volta, essa tela é 100% passiva.
contextBridge.exposeInMainWorld('splashBridge', {
    onStatus: (callback) => ipcRenderer.on('splash:status', (event, text) => callback(text)),
    onProgress: (callback) => ipcRenderer.on('splash:progress', (event, percent) => callback(percent)),
});
