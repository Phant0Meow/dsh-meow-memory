[Entradas neste grupo]: {list}

A lista [Entradas neste grupo] acima é todo o escopo desta rodada: as entradas que você mesmo criou, mais as que você viu nesta janela por injeção, busca ou memory_read. O escopo termina aí — não tente recordar entradas que você "viu mas que não estão listadas".
Há aqui algo que você acha que deveria ser arrumado ou atualizado? Se sim, atualize.

## Como decidir que algo precisa de atualização — percorra a lista acima entrada por entrada e se pergunte:
1. Algo foi registrado de forma errada ou unilateral, ficou desatualizado, precisa de informação nova, o usuário mudou de ideia, houve progresso novo? -> Atualize o content prontamente; o armazenamento de memória deve corresponder ao estado mais recente do projeto.
2. Algum design ou informação foi derrubado, mudado ou provou não funcionar? -> Defina status=archived. Nunca deixe esses como active ou stale. stale significa apenas "finalizado" (um todo concluído, um topic que atingiu seu objetivo), não "inválido"; abordagens e conclusões substituídas que ficam no armazenamento só vão enganar sessões futuras.
3. Existem entradas todo concluídas? -> Defina status=stale (que significa done);
4. Existem entradas erradas, triviais demais, ou que você agora acha que não importam em nada? -> Defina status=archived;
5. Bugs foram corrigidos, ou lessons deixaram de se aplicar? -> Mude o content, ou defina status=archived;
6. Você encontrou entradas que se contradizem? -> Corrija-as de acordo com o que você sabe ser verdade. Mantenha o fato mais novo, arquive a versão mais antiga;
7. Olhando para trás agora, a importance de cada entrada está certa (confira com as regras de importance do sistema de memória)? Observação: não marque coisas como importantes de leve — entradas em andamento geralmente são 1, no máximo 2; só algo sério merece 3. Onde estiver inflada, diminua;
8. Alguma entrada está longa demais, carregando demais? -> Divida-a em várias, usando update para reescrever e remember para criar as novas.
9. As palavras-chave estão precisas? -> Se estiverem, deixe o parâmetro keywords de fora; se você achar que estão erradas, corrija-as com o parâmetro keywords do memory_update — quando o prompt do usuário acerta as palavras-chave de uma entrada, essa entrada é trazida. Então pense ao contrário: "quais palavras no prompt de um usuário deveriam fazer esta memória aparecer?" Esse é o seu critério. Não use o nome do projeto como palavra-chave; use palavras específicas da entrada. Prefira entidades centrais, o centro semântico, nomes próprios. Forma dicionarizada simples — o tokenizador faz stemming das palavras em inglês, então um singular já casa com seu plural, e stopwords não recuperam nada. De 8 a 13 delas.
10. Os rótulos de projeto estão certos? Algo está rotulado com um projeto quando na verdade é informação global? Então o rótulo de projeto deve sair. Algo claramente pertence a um projeto mas não carrega informação de projeto? Então adicione.
11. Aprendizado sem reflexão é desperdício — generalize mais:
- Este é um excelente momento para abstrair e consolidar. Há regras gerais que valha a pena destilar? Adicione-as como novas memórias.
- Você agora pode entender algumas entradas melhor e mais profundamente do que quando as escreveu. Atualize-as.
12. Olhe para o que é injetado no primeiro turno. Você ainda acha que tudo aquilo importa? Realmente precisa ser injetado no início de toda sessão? O que não precisar, você pode baixar de importance ou mover para outro level (fact, por exemplo).
O primeiro turno injeta apenas: soul (a própria IA) / user (as preferências do usuário) / regras globais (importance>=2). Para colocar algo no primeiro turno: uma regra global -> mova para rules com importance>=2 (project "global"); algo sobre o usuário -> mova para user; algo sobre você -> mova para soul.
13. memory_project mostra entradas de nível de projeto (todos concluídos, apenas os 5 mais recentes) mais regras específicas do projeto; as verificações acima também valem lá (todos concluídos vão para stale, entradas desatualizadas vão para archived, rótulos de projeto permanecem precisos).
14. [Isenção de arquivamento] entradas de projeto com subcategoria decisions, entradas de nível rules e conclusões de longa duração entre facts/lessons: **sem evidência de sucessão (não substituída, derrubada ou mesclada por uma entrada mais nova) elas NÃO são arquivadas**, mesmo se parecerem antigas — o critério para arquivar é "existe um fato sucessor?", não "o conteúdo parece velho?". Arquive como de costume apenas quando qualquer um destes se aplicar: uma entrada mais recente do mesmo tema a substituiu; o texto traz um prazo explícito ("atualmente", "até X", "por enquanto"); ou o usuário a derrubou explicitamente.

Observações:
Importante: percorra uma por uma e arquive ou conserte as memórias desatualizadas ou que te induzem ao erro — prefira arquivar.
Para uma memória que você considera muito importante, se estiver em dúvida sobre qual é a verdade, vá ler os arquivos do projeto e confira. Apenas para memórias que realmente importam.
Quando terminar, responda "este grupo está consolidado" e não chame nenhuma outra ferramenta.

Você pode chamar várias ferramentas em um turno — por favor, conclua todas as chamadas de ferramenta desta tarefa em uma única resposta.
