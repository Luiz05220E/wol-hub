// TESTE ISOLADO Nº9 — os testes 7 e 8 provaram: não basta a janela
// "existir" (show:true) — se ela fica FORA da área visível da tela
// (coordenadas negativas), o Cloudflare trata como escondida do mesmo
// jeito que show:false. Falhou nos dois casos.
//
// Última hipótese que sobra, e é a mais parecida com o que o Chrome faz
// de verdade: uma aba em segundo plano no Chrome nunca sai da área da
// tela — ela só fica TAPADA por cima pela aba ativa, na MESMA posição.
// Esse teste replica isso: duas janelas de topo, as DUAS na mesma área
// visível da tela (nunca fora dela), uma em cima cobrindo a outra
// completamente. Depois de um tempo, fecha/move a de cima (revelando a
// de baixo), sem nunca ter movido a de baixo pra fora da tela.
//
// Como rodar:
//   npx electron test-cloudflare-9.js
//
// O que isso prova:
//   - Se passar -> a solução é: todas as contas ficam janelas de topo
//     sempre dentro da área visível da tela (nunca fora dela), sobrepostas
//     por z-order — só a ativa fica "revelada" (as outras destacadas por
//     baixo, tapadas por ela). Dá pra reescrever o app assim.
//   - Se falhar -> nem estar na área visível (mas tapada) basta; sobra só
//     a opção mais cara: cada conta como janela de verdade do Windows
//     separada e sempre visível (várias janelas reais na tela, tipo
//     várias instâncias do navegador lado a lado) — sem conseguir
//     "esconder" nenhuma delas de verdade.

const path = require('path');
const { app, BrowserWindow } = require('electron');

const TEST_URL = 'https://huntera.com.br/';

app.whenReady().then(() => {
    // Janela "de baixo" — é a que vamos testar o Cloudflare. Fica na
    // área visível da tela DESDE O INÍCIO, só tapada pela de cima.
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        x: 100,
        y: 100,
        title: 'TESTE 9 — janela de BAIXO (a que importa)',
        show: true,
        backgroundColor: '#0f0f14',
        webPreferences: {
            partition: 'persist:test-cloudflare-9',
            contextIsolation: true,
            sandbox: true,
            spellcheck: false,
            preload: path.join(__dirname, 'account-preload.js'),
        },
    });

    const cleanUA = win.webContents.getUserAgent()
        .replace(/\s*idle-huntera-manager\/\S+/i, '')
        .replace(/\s*Electron\/\S+/i, '');
    win.webContents.setUserAgent(cleanUA);
    win.webContents.loadURL(TEST_URL);

    // Janela "de cima" — só existe pra tapar a de baixo completamente,
    // igual a aba ativa tapa as outras no Chrome.
    const cover = new BrowserWindow({
        width: 1200,
        height: 800,
        x: 100,
        y: 100,
        title: 'TAMPA (fecha/move sozinha em 5s)',
        show: true,
        backgroundColor: '#000000',
    });
    cover.loadURL('data:text/html,<body style="background:#000;color:#fff;font-family:sans-serif;padding:20px">Isso aqui está tapando a janela de baixo de propósito. Some em 5s.</body>');
    cover.moveTop();

    win.webContents.once('did-finish-load', () => {
        console.log('>>> Janela de baixo carregou TAPADA (mas dentro da área visível da tela). Esperando 5s antes de revelar...');
        setTimeout(() => {
            console.log('>>> Tirando a tampa agora (fechando ela, sem nunca mover a de baixo). Testa criar conta / ver se o Cloudflare passa.');
            cover.close();
            win.moveTop();
            win.focus();
            win.webContents.openDevTools({ mode: 'right' });
        }, 5000);
    });
});

app.on('window-all-closed', () => app.quit());
