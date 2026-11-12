# CRM Niterói — formulário atualizado

## Campos do formulário público

### Identificação do solicitante
- Nome completo (obrigatório)
- Telefone/WhatsApp (obrigatório)
- E-mail
- Endereço
- Nº (número do endereço do solicitante)
- Bairro (bairro do solicitante)
- CEP
- Instituição ou Organização Social

### Detalhes da demanda
- Assunto da solicitação (obrigatório)
- Local da ocorrência
- Número (número do local da ocorrência)
- Bairro (bairro da ocorrência)
- Descreva sua solicitação (obrigatório)

### Detalhamento COLAB
- Chamado COLAB Nº
- Chamado eCiga
- Órgão ou Departamento Solicitante

Os campos opcionais foram mantidos opcionais. O envio exige nome, telefone, assunto, descrição e aceite do aviso de privacidade.

## Executar localmente no Windows

1. Instale Node.js 18 ou superior.
2. Extraia o ZIP.
3. Abra PowerShell na pasta `crm-niteroi-web-v2`.
4. Execute:

```powershell
$env:ADMIN_USER='admin'
$env:ADMIN_PASSWORD='Niteroi@Trocar123'
$env:PORT='3000'
node server.js
```

5. Acesse o painel em `http://localhost:3000/`.
6. Acesse o formulário público em `http://localhost:3000/cadastro`.

Credenciais iniciais de teste: `admin` / `Niteroi@Trocar123`. Troque a senha antes de qualquer uso real ou publicação.

## Persistência

Os registros ficam em `data/crm.json`. Antes de substituir uma versão anterior do projeto, faça backup desse arquivo e copie-o para a pasta `data` da nova versão. O ZIP não deve sobrescrever o banco local existente.

## Importação e exportação

O CRM mantém importação CSV e exportação CSV compatível com Excel. Para importar planilhas, salve como CSV UTF-8. Foram adicionados mapeamentos para instituição, número do endereço, CEP, número do local da ocorrência, chamados COLAB/eCiga e órgão/departamento solicitante.

## Observações de segurança

Esta versão é destinada a testes locais. Antes de tratar dados reais, implemente autenticação robusta, gestão de perfis, proteção contra spam, HTTPS, backups, política de privacidade, controles de acesso e medidas de segurança compatíveis com a LGPD. O formulário não substitui os canais nem gera protocolo oficial da Prefeitura de Niterói.


## Gestão de usuários (versão 1.1.0)

- O primeiro início cria `data/users.json` com a conta definida por `ADMIN_USER` e `ADMIN_PASSWORD` (padrões de teste: `admin` e `Niteroi@Trocar123`).
- No primeiro acesso, a senha deve ser alterada. Senhas têm mínimo de 6 caracteres e são armazenadas com scrypt + salt individual.
- Perfis: `admin` (gestão de usuários e acesso administrativo) e `operator` (operação do CRM sem gestão de contas).
- Administradores podem criar contas, ativar/desativar usuários, alterar perfis e redefinir senhas.
- Cada usuário pode alterar sua própria senha pelo menu "Alterar minha senha".
- As contas ficam em `data/users.json`. Inclua esse arquivo nos backups operacionais e proteja-o como dado sensível.
- Para atualizar uma instalação existente, pare o CRM, faça cópia de `data/`, atualize os arquivos da aplicação sem apagar `data/crm.json` nem `data/backups/`, e inicie novamente. O arquivo `users.json` é criado automaticamente se ainda não existir.

**Importante:** esta versão ainda usa sessões em memória, que são encerradas quando o servidor reinicia. Antes de uso público com dados pessoais, recomenda-se revisão de segurança independente, HTTPS, controle de acesso à rede, proteção CSRF, logs de auditoria e backups externos protegidos.


## Alteração de clientes
Na tela Clientes, use o botão **Alterar** para editar nome, telefone/WhatsApp, e-mail, endereço, número, bairro, CEP e instituição. A alteração é salva no banco `data/crm.json`, preservando o vínculo das demandas existentes pelo ID do cliente. O telefone não pode duplicar o de outro cliente.


## Política de senha atualizada
A senha deve conter no mínimo 6 caracteres e no máximo 200. A regra é validada no servidor para criação de usuários, redefinição de senha e alteração da própria senha; os campos da interface também refletem o mínimo de 6 caracteres.


## Alteração de demandas
Na tela **Demandas**, use o botão **Alterar** para editar o cliente vinculado, assunto, descrição, local da ocorrência, número, bairro, órgão responsável, departamento solicitante, números COLAB/eCiga, protocolo, prioridade e status. O número interno e a data de abertura são preservados. As alterações são registradas no histórico de eventos.


## Armazenamento de dados em hospedagens
O diretório de dados agora pode ser configurado pela variável de ambiente `CRM_DATA_DIR`.
- Windows Server/local: se não configurar a variável, o sistema continua usando `<pasta do projeto>\\data`.
- Servidor Linux com disco/volume persistente: configure `CRM_DATA_DIR` com o caminho absoluto da pasta gravável montada, por exemplo `/var/lib/crm-niteroi/data` (o caminho precisa existir ou permitir criação e ter permissão de escrita para o usuário do processo).
- Ambientes serverless com código em `/var/task` (por exemplo, funções serverless): a pasta do projeto é somente leitura. Não use `/var/task/data`. O caminho `/tmp` pode permitir gravações temporárias, mas é efêmero e pode ser apagado entre execuções; portanto, **não é adequado para guardar definitivamente senhas, clientes, demandas ou backups**. Para produção, use um banco de dados gerenciado e armazenamento persistente compatíveis com a hospedagem, ou hospede o CRM em servidor/VM com disco persistente.
A variável `CRM_DATA_DIR` deve ser configurada no painel da hospedagem antes de reiniciar a aplicação. Mantenha `crm.json`, `users.json` e `backups/` no mesmo diretório persistente.


## Exclusão de usuários
Na Gestão de Usuários, administradores podem excluir contas. A operação solicita confirmação, invalida as sessões do usuário removido e grava a alteração no arquivo persistente de usuários. Por segurança, o administrador conectado não pode excluir a própria conta e o sistema impede a exclusão do último administrador ativo. A exclusão é permanente; para bloqueio temporário, use **Desativar**.


## Exibição de demandas
Na tabela de Gestão de Demandas, o botão **Exibir** abre uma visualização somente leitura com protocolo, data de abertura, dados do cliente, assunto, descrição, local, órgão, chamados COLAB/eCiga, prioridade e status. Para modificar o registro, utilize o botão **Alterar**.


## Redefinição pontual da senha do administrador
Para definir a senha da conta administrativa como `123456` sem apagar os demais usuários, pare o CRM e execute, na pasta `crm-niteroi-web-v2`:
`node reset-admin-password.js`
O script altera apenas a conta definida por `ADMIN_USER` (padrão: `admin`) no `users.json` do diretório `CRM_DATA_DIR` ou, se não definido, em `data`. As demais contas são preservadas. Após executar, inicie o CRM normalmente. Por segurança, `123456` é uma senha fraca: use-a apenas temporariamente e troque-a por uma senha forte assim que possível.
