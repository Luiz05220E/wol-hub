// Preload minúsculo, só pra essa conta (WebContentsView do jogo) poder
// avisar o processo principal de um evento pontual.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wolhubBridge', {
    keepAliveBriefly: () => ipcRenderer.send('account:keep-alive-briefly'),
    setHibernateCycle: (enabled, minutes, graceSeconds) =>
        ipcRenderer.send('account:set-hibernate-cycle', { enabled, minutes, graceSeconds }),
    wakeNow: () => ipcRenderer.send('account:hibernate-wake-now'),
    disableHibernateCycle: () => ipcRenderer.send('account:hibernate-disable-cycle'),
    hibernatePauseForAlarm: () => ipcRenderer.send('account:hibernate-pause-for-alarm'),
    hibernatePauseForCloudflare: () => ipcRenderer.send('account:hibernate-pause-for-cloudflare'),
    notifyCloudflareBlocked: () => ipcRenderer.send('account:notify-cloudflare'),
    onCloudflareAcknowledgedFromNotification: (callback) => ipcRenderer.on('wolhub:cloudflare-alarm-acknowledged', () => callback()),
    hibernateInactivityTrigger: () => ipcRenderer.send('account:hibernate-inactivity-trigger'),
    reportSessionSnapshot: (snapshot) => ipcRenderer.send('account:report-session-snapshot', snapshot),
    getSessionSnapshot: () => ipcRenderer.invoke('account:get-session-snapshot'),
    notifyWentToCity: () => ipcRenderer.send('account:notify-went-to-city'),
    hibernateConfirmedForCurtain: () => ipcRenderer.send('account:hibernate-confirmed-for-curtain'),
    onAlarmAcknowledgedFromNotification: (callback) => ipcRenderer.on('wolhub:alarm-acknowledged', () => callback()),
    confirmedInGame: (success) => ipcRenderer.send('account:hibernate-confirmed-in-game', success),
    notifyDisconnected: () => ipcRenderer.send('account:notify-disconnected'),
});
