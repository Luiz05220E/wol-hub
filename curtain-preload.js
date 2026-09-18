const { contextBridge, ipcRenderer } = require('electron');

// v15.55: ponte própria da "cortina" — diferente da ponte normal por
// conta (account-preload.js), que identifica a conta pelo webContents.id
// de quem chamou. A cortina é UMA VIEW SÓ, reaproveitada por cima de
// qualquer conta que estiver sendo hibernada no momento — então em vez
// de se identificar sozinha, ela só manda a ação; o processo principal
// já sabe qual conta está encobrindo agora (curtainCoveringAccountId).
contextBridge.exposeInMainWorld('wolhubCurtainBridge', {
    wakeNow: () => ipcRenderer.send('curtain:wake-now'),
    disableHibernateCycle: () => ipcRenderer.send('curtain:disable-hibernate-cycle'),
    onUpdate: (callback) => ipcRenderer.on('curtain:update', (event, data) => callback(data)),
});
