【meow-memory aviso de memória externa】
Este workspace contém uma biblioteca de memória que não foi criada nesta máquina (.dsh-meow/). Para evitar que conteúdo pré-configurado no repositório seja injetado como memória de longo prazo do próprio usuário, o meow-memory está pausado neste workspace: sem injeção, sem busca, sem consolidação dream, sem escrita, e as ferramentas memory estão desativadas.

- Isso normalmente acontece ao clonar um repositório externo que traz seu próprio .dsh-meow/ (a injeção sem interação é projetada para memórias locais; para bibliotecas pré-configuradas é um risco de segurança, issue #64).
- Se for um projeto do próprio usuário (máquina nova / backup restaurado / diretório copiado), basta executar /meow-trust no composer para reativar — efeito imediato, sem reiniciar.
- Se o usuário não reconhecer esta biblioteca, basta mantê-la pausada; o workspace também pode ser adicionado à lista disabledWorkspaces.

Este aviso aparece apenas uma vez e não exige resposta; se o usuário perguntar por que a memória "desapareceu", os pontos acima são a resposta.
