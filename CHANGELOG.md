# Changelog

## [0.8.0] - 2026-11-24

Primeira versão pública.

### Adicionado
- Pílula sempre no topo com a ferramenta em uso, o tempo, o aviso de pronto e os pedidos de permissão com Permitir e Negar.
- Várias sessões ao mesmo tempo: número na pílula e uma linha por projeto quando aberta.
- Uso do plano (janela de 5 horas e semana) pela statusline do Claude Code.
- Arrastar e soltar em seis cantos ou no meio das laterais, onde a ilha fica em pé.
- Janela de configurações: o que esconde a ilha (chamadas por app, Discord, tela cheia, lista extra), não perturbe por horário, opacidade, tamanho e modo compacto.
- Logo e ícones novos.

### Segurança
- O servidor local recusa pedidos com cabeçalho `Origin` e corpo que não seja JSON, para um site no navegador não mostrar pedidos de permissão falsos na ilha.
