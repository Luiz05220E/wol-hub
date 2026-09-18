# Idle Huntera Manager (v0.5 — multi-jogo)

App desktop (Electron) pra rodar contas de **vários jogos diferentes**
(Huntera, Baiak Idle, etc) numa janela só, organizadas por jogo na barra
lateral — inspirado no Idle Labs.

## O que tem na v0.5

- **Jogos como grupos**: cada jogo (Huntera, Baiak, o que quiser) vira uma
  seção na barra lateral, com suas contas dentro
- **MS (ping)**: cada conta mostra a latência até o servidor do jogo dela,
  atualizado a cada 8s
- **Bolinha de status colorida**: verde (ping baixo, <100ms), amarelo
  (médio, 100-300ms), vermelho (alto ou offline), cinza (ainda sem medição)
- **RAM por conta + total**: atualizado a cada 4s
- Só a conta que você está olhando fica de fato renderizando — as outras
  ficam rodando em segundo plano com throttling nativo do navegador
  (economia de RAM/CPU real, sem gambiarra)
- User-Agent limpo (sem "Electron" na identificação) e Electron atualizado
  pra versão recente — corrige bugs de UI que apareciam em alguns jogos

## Como rodar

Pré-requisito: [Node.js](https://nodejs.org) instalado (versão 18+).

1. Extrai a pasta em qualquer lugar do PC
2. Terminal dentro da pasta (`cmd` na barra de endereço do Explorador)
3. `npm install` (demora mais na primeira vez — Electron é uma versão bem
   mais nova agora)
4. `npm start`

## Como usar

1. **Clica em "+ Novo jogo"** — dá o nome (ex: "Huntera") e a URL dele
2. Dentro do grupo do jogo, **clica no `+`** pra adicionar uma conta
3. **Clica numa conta** pra trocar de foco pra ela
4. O **×** no cabeçalho do jogo remove ele e todas as contas dentro
5. O script "Modo Economia/LoWBOT" só é injetado automaticamente em
   contas do Huntera — outros jogos não recebem esse script (não tem
   como funcionar num jogo diferente)

Tudo fica salvo entre sessões — não precisa readicionar toda vez.

## Como gerar o instalador .exe (opcional)

```
npm run build
```
O `.exe` aparece na pasta `dist/`.

## Sobre o ping/MS

A medição não é o ping "de dentro do jogo" (aquele que às vezes o próprio
jogo mostra na tela) — é uma medição HTTP simples até o servidor do site.
Dá uma ideia real e comparável da latência, mas pode não bater 100% com o
número que o jogo mostra internamente (que pode usar outro protocolo, tipo
WebSocket).

## Limitações conhecidas

- Sem drag-and-drop pra reordenar jogos/contas ainda
- O popover de adicionar jogo/conta esconde a conta ativa temporariamente
  enquanto está aberto (é assim de propósito — evita o popover ficar
  escondido atrás da view do jogo)
