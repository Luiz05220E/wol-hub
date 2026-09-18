// TESTE ISOLADO Nº2 — só pra diagnosticar. Igual ao test-cloudflare.js
// anterior, mudando SÓ uma coisa: agora tem uma partition custom, igual
// as contas reais do app usam. O resto (sandbox, preload, posição da
// janela) continua tudo no padrão, igual ao teste que passou.
//
// Como rodar (igual da vez passada):
//   npx electron test-cloudflare-2.js
//
// O que isso prova:
//   - Se AGORA falhar (não passou no teste anterior sem partition, e
//     falha aqui com partition) -> confirma que o problema é a
//     partition isolada em si.
//   - Se passar normal, do mesmo jeito que o teste 1 -> partition não
//     é o problema, descarta esse suspeito e parte pro próximo (o
//     truque de anexar fora da tela).

const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'TESTE 2 — com partition (igual conta real)',
        webPreferences: {
            partition: 'persist:test-cloudflare-2', // <-- ÚNICA diferença do teste 1
        },
    });

    win.webContents.openDevTools({ mode: 'right' });
    win.loadURL(TEST_URL);

    win.webContents.on('did-finish-load', () => {
        console.log('>>> Carregou. Testa criar conta / ver se aparece o Cloudflare e se passa.');
    });
});

app.on('window-all-closed', () => app.quit());
